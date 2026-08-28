import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";

const packages = {
    core: "@craflet/core",
    adapters: "@craflet/adapters",
    cli: "craflet",
};
const allowed = { core: [], adapters: ["core"], cli: ["core", "adapters"] };
const runtimeExtension = /\.[cm]?[jt]sx?$/;
const excludedSource = /\.(?:test|d)\.[cm]?[jt]sx?$/;

function relative(root, file) {
    return path.relative(root, file).split(path.sep).join("/");
}

function kindOf(root, id) {
    if (!path.isAbsolute(id)) return undefined;
    const name = relative(root, id);
    return Object.keys(packages).find((kind) =>
        name.startsWith(`packages/${kind}/src/`),
    );
}

function literal(node) {
    if (node?.type === "Literal" && typeof node.value === "string")
        return node.value;
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
        return node.quasis[0]?.value.cooked;
    return undefined;
}

function walkAst(ast, visit) {
    const pending = [ast];
    while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== "object" || typeof node.type !== "string")
            continue;
        visit(node);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) pending.push(...value);
            else if (
                value &&
                typeof value === "object" &&
                typeof value.type === "string"
            )
                pending.push(value);
        }
    }
}

function memberName(node) {
    if (node?.type !== "MemberExpression") return undefined;
    return node.computed ? literal(node.property) : node.property.name;
}

function inspectSource(root, id, ast) {
    const kind = kindOf(root, id);
    if (!kind) return;
    function specifier(source) {
        const target = Object.entries(packages).find(
            ([, name]) => source === name || source.startsWith(`${name}/`),
        );
        if (target)
            assert(
                allowed[kind].includes(target[0]) && source === target[1],
                `Imports must use an allowed public entry: ${relative(root, id)} -> ${source}`,
            );
        if (source.startsWith(".")) {
            const destination = relative(
                path.join(root, "packages", kind),
                path.resolve(path.dirname(id), source),
            );
            assert(
                !destination.startsWith("../") &&
                    destination !== ".." &&
                    !path.isAbsolute(destination),
                `Cross-package source import: ${relative(root, id)} -> ${source}`,
            );
        }
        if (kind === "core")
            assert(
                !isBuiltin(source),
                `Core contains I/O: ${relative(root, id)} -> ${source}`,
            );
    }
    walkAst(ast, (node) => {
        if (
            [
                "ImportDeclaration",
                "ExportNamedDeclaration",
                "ExportAllDeclaration",
            ].includes(node.type) &&
            node.source
        )
            specifier(literal(node.source));
        if (
            node.type === "ImportExpression" ||
            (node.type === "CallExpression" &&
                node.callee.type === "Identifier" &&
                node.callee.name === "require")
        ) {
            const source = literal(
                node.type === "ImportExpression"
                    ? node.source
                    : node.arguments[0],
            );
            assert(
                source !== undefined,
                `Runtime imports must be literal and bundleable: ${relative(root, id)}`,
            );
            specifier(source);
        }
        // createRequire hides later imports from the resolver. The generated
        // bundle's own Node shim is checked separately in generateBundle.
        if (
            node.type === "ImportDeclaration" &&
            ["module", "node:module"].includes(literal(node.source))
        ) {
            assert(
                !node.specifiers.some(
                    (item) => item.imported?.name === "createRequire",
                ),
                `Opaque runtime require is not allowed in production sources: ${relative(root, id)}`,
            );
        }
        if (kind === "core") {
            const property = memberName(node);
            const hostMember =
                node.type === "MemberExpression" &&
                (["process", "console"].includes(node.object.name) ||
                    (node.object.name === "globalThis" &&
                        ["process", "console", "fetch"].includes(property)));
            const fetchCall =
                node.type === "CallExpression" && node.callee.name === "fetch";
            assert(
                !hostMember && !fetchCall,
                `Core accesses the host directly: ${relative(root, id)}`,
            );
        }
    });
}

function inspectGraph(root, context) {
    const modules = new Map(
        [...context.getModuleIds()].map((id) => [
            id,
            context.getModuleInfo(id),
        ]),
    );
    const graph = new Map();
    const externals = new Set();
    for (const [id, info] of modules) {
        assert(info, `Resolver returned an unknown module: ${id}`);
        // Rolldown ModuleInfo has no isExternal flag. At buildEnd all internal
        // modules have code; resolved external modules expose code: null.
        if (info.code === null) {
            assert(isBuiltin(id), `Unbundled runtime dependency: ${id}`);
            externals.add(id);
            continue;
        }
        const kind = kindOf(root, id);
        const dependencies = [
            ...new Set([...info.importedIds, ...info.dynamicallyImportedIds]),
        ];
        if (kind)
            graph.set(
                id,
                dependencies.filter((dependency) => kindOf(root, dependency)),
            );
        for (const dependency of dependencies) {
            const target = kindOf(root, dependency);
            if (!target) {
                if (kind === "core")
                    assert(
                        !isBuiltin(dependency),
                        `Core contains resolved I/O: ${relative(root, id)} -> ${dependency}`,
                    );
                continue;
            }
            if (!kind) {
                assert(
                    !id.includes("node_modules"),
                    `Bundled dependency imports application code: ${id} -> ${relative(root, dependency)}`,
                );
                continue;
            }
            if (kind === target) continue;
            assert(
                allowed[kind].includes(target),
                `Resolved reverse dependency: ${relative(root, id)} -> ${relative(root, dependency)}`,
            );
            assert(
                relative(
                    path.join(root, "packages", target, "src"),
                    dependency,
                ) === "index.ts",
                `Resolved private entry: ${relative(root, id)} -> ${relative(root, dependency)}`,
            );
        }
    }
    const visiting = new Set();
    const finished = new Set();
    function visit(id, chain) {
        if (finished.has(id)) return;
        assert(
            !visiting.has(id),
            `Resolved runtime import cycle: ${[...chain, id].map((item) => relative(root, item)).join(" -> ")}`,
        );
        visiting.add(id);
        for (const dependency of graph.get(id) ?? [])
            visit(dependency, [...chain, id]);
        visiting.delete(id);
        finished.add(id);
    }
    for (const id of graph.keys()) visit(id, []);
    return {
        modules: modules.size,
        projectModules: graph.size,
        runtimeEdges: [...graph.values()].reduce(
            (sum, edges) => sum + edges.length,
            0,
        ),
        externals: [...externals].sort(),
    };
}

function inspectOutput(context, bundle, standalone) {
    const outputNames = new Set(Object.keys(bundle));
    const chunks = Object.values(bundle).filter(
        (output) => output.type === "chunk",
    );
    for (const chunk of chunks) {
        function reference(source, outputId = false) {
            assert(
                typeof source === "string",
                `Unresolved dynamic import in output: ${chunk.fileName}`,
            );
            if (isBuiltin(source)) return;
            if (!standalone && outputId && outputNames.has(source)) return;
            const destination = path.posix.normalize(
                path.posix.join(path.posix.dirname(chunk.fileName), source),
            );
            assert(
                !standalone && outputNames.has(destination),
                `Unbundled output reference: ${chunk.fileName} -> ${source}`,
            );
        }
        for (const source of [...chunk.imports, ...chunk.dynamicImports])
            reference(source, true);
        const ast = context.parse(chunk.code, { lang: "js" });
        const createRequires = new Set();
        const moduleNamespaces = new Set();
        const requires = new Set(["require"]);
        const declarations = [];
        walkAst(ast, (node) => {
            if (
                node.type === "ImportDeclaration" &&
                ["module", "node:module"].includes(literal(node.source))
            ) {
                for (const item of node.specifiers) {
                    if (item.imported?.name === "createRequire")
                        createRequires.add(item.local.name);
                    if (
                        [
                            "ImportNamespaceSpecifier",
                            "ImportDefaultSpecifier",
                        ].includes(item.type)
                    )
                        moduleNamespaces.add(item.local.name);
                }
            }
            if (
                node.type === "VariableDeclarator" &&
                node.id.type === "Identifier"
            )
                declarations.push(node);
        });
        function factory(node) {
            return (
                (node?.type === "Identifier" &&
                    createRequires.has(node.name)) ||
                (node?.type === "MemberExpression" &&
                    moduleNamespaces.has(node.object.name) &&
                    memberName(node) === "createRequire")
            );
        }
        // Follow generated createRequire bindings and aliases, not a source regex.
        for (let changed = true; changed; ) {
            changed = false;
            for (const declaration of declarations) {
                if (requires.has(declaration.id.name)) continue;
                let usesCreateRequire = false;
                walkAst(declaration.init, (node) => {
                    if (node.type === "CallExpression" && factory(node.callee))
                        usesCreateRequire = true;
                });
                if (
                    usesCreateRequire ||
                    (declaration.init?.type === "Identifier" &&
                        requires.has(declaration.init.name))
                ) {
                    requires.add(declaration.id.name);
                    changed = true;
                }
            }
        }
        function requireBinding(node) {
            return (
                (node?.type === "Identifier" && requires.has(node.name)) ||
                (node?.type === "CallExpression" && factory(node.callee))
            );
        }
        walkAst(ast, (node) => {
            if (
                [
                    "ImportDeclaration",
                    "ExportNamedDeclaration",
                    "ExportAllDeclaration",
                ].includes(node.type) &&
                node.source
            )
                reference(literal(node.source));
            if (node.type === "ImportExpression")
                reference(literal(node.source));
            if (node.type !== "CallExpression") return;
            if (requireBinding(node.callee))
                reference(literal(node.arguments[0]));
            if (
                node.callee.type === "MemberExpression" &&
                requireBinding(node.callee.object) &&
                memberName(node.callee) === "resolve"
            )
                reference(literal(node.arguments[0]));
        });
    }
    return chunks.map((chunk) => chunk.fileName).sort();
}

/** Use the same resolver graph and emitted-output checks for CLI and runner builds. */
export function architecturePlugin({
    root = process.cwd(),
    standalone = false,
    onChecked,
} = {}) {
    root = path.resolve(root);
    let graph;
    return {
        name: "craflet-resolved-architecture",
        transform(code, id) {
            if (kindOf(root, id))
                inspectSource(
                    root,
                    id,
                    this.parse(code, {
                        lang: /\.[cm]?tsx?$/.test(id) ? "ts" : "js",
                    }),
                );
        },
        buildEnd(error) {
            if (!error) graph = inspectGraph(root, this);
        },
        generateBundle(_options, bundle) {
            assert(graph, "The resolved module graph was not checked.");
            const outputs = inspectOutput(this, bundle, standalone);
            onChecked?.({ ...graph, outputs });
        },
    };
}

async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(file)));
        else if (
            entry.isFile() &&
            runtimeExtension.test(entry.name) &&
            !excludedSource.test(entry.name)
        )
            files.push(file);
    }
    return files;
}

export async function checkArchitecture(root = process.cwd()) {
    root = path.resolve(root);
    const files = [];
    for (const [kind, name] of Object.entries(packages)) {
        const directory = path.join(root, "packages", kind);
        const manifest = JSON.parse(
            await readFile(path.join(directory, "package.json"), "utf8"),
        );
        assert.equal(manifest.name, name);
        for (const [dependency, version] of Object.entries({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.optionalDependencies,
        })) {
            const workspace = Object.entries(packages).find(
                ([, packageName]) => packageName === dependency,
            );
            if (workspace) {
                assert(
                    allowed[kind].includes(workspace[0]),
                    `${name} cannot depend on ${dependency}`,
                );
                assert.equal(version, "workspace:*");
            } else {
                assert(
                    !dependency.startsWith("@craflet/"),
                    `Unknown private package: ${dependency}`,
                );
                assert(
                    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
                    `Dependency must be exact: ${name} -> ${dependency}`,
                );
            }
        }
        files.push(...(await walk(path.join(directory, "src"))));
    }
    let report;
    const bundles = await build({
        cwd: root,
        config: false,
        entry: Object.fromEntries(
            files.map((file) => [
                relative(root, file).replace(runtimeExtension, ""),
                file,
            ]),
        ),
        outDir: path.join(root, ".architecture-output"),
        format: "esm",
        platform: "node",
        target: "node24",
        deps: { alwaysBundle: [/.*/], onlyBundle: false, onlyImport: [] },
        plugins: [
            architecturePlugin({
                root,
                onChecked: (result) => {
                    report = result;
                },
            }),
        ],
        write: false,
        clean: false,
        dts: false,
        exports: false,
        copy: false,
        exe: false,
        report: false,
        logLevel: "silent",
    });
    for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
    assert(
        report && report.projectModules >= files.length,
        "Not all production modules were resolved.",
    );
    return report;
}

if (
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
    const report = await checkArchitecture();
    console.log(
        `Architecture checked: ${report.projectModules} production modules, ${report.runtimeEdges} resolved runtime edges, ${report.modules} total modules; exact dependencies, public boundaries, cycles and emitted imports verified without writing bundles.`,
    );
}
