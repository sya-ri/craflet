import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixtureDirectory = fileURLToPath(new URL("./", import.meta.url));
const outputDirectory = join(repository, "artifacts", "fixtures");
const packageDirectory = "dev/craflet/fixtures";
const userAgent = "craflet/0.1.0 (https://github.com/sya-ri/craflet)";
const versions = { v1: "1.0.0", v2: "2.0.0" };
const platforms = {
    bukkit: { id: "CrafletBukkitFixture", main: "BukkitFixture" },
    paper: { id: "CrafletPaperFixture", main: "PaperFixture" },
    velocity: { id: "crafletvelocityfixture", main: "VelocityFixture" },
};

async function checksum(file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Fixture artifact is not a regular file: ${file}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { sha256: hash.digest("hex"), size: info.size };
}

async function verify(file, locked) {
    const observed = await checksum(file);
    if (observed.sha256 !== locked.sha256 || observed.size !== locked.size) {
        throw new Error(`Fixture checksum does not match the lock: ${file}`);
    }
}

async function ensureArtifact(locked, offline) {
    if (
        !/^[a-f0-9]{64}$/.test(locked.sha256) ||
        !Number.isSafeInteger(locked.size)
    ) {
        throw new Error("Invalid fixture artifact lock.");
    }
    const directory = join(outputDirectory, "cache", locked.sha256);
    const destination = join(directory, "artifact.jar");
    try {
        await verify(destination, locked);
        return destination;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (offline)
        throw new Error(`Offline fixture cache miss: ${locked.sha256}`);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.download-${randomUUID()}`);
    let handle;
    try {
        const response = await fetch(locked.url, {
            headers: { "User-Agent": userAgent },
            signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`Fixture download failed: HTTP ${response.status}`);
        }
        handle = await open(temporary, "wx", 0o600);
        let received = 0;
        const hash = createHash("sha256");
        for await (const chunk of response.body) {
            received += chunk.byteLength;
            if (received > locked.size)
                throw new Error("Fixture exceeds locked size.");
            hash.update(chunk);
            await handle.writeFile(chunk);
        }
        if (received !== locked.size || hash.digest("hex") !== locked.sha256) {
            throw new Error(
                "Downloaded fixture does not match the locked SHA-256 and size.",
            );
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        await chmod(temporary, 0o444);
        try {
            await rename(temporary, destination);
        } catch (error) {
            if (!["EEXIST", "EPERM", "EACCES"].includes(error.code))
                throw error;
            await verify(destination, locked);
        }
        return destination;
    } finally {
        await handle?.close();
        await rm(temporary, { force: true });
    }
}

async function javaTools(expected) {
    let javaHome = process.env.CRAFLET_TEST_JAVA_HOME ?? process.env.JAVA_HOME;
    if (!javaHome) {
        try {
            const result = await execute("mise", ["where", "java"], {
                cwd: repository,
                windowsHide: true,
                timeout: 30_000,
            });
            javaHome = result.stdout.trim();
        } catch {
            throw new Error(
                "Set CRAFLET_TEST_JAVA_HOME to the pinned JDK, or install it with mise.",
            );
        }
    }
    const suffix = process.platform === "win32" ? ".exe" : "";
    const tools = Object.fromEntries(
        ["java", "javac", "jar"].map((name) => [
            name,
            join(javaHome, "bin", name + suffix),
        ]),
    );
    for (const name of ["java", "javac"]) {
        const result = await execute(tools[name], ["-version"], {
            cwd: repository,
            windowsHide: true,
            timeout: 30_000,
        });
        const text = result.stdout + result.stderr;
        const version =
            name === "java"
                ? /version "([^"]+)"/.exec(text)?.[1]
                : /javac ([^\s]+)/.exec(text)?.[1];
        if (version !== expected.version) {
            throw new Error(
                `Fixture ${name} requires ${expected.version}; found ${version ?? "unknown"}. Set CRAFLET_TEST_JAVA_HOME.`,
            );
        }
    }
    return tools;
}

async function listFiles(directory, prefix = "") {
    const paths = [];
    for (const entry of await readdir(join(directory, prefix), {
        withFileTypes: true,
    })) {
        const path = join(prefix, entry.name);
        if (entry.isDirectory())
            paths.push(...(await listFiles(directory, path)));
        else if (entry.isFile()) paths.push(path);
        else
            throw new Error(
                "Unexpected special file in fixture build directory.",
            );
    }
    return paths.sort();
}

function descriptor(platform, version) {
    const { id, main } = platforms[platform];
    const className = `dev.craflet.fixtures.${main}`;
    if (platform === "velocity") {
        return {
            name: "velocity-plugin.json",
            content: `${JSON.stringify({ id, name: "Craflet Velocity Fixture", version, main: className, dependencies: [] }, null, 4)}\n`,
        };
    }
    return {
        name: platform === "paper" ? "paper-plugin.yml" : "plugin.yml",
        content: `name: ${id}\nversion: '${version}'\nmain: ${className}\napi-version: '26.2'\n`,
    };
}

async function compile(
    platform,
    revision,
    workDirectory,
    dependencies,
    tools,
    javaMajor,
) {
    const version = versions[revision];
    const classes = join(workDirectory, "classes");
    const generated = join(workDirectory, "FixtureVersion.java");
    await mkdir(classes, { recursive: true });
    await writeFile(
        generated,
        `package dev.craflet.fixtures;\nfinal class FixtureVersion { static final String VALUE = "${version}"; }\n`,
        "utf8",
    );
    const sourceRoot = join(
        fixtureDirectory,
        "plugins",
        "src",
        packageDirectory,
    );
    await execute(
        tools.javac,
        [
            "-J-Duser.language=en",
            "-J-Duser.country=US",
            "-encoding",
            "UTF-8",
            "-g:none",
            "-proc:none",
            "--release",
            String(javaMajor),
            "-classpath",
            dependencies.join(delimiter),
            "-d",
            classes,
            join(sourceRoot, "FixtureLifecycle.java"),
            generated,
            join(sourceRoot, `${platforms[platform].main}.java`),
        ],
        {
            cwd: repository,
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
        },
    );
    const metadata = descriptor(platform, version);
    await writeFile(join(classes, metadata.name), metadata.content, "utf8");
    const output = join(workDirectory, `${platform}-${revision}.jar`);
    const entries = await listFiles(classes);
    await execute(
        tools.jar,
        [
            "--create",
            "--file",
            output,
            "--no-manifest",
            "--no-compress",
            "--date=2000-01-01T00:00:00Z",
            ...entries.flatMap((entry) => ["-C", classes, entry]),
        ],
        {
            cwd: repository,
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
        },
    );
    return { path: output, ...(await checksum(output)) };
}

async function removeTemporary(directory) {
    const path = resolve(directory);
    const base = resolve(outputDirectory);
    if (
        !path.startsWith(base + sep) ||
        !relative(base, path).startsWith(".build-")
    ) {
        throw new Error(
            "Refusing to remove a directory outside the fixture build root.",
        );
    }
    await rm(path, { recursive: true, force: true });
}

/** Downloads locked bytes and compiles plugins. Never launches Java servers or accepts an EULA. */
export async function prepareFixtures({
    offline = false,
    withServers = false,
    verifyReproducible = false,
} = {}) {
    const serverLock = JSON.parse(
        await readFile(join(fixtureDirectory, "servers.lock.json"), "utf8"),
    );
    const pluginLock = JSON.parse(
        await readFile(join(fixtureDirectory, "plugins.lock.json"), "utf8"),
    );
    const tools = await javaTools(serverLock.java);
    await mkdir(outputDirectory, { recursive: true });
    const classpaths = { bukkit: [], paper: [], velocity: [] };
    for (const artifact of Object.values(pluginLock.dependencies)) {
        const path = await ensureArtifact(artifact, offline);
        for (const platform of artifact.platforms)
            classpaths[platform].push(path);
    }
    const temporary = await mkdtemp(join(outputDirectory, ".build-"));
    const result = {
        java: tools.java,
        javaVersion: serverLock.java.version,
        servers: {},
        plugins: {},
    };
    try {
        const built = [];
        for (const platform of Object.keys(platforms)) {
            result.plugins[platform] = {};
            for (const revision of Object.keys(versions)) {
                const path = join(temporary, `${platform}-${revision}`);
                const artifact = await compile(
                    platform,
                    revision,
                    path,
                    classpaths[platform],
                    tools,
                    serverLock.java.major,
                );
                if (verifyReproducible) {
                    const repeated = await compile(
                        platform,
                        revision,
                        `${path}-repeat`,
                        classpaths[platform],
                        tools,
                        serverLock.java.major,
                    );
                    if (repeated.sha256 !== artifact.sha256) {
                        throw new Error(
                            `Fixture build is not reproducible: ${platform} ${revision}`,
                        );
                    }
                }
                const destination = join(
                    outputDirectory,
                    "plugins",
                    `${platform}-${revision}.jar`,
                );
                result.plugins[platform][revision] = {
                    ...artifact,
                    path: destination,
                    id: platforms[platform].id,
                    version: versions[revision],
                };
                built.push({ artifact, destination });
            }
        }
        await mkdir(join(outputDirectory, "plugins"), { recursive: true });
        for (const { artifact, destination } of built)
            await rename(artifact.path, destination);
        if (withServers) {
            for (const [platform, locked] of Object.entries(
                serverLock.servers,
            )) {
                result.servers[platform] = {
                    path: await ensureArtifact(locked, offline),
                    ...locked,
                };
            }
        }
        await writeFile(
            join(outputDirectory, "fixtures.json"),
            `${JSON.stringify(result, null, 4)}\n`,
            "utf8",
        );
        return result;
    } finally {
        await removeTemporary(temporary);
    }
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const arguments_ = new Set(process.argv.slice(2));
    const supported = new Set([
        "--offline",
        "--with-servers",
        "--verify-reproducible",
    ]);
    try {
        for (const argument of arguments_) {
            if (!supported.has(argument))
                throw new Error(`Unknown fixture option: ${argument}`);
        }
        const result = await prepareFixtures({
            offline: arguments_.has("--offline"),
            withServers: arguments_.has("--with-servers"),
            verifyReproducible: arguments_.has("--verify-reproducible"),
        });
        process.stdout.write(`${JSON.stringify(result, null, 4)}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
