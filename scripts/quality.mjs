import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mode = process.argv[2];
if (!["format", "check", "fix"].includes(mode))
    throw new Error("Expected format, check or fix");
// Scope is explicit so generated runtimes, downloaded artifacts, backups and
// verbatim format fixtures can never be rewritten by a repository-wide glob.
const targets = [
    "packages/core/src",
    "packages/adapters/src",
    "packages/cli/src",
    "scripts",
    "tests/integration",
    "tests/e2e",
    "tests/support",
    "package.json",
    "packages/core/package.json",
    "packages/adapters/package.json",
    "packages/cli/package.json",
    "biome.json",
    "tsconfig.json",
    "tsdown.config.ts",
    "vitest.config.ts",
    ".pnpmfile.mjs",
];
const args = [
    mode === "format" ? "format" : "check",
    ...(mode === "check" ? [] : ["--write"]),
    ...targets,
];
const result = spawnSync(
    process.execPath,
    [require.resolve("@biomejs/biome/bin/biome"), ...args],
    { stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
