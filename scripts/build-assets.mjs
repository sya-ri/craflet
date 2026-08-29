import { execFileSync } from "node:child_process";
import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    realpath,
    writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "packages/cli");
await mkdir(path.join(cli, "dist"), { recursive: true });
execFileSync(
    process.execPath,
    [path.join(root, "artifacts/schema-builder/generate-schema.mjs")],
    { cwd: root, stdio: "inherit" },
);
await copyFile(path.join(root, "LICENSE"), path.join(cli, "LICENSE"));
await copyFile(path.join(root, "README.md"), path.join(cli, "README.md"));
await mkdir(path.join(cli, "docs/assets"), { recursive: true });
await copyFile(
    path.join(root, "docs/assets/craflet-demo.gif"),
    path.join(cli, "docs/assets/craflet-demo.gif"),
);

const visited = new Set();
const licenses = [];
async function dependencyDirectory(name, from) {
    const require = createRequire(path.join(from, "package.json"));
    let file;
    try {
        file = require.resolve(`${name}/package.json`);
    } catch {
        file = require.resolve(name);
    }
    let directory = path.dirname(await realpath(file));
    for (;;) {
        try {
            if (
                JSON.parse(
                    await readFile(
                        path.join(directory, "package.json"),
                        "utf8",
                    ),
                ).name === name
            )
                return directory;
        } catch {
            /* Walk from an exported entry to its manifest. */
        }
        const parent = path.dirname(directory);
        if (parent === directory)
            throw new Error(
                `Could not find bundled dependency manifest: ${name}`,
            );
        directory = parent;
    }
}
async function collect(directory) {
    const manifest = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
    );
    const identity = `${manifest.name}@${manifest.version}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    if (!manifest.private && manifest.name !== "craflet") {
        const names = (await readdir(directory)).filter((name) =>
            /^(licen[sc]e|copying|notice)(?:[._-]|$)/i.test(name),
        );
        const texts = [];
        for (const name of names) {
            try {
                texts.push(await readFile(path.join(directory, name), "utf8"));
            } catch {
                /* License directories are not regular files. */
            }
        }
        if (!texts.length)
            throw new Error(
                `Bundled dependency has no license text: ${identity}`,
            );
        licenses.push(
            `## ${identity}\n\nDeclared license: ${String(manifest.license ?? "see license text")}\n\n${texts.join("\n\n")}`,
        );
    }
    for (const name of Object.keys(manifest.dependencies ?? {}))
        await collect(await dependencyDirectory(name, directory));
}
await collect(cli);
await writeFile(
    path.join(cli, "THIRD_PARTY_NOTICES.md"),
    `# Bundled JavaScript dependencies\n\nFull license notices for dependencies included in the CLI and runner. Java server distributions and optional restic executables are downloaded separately and retain their upstream licenses.\n\n${licenses.sort().join("\n\n---\n\n").trimEnd()}\n`,
);

for (const name of ["cli.mjs", "runner.mjs"]) {
    const code = await readFile(path.join(cli, "dist", name), "utf8");
    if (/\b(?:from|import)\s*[('" ]+(?:@craflet\/|\.\.\/.*\/src\/)/u.test(code))
        throw new Error(`Unbundled private reference in ${name}`);
}
console.log("Generated schemas and complete third-party notices.");
