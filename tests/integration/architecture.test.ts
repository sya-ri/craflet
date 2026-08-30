import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, type TsdownPlugin } from "tsdown";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    type ArchitectureReport,
    architecturePlugin,
    checkArchitecture,
} from "../../scripts/check-architecture.mjs";

let root: string;
async function source(name: string, code: string): Promise<string> {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, code);
    return file;
}

beforeEach(async () => {
    root = await realpath(
        await mkdtemp(path.join(tmpdir(), "crafleet-architecture-")),
    );
    await source(
        "package.json",
        JSON.stringify({ private: true, type: "module" }),
    );
    for (const [kind, name, dependencies] of [
        ["core", "@crafleet/core", {}],
        ["adapters", "@crafleet/adapters", { "@crafleet/core": "workspace:*" }],
        [
            "cli",
            "crafleet",
            {
                "@crafleet/core": "workspace:*",
                "@crafleet/adapters": "workspace:*",
            },
        ],
    ] as const) {
        await source(
            `packages/${kind}/package.json`,
            JSON.stringify({
                name,
                type: "module",
                exports: { ".": "./src/index.ts" },
                dependencies,
            }),
        );
        const link = path.join(root, "node_modules", name);
        await mkdir(path.dirname(link), { recursive: true });
        await symlink(path.join(root, "packages", kind), link, "junction");
    }
    await source("packages/core/src/index.ts", "export const value = 42;\n");
    await source(
        "packages/adapters/src/index.ts",
        'import { value } from "@crafleet/core"; export const answer = value + 1;\n',
    );
    await source(
        "packages/cli/src/index.ts",
        'import { answer } from "@crafleet/adapters"; console.log(answer);\n',
    );
});

afterEach(async () => {
    if (!root) return;
    const base = await realpath(tmpdir());
    const actual = await realpath(root);
    if (
        path.dirname(actual) !== base ||
        !path.basename(actual).startsWith("crafleet-architecture-")
    )
        throw new Error("Unsafe architecture fixture cleanup.");
    await rm(actual, { recursive: true, force: true });
});

async function resolveFixture(
    options: {
        entry?: string;
        alias?: Record<string, string>;
        external?: string[];
        beforeCheck?: TsdownPlugin;
        standalone?: boolean;
    } = {},
): Promise<ArchitectureReport> {
    let report: ArchitectureReport | undefined;
    const bundles = await build({
        config: false,
        cwd: root,
        entry: [options.entry ?? "packages/cli/src/index.ts"],
        outDir: path.join(root, "unused-output"),
        format: "esm",
        platform: "node",
        target: "node24",
        deps: { alwaysBundle: [/.*/], onlyBundle: false },
        ...(options.alias ? { alias: options.alias } : {}),
        ...(options.external
            ? { inputOptions: { external: options.external } }
            : {}),
        plugins: [
            options.beforeCheck,
            architecturePlugin({
                root,
                standalone: options.standalone ?? true,
                onChecked: (value) => {
                    report = value;
                },
            }),
        ],
        write: false,
        clean: false,
        dts: false,
        exports: false,
        report: false,
        logLevel: "silent",
    });
    for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
    if (!report) throw new Error("No resolved architecture report.");
    return report;
}

describe("resolved build architecture", () => {
    it("checks every production entry without writing or cleaning bundles", async () => {
        await source(".architecture-output/sentinel.txt", "keep me");
        await source(
            "packages/core/src/ignored.test.ts",
            'import "not-a-real-package";',
        );
        await source(
            "packages/core/src/contracts.d.ts",
            'import "not-a-real-package";',
        );
        const report = await checkArchitecture(root);
        expect(report.projectModules).toBe(3);
        expect(report.runtimeEdges).toBe(2);
        expect(
            await readFile(
                path.join(root, ".architecture-output/sentinel.txt"),
                "utf8",
            ),
        ).toBe("keep me");
        await expect(
            stat(
                path.join(
                    root,
                    ".architecture-output/packages/core/src/index.mjs",
                ),
            ),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("uses ASTs for comments and type-only cycles, and resolves allowed builtin imports", async () => {
        await source(
            "packages/core/src/a.ts",
            'import type { B } from "./b.js"; export interface A { b?: B }\n',
        );
        await source(
            "packages/core/src/b.ts",
            'import type { A } from "./a.js"; export interface B { a?: A }\n',
        );
        await source(
            "packages/core/src/index.ts",
            'export const value = "fetch() process.env import(whatever)"; // import "@crafleet/adapters/private";\n',
        );
        await source(
            "packages/adapters/src/index.ts",
            'export const answer = () => import("node:sqlite");\n',
        );
        const report = await checkArchitecture(root);
        expect(report.projectModules).toBe(5);
        expect(report.externals).toContain("node:sqlite");
    });

    it.each(["^1.2.3", "latest", "workspace:^"])(
        "rejects a non-exact public dependency %s",
        async (version) => {
            await source(
                "packages/core/package.json",
                JSON.stringify({
                    name: "@crafleet/core",
                    dependencies: { example: version },
                }),
            );
            await expect(checkArchitecture(root)).rejects.toThrow(
                "Dependency must be exact",
            );
        },
    );

    it.each([
        { code: 'import "node:fs";', message: "Core contains I/O" },
        { code: 'import "fs/promises";', message: "Core contains I/O" },
        {
            code: 'export const value = process["env"];',
            message: "Core accesses the host directly",
        },
        {
            code: "export const value = globalThis.fetch;",
            message: "Core accesses the host directly",
        },
        {
            code: 'import type { answer } from "@crafleet/adapters";',
            message: "allowed public entry",
        },
        {
            code: 'import "../../adapters/src/index.js";',
            message: "Cross-package source import",
        },
    ])(
        "rejects source boundary violation: $message",
        async ({ code, message }) => {
            await source("packages/core/src/index.ts", code);
            await expect(checkArchitecture(root)).rejects.toThrow(message);
        },
    );

    it.each(["esm", "cjs"])(
        "detects %s reverse references after alias resolution",
        async (format) => {
            await source(
                "packages/adapters/src/index.ts",
                "export const answer = 1;",
            );
            await source(
                "packages/core/src/index.ts",
                format === "esm"
                    ? 'export { answer } from "hidden-alias";'
                    : 'export const answer = require("hidden-alias");',
            );
            await expect(
                resolveFixture({
                    entry: "packages/core/src/index.ts",
                    alias: {
                        "hidden-alias": path.join(
                            root,
                            "packages/adapters/src/index.ts",
                        ),
                    },
                }),
            ).rejects.toThrow("Resolved reverse dependency");
        },
    );

    it("detects an otherwise-allowed package's private module through an alias", async () => {
        await source(
            "packages/core/src/private.ts",
            "export const hidden = 1;",
        );
        await source(
            "packages/cli/src/index.ts",
            'export { hidden } from "hidden-alias";',
        );
        await expect(
            resolveFixture({
                alias: {
                    "hidden-alias": path.join(
                        root,
                        "packages/core/src/private.ts",
                    ),
                },
            }),
        ).rejects.toThrow("Resolved private entry");
    });

    it.each(["static", "dynamic"])(
        "detects resolved %s cycles, including .js to .ts resolution",
        async (kind) => {
            await source(
                "packages/core/src/a.ts",
                kind === "static"
                    ? 'import { b } from "./b.js"; export const a = () => b;'
                    : 'export const a = () => import("./b.js");',
            );
            await source(
                "packages/core/src/b.ts",
                kind === "static"
                    ? 'import { a } from "./a.js"; export const b = () => a;'
                    : 'export const b = () => import("./a.js");',
            );
            await expect(checkArchitecture(root)).rejects.toThrow(
                "Resolved runtime import cycle",
            );
        },
    );

    it("rejects an external package in the actual resolver graph", async () => {
        await source(
            "packages/cli/src/index.ts",
            'import value from "unbundled-library"; console.log(value);',
        );
        await expect(
            resolveFixture({ external: ["unbundled-library"] }),
        ).rejects.toThrow("Unbundled runtime dependency");
    });

    it("rejects an opaque first-party runtime import", async () => {
        await source(
            "packages/cli/src/index.ts",
            "const name = process.env.PLUGIN; await import(name);",
        );
        await expect(resolveFixture()).rejects.toThrow(
            "Runtime imports must be literal",
        );
    });

    it.each([
        'import "left-external";',
        'require("left-external");',
        'import { createRequire as cr } from "node:module"; const r = cr(import.meta.url); const alias = r; alias("left-external");',
        'import * as mod from "node:module"; mod.createRequire(import.meta.url)("left-external");',
        'import mod from "node:module"; mod["createRequire"](import.meta.url)("left-external");',
        "const name = globalThis.plugin; import(name);",
    ])(
        "checks final AST references injected after module resolution",
        async (code) => {
            await expect(
                resolveFixture({
                    beforeCheck: {
                        name: "inject-unbundled-code",
                        renderChunk(chunk) {
                            return `${chunk}\n${code}\n`;
                        },
                    },
                }),
            ).rejects.toThrow(
                /Unbundled output reference|Unresolved dynamic import/,
            );
        },
    );
});
