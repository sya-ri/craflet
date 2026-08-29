import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
    CrafletError,
    type LockFile,
    newProject,
    type ProjectManifest,
    parseSource,
    type SourceInput,
    stableStringify,
    validateLock,
    validateProject,
    validationError,
    WorkspaceSchema,
} from "@craflet/core";
import { type } from "arktype";
import picomatch from "picomatch";
import { Document, parseDocument } from "yaml";
import {
    ensureUserEulaConsent,
    type RequestEulaConsent,
} from "./eula-consent.js";
import { proposedEulaDocument } from "./eula-file.js";
import { assertNoSymlinks, atomicWrite, exists } from "./io.js";

export interface ProjectContext {
    dir: string;
    manifest: ProjectManifest;
    lockRoot: string;
    lockKey: string;
    home: string;
    /** Exact declaration text parsed when this context was loaded. */
    manifestText?: string;
}

export async function readYaml(file: string): Promise<unknown> {
    const text = await readYamlText(file);
    return parseYamlContent(text, file);
}

function parseYamlContent(text: string, file: string): unknown {
    const document = parseDocument(text, {
        uniqueKeys: true,
        prettyErrors: false,
    });
    if (document.errors.length)
        throw new CrafletError(
            "YAML_SYNTAX",
            `${path.basename(file)}: invalid YAML (input values omitted).`,
            2,
        );
    try {
        return document.toJS({ maxAliasCount: 50 });
    } catch {
        throw new CrafletError(
            "YAML_ALIASES",
            `${path.basename(file)}: excessive YAML alias expansion.`,
            2,
        );
    }
}

async function readYamlText(file: string): Promise<string> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    if ((await stat(file)).size > 2 * 1024 * 1024)
        throw new CrafletError(
            "YAML_SIZE",
            `${path.basename(file)} exceeds the 2 MiB limit.`,
            2,
        );
    return readFile(file, "utf8");
}

export async function yamlText(
    file: string,
    value: unknown,
    snapshot?: string | null,
): Promise<string> {
    const original =
        snapshot === undefined
            ? (await exists(file))
                ? await readYamlText(file)
                : null
            : snapshot;
    if (original === null) return new Document(value).toString({ indent: 4 });
    const doc = parseDocument(original, {
        uniqueKeys: true,
        prettyErrors: false,
    });
    if (doc.errors.length)
        throw new CrafletError(
            "YAML_SYNTAX",
            `Cannot edit invalid YAML: ${path.basename(file)}`,
            2,
        );
    const previous: unknown = doc.toJS({ maxAliasCount: 50 });
    if (stableStringify(previous) === stableStringify(value)) return original;
    function update(keys: string[], before: unknown, after: unknown) {
        if (stableStringify(before) === stableStringify(after)) return;
        if (
            after !== null &&
            typeof after === "object" &&
            !Array.isArray(after) &&
            before !== null &&
            typeof before === "object" &&
            !Array.isArray(before)
        ) {
            const old = before as Record<string, unknown>;
            const next = after as Record<string, unknown>;
            for (const key of Object.keys(old))
                if (!Object.hasOwn(next, key)) doc.deleteIn([...keys, key]);
            for (const [key, child] of Object.entries(next))
                update([...keys, key], old[key], child);
        } else doc.setIn(keys, after);
    }
    update([], previous, value);
    return doc.toString();
}

export async function writeYaml(file: string, value: unknown): Promise<void> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    const text = await yamlText(file, value);
    if ((await exists(file)) && (await readFile(file, "utf8")) === text) return;
    await atomicWrite(file, text);
}

export async function nearestFile(
    start: string,
    name: string,
): Promise<string | undefined> {
    let current = path.resolve(start);
    while (true) {
        if (await exists(path.join(current, name)))
            return path.join(current, name);
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

export async function loadProject(
    dir: string,
    home: string,
): Promise<ProjectContext> {
    const absolute = path.resolve(dir);
    await assertNoSymlinks(absolute, "craflet.yaml");
    const manifestText = await readYamlText(
        path.join(absolute, "craflet.yaml"),
    );
    const manifest = validateProject(
        parseYamlContent(manifestText, "craflet.yaml"),
    );
    const workspace = await nearestFile(absolute, "craflet-workspace.yaml");
    const lockRoot = workspace ? path.dirname(workspace) : absolute;
    return {
        dir: absolute,
        manifest,
        manifestText,
        lockRoot,
        lockKey:
            path.relative(lockRoot, absolute).replaceAll(path.sep, "/") || ".",
        home,
    };
}

export async function readLock(root: string): Promise<LockFile> {
    const file = path.join(root, "craflet-lock.yaml");
    return parseLockText(
        (await exists(file)) ? await readYamlText(file) : null,
    );
}

export function parseLockText(text: string | null): LockFile {
    return validateLock(
        text === null
            ? { lockVersion: 1, projects: {} }
            : parseYamlContent(text, "craflet-lock.yaml"),
    );
}

export async function workspaceProjects(root: string): Promise<string[]> {
    const workspaceFile = await nearestFile(root, "craflet-workspace.yaml");
    if (!workspaceFile)
        return (await exists(path.join(root, "craflet.yaml")))
            ? [path.resolve(root)]
            : [];
    const workspace = WorkspaceSchema(await readYaml(workspaceFile));
    if (workspace instanceof type.errors)
        throw validationError("craflet-workspace.yaml", workspace);
    const base = path.dirname(workspaceFile);
    const matchers = workspace.projects.map(workspacePattern);
    const includes = matchers.filter((entry) => !entry.excluded);
    const excludes = matchers.filter((entry) => entry.excluded);
    const projects: string[] = [];
    async function walk(directory: string, depth: number) {
        if (depth > 12)
            throw new CrafletError(
                "WORKSPACE_DEPTH",
                "Workspace nesting exceeds 12 directories.",
                2,
            );
        const relative =
            path.relative(base, directory).replaceAll(path.sep, "/") || ".";
        if (
            (await exists(path.join(directory, "craflet.yaml"))) &&
            includes.some(({ matches }) => matches(relative)) &&
            !excludes.some(({ matches }) => matches(relative))
        )
            projects.push(directory);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (
                !entry.isDirectory() ||
                entry.isSymbolicLink() ||
                entry.name.startsWith(".") ||
                ["node_modules", "runtime", "config"].includes(entry.name)
            )
                continue;
            await walk(path.join(directory, entry.name), depth + 1);
        }
    }
    await walk(base, 0);
    return projects.sort();
}

export async function selectProjects(
    cwd: string,
    home: string,
    options: { recursive?: boolean; filters?: string[] } = {},
): Promise<ProjectContext[]> {
    const projectFile = await nearestFile(cwd, "craflet.yaml");
    const recursive = options.recursive || Boolean(options.filters?.length);
    const dirs = recursive
        ? await workspaceProjects(cwd)
        : projectFile
          ? [path.dirname(projectFile)]
          : [];
    if (!dirs.length)
        throw new CrafletError(
            "NO_PROJECT",
            "No project selected. Use --recursive at a workspace root, or -C <project>.",
            2,
        );
    const all = await Promise.all(dirs.map((dir) => loadProject(dir, home)));
    const selected = options.filters?.length
        ? all.filter((project) =>
              options.filters?.some(
                  (filter) =>
                      picomatch(filter)(project.manifest.name) ||
                      picomatch(filter)(project.lockKey),
              ),
          )
        : all;
    if (!selected.length)
        throw new CrafletError(
            "EMPTY_SELECTION",
            "The workspace filter matched no projects.",
            2,
        );
    const names = new Set<string>();
    for (const project of all) {
        if (names.has(project.manifest.name))
            throw new CrafletError(
                "DUPLICATE_PROJECT",
                `Duplicate project name: ${project.manifest.name}`,
                2,
            );
        names.add(project.manifest.name);
    }
    return selected;
}

export async function initProject(
    dir: string,
    options: {
        name: string;
        kind: "paper" | "velocity";
        version: string;
        build?: string;
        source?: SourceInput;
        dryRun?: boolean;
        eula?: {
            home: string;
            requestConsent: RequestEulaConsent;
            signal?: AbortSignal;
        };
    },
): Promise<ProjectManifest> {
    const file = path.join(dir, "craflet.yaml");
    const assertAvailable = async () => {
        if (await exists(file))
            throw new CrafletError(
                "PROJECT_EXISTS",
                "craflet.yaml already exists; it will not be overwritten.",
                3,
            );
        await assertNoSymlinks(dir);
        for (const child of ["config", "runtime", "shared-data", ".gitignore"])
            await assertNoSymlinks(dir, child);
    };
    if (options.dryRun) {
        if (await exists(file))
            throw new CrafletError(
                "PROJECT_EXISTS",
                "craflet.yaml already exists; it will not be overwritten.",
                3,
            );
    } else await assertAvailable();
    const defaults = newProject(options.name, options.kind, options.version);
    if (options.source !== undefined) parseSource(options.source);
    const manifest = validateProject({
        ...defaults,
        id: randomUUID(),
        server: {
            ...defaults.server,
            ...(options.build !== undefined ? { build: options.build } : {}),
            ...(options.source !== undefined ? { source: options.source } : {}),
        },
    });
    if (options.kind === "paper" && options.eula)
        await ensureUserEulaConsent(
            options.eula.home,
            options.eula.requestConsent,
            {
                ...(options.dryRun !== undefined
                    ? { dryRun: options.dryRun }
                    : {}),
                ...(options.eula.signal ? { signal: options.eula.signal } : {}),
                document: proposedEulaDocument(
                    path.join(dir, "runtime/eula.txt"),
                ),
            },
        );
    if (!options.dryRun) {
        // Consent can remain open indefinitely, so revalidate before any project write.
        await assertAvailable();
        for (const child of ["config", "runtime", "shared-data"])
            await mkdir(path.join(dir, child), { recursive: true });
        await writeYaml(file, manifest);
        const ignore = path.join(dir, ".gitignore");
        const original = (await exists(ignore))
            ? await readFile(ignore, "utf8")
            : "";
        const rules = [
            "runtime/",
            "shared-data/",
            ".craflet/",
            "imports/",
            ".env",
            ".env.*",
        ];
        await atomicWrite(
            ignore,
            `${original}${original && !original.endsWith("\n") ? "\n" : ""}${rules.filter((rule) => !original.split(/\r?\n/).includes(rule)).join("\n")}\n`,
        );
    }
    return manifest;
}

export async function initWorkspace(
    dir: string,
    projects: string[],
    dryRun = false,
): Promise<void> {
    const file = path.join(dir, "craflet-workspace.yaml");
    if (await exists(file))
        throw new CrafletError(
            "WORKSPACE_EXISTS",
            "Workspace manifest already exists.",
            3,
        );
    for (const pattern of projects) workspacePattern(pattern);
    if (!dryRun) await writeYaml(file, { schemaVersion: 1, projects });
}

function workspacePattern(input: string): {
    excluded: boolean;
    matches: (value: string) => boolean;
} {
    const excluded = input.startsWith("!");
    const pattern = (excluded ? input.slice(1) : input).replaceAll("\\", "/");
    if (
        !pattern ||
        path.posix.isAbsolute(pattern) ||
        path.win32.isAbsolute(pattern) ||
        pattern.includes(":") ||
        pattern.split("/").includes("..")
    ) {
        throw new CrafletError(
            "WORKSPACE_PATH",
            "Workspace patterns must be nonempty and remain under the workspace directory.",
            2,
        );
    }
    return {
        excluded,
        matches: picomatch(pattern, { dot: false, nonegate: true }),
    };
}

export function fingerprint(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}
