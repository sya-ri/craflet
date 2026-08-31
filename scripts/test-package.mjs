import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const scriptArguments = process.argv.slice(2);
assert(
    scriptArguments.length === 0 ||
        (scriptArguments.length === 1 && scriptArguments[0] === "--existing"),
    "Usage: node scripts/test-package.mjs [--existing]",
);
const useExistingTarball = scriptArguments[0] === "--existing";
const temporaryParent = await realpath(tmpdir());
const temporary = await mkdtemp(
    path.join(temporaryParent, "crafleet-package-"),
);
const env = {
    ...process.env,
    CRAFLEET_HOME: path.join(temporary, "home"),
    NO_COLOR: "1",
    npm_config_cache: path.join(temporary, "npm-cache"),
    npm_config_update_notifier: "false",
};
const pnpm = process.env.npm_execpath;
const run = (executable, args, cwd = temporary) =>
    execFileSync(executable, args, {
        cwd,
        env,
        encoding: "utf8",
        timeout: 120000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
const runPnpm = (args) => {
    assert(pnpm, "Run package creation using pnpm test:package.");
    return /\.[cm]?js$/.test(pnpm)
        ? run(process.execPath, [pnpm, ...args], root)
        : run(pnpm, args, root);
};
async function cleanup(directory, prefix) {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), temporaryParent);
    assert(path.basename(absolute).startsWith(prefix));
    await rm(absolute, { recursive: true, force: true });
}
let npm;
for (const candidate of [
    path.join(
        path.dirname(process.execPath),
        "node_modules/npm/bin/npm-cli.js",
    ),
    path.resolve(
        path.dirname(await realpath(process.execPath)),
        "../lib/node_modules/npm/bin/npm-cli.js",
    ),
]) {
    try {
        npm = await realpath(candidate);
        break;
    } catch {
        /* Another official Node distribution layout. */
    }
}
assert(npm, "The selected Node runtime must include npm for package E2E.");
try {
    const manifest = JSON.parse(
        await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
    );
    const tarball = path.join(
        root,
        "artifacts",
        `crafleet-${manifest.version}.tgz`,
    );
    if (!useExistingTarball)
        runPnpm([
            "--dir",
            "packages/cli",
            "pack",
            "--pack-destination",
            path.join(root, "artifacts"),
        ]);
    await writeFile(
        path.join(temporary, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
    );
    run(process.execPath, [
        npm,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
    ]);
    const installed = path.join(temporary, "node_modules/crafleet");
    const published = JSON.parse(
        await readFile(path.join(installed, "package.json"), "utf8"),
    );
    assert.equal(published.name, "crafleet");
    assert.deepEqual(published.bin, {
        crafleet: "./dist/cli.mjs",
    });
    assert.equal(published.engines?.node, ">=24.0.0 <27");
    assert.equal(published.publishConfig?.access, "public");
    assert.equal(
        published.publishConfig?.registry,
        "https://registry.npmjs.org/",
    );
    assert.equal(published.publishConfig?.tag, "latest");
    assert.equal(
        published.repository?.url,
        "git+https://github.com/sya-ri/crafleet.git",
    );
    assert.equal(
        published.homepage,
        "https://github.com/sya-ri/crafleet#readme",
    );
    assert.equal(published.bugs, "https://github.com/sya-ri/crafleet/issues");
    assert.equal(
        Object.keys(published.dependencies ?? {}).length,
        0,
        "The tarball must not retain workspace or runtime npm dependencies.",
    );
    assert(!JSON.stringify(published).includes("workspace:"));
    const allowed = new Set([
        "package.json",
        "dist",
        "docs",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
    ]);
    const installedEntries = await readdir(installed);
    assert(
        installedEntries.every((name) => allowed.has(name)),
        "Unexpected source, fixture or development files in the tarball.",
    );
    for (const name of allowed)
        assert(
            installedEntries.includes(name),
            `Missing required package file: ${name}`,
        );
    const notices = await readFile(
        path.join(installed, "THIRD_PARTY_NOTICES.md"),
        "utf8",
    );
    assert.match(notices, /arktype@2\.2\.3/);
    assert.match(notices, /@earendil-works\/pi-tui@0\.84\.3/);
    assert.match(notices, /get-east-asian-width@1\.6\.0/);
    assert.match(notices, /marked@18\.0\.5/);
    assert.equal(
        await readFile(path.join(installed, "README.md"), "utf8"),
        await readFile(path.join(root, "README.md"), "utf8"),
        "The tarball must contain the current user-facing README.",
    );
    assert.deepEqual(await readdir(path.join(installed, "docs")), ["assets"]);
    assert.deepEqual(await readdir(path.join(installed, "docs/assets")), [
        "crafleet-demo.gif",
    ]);
    assert.deepEqual(
        await readFile(path.join(installed, "docs/assets/crafleet-demo.gif")),
        await readFile(path.join(root, "docs/assets/crafleet-demo.gif")),
        "The tarball must contain the exact README terminal demo.",
    );
    const entry = path.join(installed, "dist/cli.mjs");
    assert.match(run(process.execPath, [entry, "--help"]), /backup/);
    assert.equal(
        run(process.execPath, [entry, "--version"]).trim(),
        manifest.version,
    );
    const project = path.join(temporary, "server 日本語");
    const initialized = JSON.parse(
        run(process.execPath, [
            entry,
            "init",
            project,
            "--name",
            "packaged",
            "--type",
            "velocity",
            "--version",
            "4.1.1",
            "--json",
        ]),
    );
    assert.equal(initialized.result.name, "packaged");
    assert.equal(
        JSON.parse(
            run(process.execPath, [entry, "-C", project, "validate", "--json"]),
        ).ok,
        true,
    );
    const schemas = [
        "schemas/crafleet.schema.json",
        "schemas/crafleet-workspace.schema.json",
        "schemas/crafleet-lock.schema.json",
    ];
    assert.deepEqual(
        (await readdir(path.join(installed, "dist/schemas"))).sort(),
        schemas.map((file) => path.basename(file)).sort(),
    );
    for (const file of ["runner.mjs", ...schemas])
        assert((await readFile(path.join(installed, "dist", file))).length > 0);
    const npxDirectory = await mkdtemp(
        path.join(temporaryParent, "crafleet-npx-"),
    );
    try {
        const output = run(
            process.execPath,
            [
                npm,
                "exec",
                "--offline",
                "--yes",
                "--cache",
                path.join(temporary, "npm-cache"),
                "--package",
                tarball,
                "--",
                "crafleet",
                "--version",
            ],
            npxDirectory,
        );
        assert.equal(output.trim(), manifest.version);
    } finally {
        await cleanup(npxDirectory, "crafleet-npx-");
    }
    console.log(
        `Verified exact tarball: ${tarball}\nIsolated npm installation and npx-equivalent execution passed.`,
    );
} finally {
    await cleanup(temporary, "crafleet-package-");
}
