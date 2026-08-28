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
const temporaryParent = await realpath(tmpdir());
const temporary = await mkdtemp(path.join(temporaryParent, "craflet-package-"));
const env = {
    ...process.env,
    CRAFLET_HOME: path.join(temporary, "home"),
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
};
const pnpm = process.env.npm_execpath;
assert(pnpm, "Run this verification using pnpm test:package.");
const run = (executable, args, cwd = temporary) =>
    execFileSync(executable, args, {
        cwd,
        env,
        encoding: "utf8",
        timeout: 120000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
const runPnpm = (args) =>
    /\.[cm]?js$/.test(pnpm)
        ? run(process.execPath, [pnpm, ...args], root)
        : run(pnpm, args, root);
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
    runPnpm([
        "--dir",
        "packages/cli",
        "pack",
        "--pack-destination",
        path.join(root, "artifacts"),
    ]);
    const manifest = JSON.parse(
        await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
    );
    const tarball = path.join(
        root,
        "artifacts",
        `craflet-${manifest.version}.tgz`,
    );
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
    const installed = path.join(temporary, "node_modules/craflet");
    const published = JSON.parse(
        await readFile(path.join(installed, "package.json"), "utf8"),
    );
    assert.equal(published.name, "craflet");
    assert.equal(
        Object.keys(published.dependencies ?? {}).length,
        0,
        "The tarball must not retain workspace or runtime npm dependencies.",
    );
    assert(!JSON.stringify(published).includes("workspace:"));
    const allowed = new Set([
        "package.json",
        "dist",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
    ]);
    assert(
        (await readdir(installed)).every((name) => allowed.has(name)),
        "Unexpected source, fixture or development files in the tarball.",
    );
    for (const name of allowed)
        assert(
            (await readdir(installed)).includes(name),
            `Missing required package file: ${name}`,
        );
    assert.match(
        await readFile(path.join(installed, "THIRD_PARTY_NOTICES.md"), "utf8"),
        /arktype@2\.2\.3/,
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
    for (const file of [
        "runner.mjs",
        "schemas/craflet.schema.json",
        "schemas/craflet-workspace.schema.json",
        "schemas/craflet-lock.schema.json",
    ])
        assert((await readFile(path.join(installed, "dist", file))).length > 0);
    const npxDirectory = await mkdtemp(
        path.join(temporaryParent, "craflet-npx-"),
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
                "craflet",
                "--version",
            ],
            npxDirectory,
        );
        assert.equal(output.trim(), manifest.version);
    } finally {
        await cleanup(npxDirectory, "craflet-npx-");
    }
    console.log(
        `Verified exact tarball: ${tarball}\nIsolated npm installation and npx-equivalent execution passed.`,
    );
} finally {
    await cleanup(temporary, "craflet-package-");
}
