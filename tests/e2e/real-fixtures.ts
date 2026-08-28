import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import {
    loadProject,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import type {
    LockedArtifact,
    ServerKind,
} from "../../packages/core/src/domain/artifacts.js";
import type { ServerStatus } from "../../packages/core/src/ports/runtime.js";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const developmentCliEntry = path.join(
    repository,
    "packages",
    "cli",
    "dist",
    "cli.mjs",
);
const temporaryRoot = path.join(repository, ".test-tmp");
const managementSecret = "0123456789abcdef0123456789abcdef01234567";
const repositoryPassword = "craflet-e2e-disposable-repository-password";

export type PluginPlatform = "bukkit" | "paper" | "velocity";
export interface FixtureJar {
    path: string;
    sha256: string;
    size: number;
    id: string;
    version: string;
}
export interface RealFixtures {
    java: string;
    javaVersion: string;
    servers: Record<ServerKind, LockedArtifact & { path: string }>;
    plugins: Record<PluginPlatform, Record<"v1" | "v2", FixtureJar>>;
}
export interface RealSuite {
    fixtures: RealFixtures;
    cliEntry: string;
    packageDirectory?: string;
    root: string;
    home: string;
    env: NodeJS.ProcessEnv;
    projects: string[];
    commands: CliEvidence[];
    failed: boolean;
}
interface CliEvidence {
    startedAt: string;
    directory: string;
    args: string[];
    exitCode?: number | string;
    error?: string;
    stderr?: string;
}
interface CliReply<T> {
    ok: boolean;
    result?: T;
    error?: { code: string; message: string };
}

export function requirePaperEula(): void {
    if (process.env.CRAFLET_E2E_EULA !== "true") {
        throw new Error(
            "Paper E2E requires explicit Minecraft EULA acceptance. Read https://www.minecraft.net/eula and set CRAFLET_E2E_EULA=true only after accepting it. This test is not skipped.",
        );
    }
}

export async function fileHash(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
}

async function installPackagedCli(
    root: string,
    env: NodeJS.ProcessEnv,
    requested: string,
): Promise<string> {
    const source = path.resolve(repository, requested);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
        throw new Error(
            "CRAFLET_E2E_PACKAGE must name a regular local tarball.",
        );
    }
    const sha256 = await fileHash(source);
    const snapshot = path.join(root, "craflet-package.tgz");
    await copyFile(source, snapshot);
    if ((await fileHash(snapshot)) !== sha256)
        throw new Error("The package changed while it was copied.");
    let npm: string | undefined;
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
            /* Try another official Node distribution layout. */
        }
    }
    if (!npm)
        throw new Error("The Node runtime must include npm for tarball E2E.");
    const installDirectory = path.join(root, "installed-cli");
    await mkdir(installDirectory);
    await writeFile(
        path.join(installDirectory, "package.json"),
        `${JSON.stringify({ private: true, type: "module" })}\n`,
        "utf8",
    );
    const npmConfig = path.join(root, "npmrc");
    await writeFile(npmConfig, "", "utf8");
    await execute(
        process.execPath,
        [
            npm,
            "install",
            "--offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--package-lock=false",
            "--cache",
            path.join(root, "npm-cache"),
            snapshot,
        ],
        {
            cwd: installDirectory,
            env: {
                ...env,
                npm_config_userconfig: npmConfig,
                npm_config_update_notifier: "false",
            },
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
        },
    );
    const installed = path.join(installDirectory, "node_modules", "craflet");
    expect((await lstat(installed)).isSymbolicLink()).toBe(false);
    const manifest = JSON.parse(
        await readFile(path.join(installed, "package.json"), "utf8"),
    ) as { name: string; dependencies?: Record<string, string> };
    expect(manifest.name).toBe("craflet");
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
    for (const name of ["cli.mjs", "runner.mjs"]) {
        expect(
            (await lstat(path.join(installed, "dist", name))).isSymbolicLink(),
        ).toBe(false);
    }
    process.stderr.write(
        `Real server E2E uses isolated npm tarball SHA-256 ${sha256}\n`,
    );
    return path.join(installed, "dist", "cli.mjs");
}

async function cleanupPackageDirectory(directory: string): Promise<void> {
    const root = await realpath(directory);
    const base = await realpath(tmpdir());
    if (
        path.dirname(root) !== base ||
        !path.basename(root).startsWith("craflet-real-package-")
    ) {
        throw new Error(
            "Refusing to delete a directory outside the isolated package temporary root.",
        );
    }
    await rm(root, { recursive: true, force: true });
}

export async function prepareRealSuite(): Promise<RealSuite> {
    const requestedPackage = process.env.CRAFLET_E2E_PACKAGE;
    if (!requestedPackage) {
        try {
            await stat(developmentCliEntry);
        } catch {
            throw new Error(
                "Build the actual CLI before running E2E: pnpm build",
            );
        }
    }
    let fixtures: RealFixtures;
    try {
        fixtures = JSON.parse(
            await readFile(
                path.join(repository, "artifacts", "fixtures", "fixtures.json"),
                "utf8",
            ),
        ) as RealFixtures;
    } catch {
        throw new Error(
            "Prepare real fixtures first: node tests/fixtures/build.mjs --with-servers --verify-reproducible",
        );
    }
    for (const artifact of [
        ...Object.values(fixtures.servers),
        ...Object.values(fixtures.plugins).flatMap((revisions) =>
            Object.values(revisions),
        ),
    ]) {
        expect(await fileHash(artifact.path)).toBe(artifact.sha256);
        expect((await stat(artifact.path)).size).toBe(artifact.size);
    }
    if (!fixtures.servers.paper || !fixtures.servers.velocity) {
        throw new Error(
            "Both locked server JARs are required; prepare fixtures with --with-servers.",
        );
    }
    await mkdir(temporaryRoot, { recursive: true });
    const root = await realpath(
        await mkdtemp(path.join(temporaryRoot, "real-e2e-")),
    );
    const home = path.join(root, "home");
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        CRAFLET_HOME: home,
        CRAFLET_TEST_MANAGEMENT_SECRET: managementSecret,
        CRAFLET_TEST_BACKUP_PASSWORD: repositoryPassword,
        NO_COLOR: "1",
        NODE_PATH: "",
    };
    let cliEntry = developmentCliEntry;
    let packageDirectory: string | undefined;
    if (requestedPackage) {
        packageDirectory = await realpath(
            await mkdtemp(path.join(tmpdir(), "craflet-real-package-")),
        );
        try {
            cliEntry = await installPackagedCli(
                packageDirectory,
                env,
                requestedPackage,
            );
        } catch (error) {
            await cleanupPackageDirectory(packageDirectory);
            throw error;
        }
    }
    return {
        fixtures,
        cliEntry,
        ...(packageDirectory ? { packageDirectory } : {}),
        root,
        home,
        projects: [],
        commands: [],
        failed: false,
        env,
    };
}

function redacted(text: string): string {
    return text
        .replaceAll(managementSecret, "<fixture-secret>")
        .replaceAll(repositoryPassword, "<fixture-password>");
}

async function invoke<T>(
    suite: RealSuite,
    directory: string,
    args: string[],
): Promise<{ exitCode: number; reply: CliReply<T> }> {
    const command = [suite.cliEntry, "--json", "--cwd", directory, ...args];
    const evidence: CliEvidence = {
        startedAt: new Date().toISOString(),
        directory: path.relative(suite.root, directory),
        args: args.map(redacted),
    };
    suite.commands.push(evidence);
    if (suite.commands.length > 200) suite.commands.shift();
    const output = await execute(process.execPath, command, {
        cwd: suite.packageDirectory ?? repository,
        env: suite.env,
        windowsHide: true,
        timeout: 240_000,
        maxBuffer: 16 * 1024 * 1024,
    }).then(
        (result) => ({ exitCode: 0, ...result }),
        (
            error: Error & {
                code?: number | string;
                stdout?: string;
                stderr?: string;
            },
        ) => {
            if (typeof error.code !== "number") {
                evidence.exitCode = error.code ?? "unknown";
                evidence.error = redacted(error.message).slice(-8_192);
                throw error;
            }
            return {
                exitCode: error.code,
                stdout: error.stdout ?? "",
                stderr: error.stderr ?? "",
            };
        },
    );
    evidence.exitCode = output.exitCode;
    if (output.stderr) evidence.stderr = redacted(output.stderr).slice(-8_192);
    const lines = output.stdout.trim().split(/\r?\n/);
    if (lines.length !== 1 || !lines[0]) {
        throw new Error(
            redacted(
                `CLI did not emit exactly one JSON response: ${output.stdout}\n${output.stderr}`,
            ),
        );
    }
    try {
        const reply = JSON.parse(lines[0]) as CliReply<T>;
        if (reply.error)
            evidence.error = redacted(
                `${reply.error.code}: ${reply.error.message}`,
            ).slice(-8_192);
        return {
            exitCode: output.exitCode,
            reply,
        };
    } catch {
        throw new Error(
            redacted(
                `CLI emitted invalid JSON: ${output.stdout}\n${output.stderr}`,
            ),
        );
    }
}

export async function cli<T = unknown>(
    suite: RealSuite,
    directory: string,
    args: string[],
): Promise<T> {
    const { exitCode, reply } = await invoke<T>(suite, directory, args);
    if (exitCode !== 0 || !reply.ok || !Object.hasOwn(reply, "result")) {
        let log = "";
        try {
            log = (
                await readFile(
                    path.join(directory, ".craflet", "server.log"),
                    "utf8",
                )
            )
                .split(/\r?\n/)
                .slice(-35)
                .join("\n");
        } catch {
            /* Initialization may not have created a runner log. */
        }
        throw new Error(
            redacted(
                `craflet ${args.join(" ")} failed (${exitCode}): ${JSON.stringify(reply)}\n${log}`,
            ),
        );
    }
    return reply.result as T;
}

export async function cliError(
    suite: RealSuite,
    directory: string,
    args: string[],
    code: string,
): Promise<void> {
    const result = await invoke(suite, directory, args);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.reply).toMatchObject({ ok: false, error: { code } });
}

export async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("No ephemeral TCP port.");
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return address.port;
}

export async function assertPortReleased(port: number): Promise<void> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}

async function checkedSuiteRoot(suite: RealSuite): Promise<string> {
    const root = await realpath(suite.root);
    const parent = await realpath(temporaryRoot);
    if (
        path.dirname(root) !== parent ||
        !path.basename(root).startsWith("real-e2e-")
    )
        throw new Error(
            "Fault injection requires an owned E2E temporary directory.",
        );
    return root;
}

export async function withUnavailableRepository(
    suite: RealSuite,
    repositoryPath: string,
    operation: () => Promise<void>,
): Promise<void> {
    const root = await checkedSuiteRoot(suite);
    const source = await realpath(repositoryPath);
    const destination = path.resolve(`${source}.unavailable`);
    if (
        source !== path.resolve(repositoryPath) ||
        path.dirname(source) !== root ||
        path.dirname(destination) !== root ||
        (await lstat(source)).isSymbolicLink() ||
        !(await stat(source)).isDirectory()
    )
        throw new Error(
            "Only a direct, owned repository sibling may be renamed.",
        );
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await renameOwnedRepository(source, destination, root);
    try {
        await operation();
    } finally {
        // Never overwrite a newly created directory when restoring the NAS fixture.
        await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
        await renameOwnedRepository(destination, source, root);
    }
}

async function renameOwnedRepository(
    source: string,
    destination: string,
    root: string,
): Promise<void> {
    if (
        path.dirname(await realpath(source)) !== root ||
        path.dirname(path.resolve(destination)) !== root ||
        (await lstat(source)).isSymbolicLink()
    )
        throw new Error(
            "Refusing a repository move outside its verified temporary parent.",
        );
    await rename(source, destination);
}

/** Deny only new entries in this owned runtime root, leaving child directories writable. */
export async function withRuntimeRootWriteDenied(
    suite: RealSuite,
    directory: string,
    operation: () => Promise<void>,
): Promise<void> {
    const root = await checkedSuiteRoot(suite);
    const project = await realpath(directory);
    const runtime = path.join(project, "runtime");
    if (
        !suite.projects.includes(directory) ||
        path.dirname(project) !== root ||
        (await lstat(runtime)).isSymbolicLink() ||
        (await realpath(runtime)) !== runtime
    )
        throw new Error(
            "Permission faults are restricted to this test's runtime directory.",
        );
    const previousMode = (await stat(runtime)).mode & 0o777;
    const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const acl = async (script: string, previous?: string) => {
        const result = await execute(
            powershell,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(
                    `$ErrorActionPreference = 'Stop'\n${script}`,
                    "utf16le",
                ).toString("base64"),
            ],
            {
                windowsHide: true,
                timeout: 15_000,
                maxBuffer: 64 * 1024,
                env: {
                    ...suite.env,
                    CRAFLET_TEST_RUNTIME_DIRECTORY: runtime,
                    ...(previous
                        ? { CRAFLET_TEST_PREVIOUS_ACL: previous }
                        : {}),
                },
            },
        );
        return result.stdout.trim();
    };
    const previousAcl =
        process.platform === "win32"
            ? await acl(
                  [
                      "$acl = [System.IO.Directory]::GetAccessControl($env:CRAFLET_TEST_RUNTIME_DIRECTORY, [System.Security.AccessControl.AccessControlSections]::Access)",
                      "$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)",
                  ].join("\n"),
              )
            : undefined;
    if (process.platform !== "win32" && process.getuid?.() === 0)
        throw new Error(
            "The permission-failure E2E must run as an ordinary user, not root.",
        );
    const probe = path.join(runtime, ".craflet-e2e-write-probe");
    let probeCreated = false;
    try {
        if (process.platform === "win32") {
            if (!previousAcl)
                throw new Error("The original runtime ACL was not recorded.");
            await acl(
                [
                    "$acl = [System.IO.Directory]::GetAccessControl($env:CRAFLET_TEST_RUNTIME_DIRECTORY, [System.Security.AccessControl.AccessControlSections]::Access)",
                    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
                    "$rights = [System.Security.AccessControl.FileSystemRights]::CreateFiles",
                    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Deny)",
                    "$acl.AddAccessRule($rule)",
                    "[System.IO.Directory]::SetAccessControl($env:CRAFLET_TEST_RUNTIME_DIRECTORY, $acl)",
                ].join("\n"),
            );
        } else {
            await chmod(runtime, previousMode & ~0o222);
        }
        let denied = false;
        try {
            const handle = await open(probe, "wx");
            probeCreated = true;
            await handle.close();
        } catch (error) {
            if (
                ["EACCES", "EPERM"].includes(
                    (error as NodeJS.ErrnoException).code ?? "",
                )
            )
                denied = true;
            else throw error;
        }
        if (!denied)
            throw new Error(
                "The runtime permission fault did not deny file creation.",
            );
        const childProbe = path.join(
            runtime,
            "plugins",
            ".craflet-e2e-write-probe",
        );
        const handle = await open(childProbe, "wx");
        await handle.close();
        await unlink(childProbe);
        await operation();
    } finally {
        if (process.platform === "win32" && previousAcl) {
            await acl(
                [
                    "$acl = [System.Security.AccessControl.DirectorySecurity]::new()",
                    "$acl.SetSecurityDescriptorSddlForm($env:CRAFLET_TEST_PREVIOUS_ACL, [System.Security.AccessControl.AccessControlSections]::Access)",
                    "[System.IO.Directory]::SetAccessControl($env:CRAFLET_TEST_RUNTIME_DIRECTORY, $acl)",
                ].join("\n"),
                previousAcl,
            );
        } else {
            await chmod(runtime, previousMode);
        }
        if (probeCreated) await unlink(probe);
    }
}

export async function initRealProject(
    suite: RealSuite,
    directory: string,
    kind: ServerKind,
    name: string,
    shared?: { directory: string; instance: string },
    faults?: { stopTimeout: number },
): Promise<{
    dir: string;
    port: number;
    platforms: PluginPlatform[];
    sources: Record<string, string>;
}> {
    if (kind === "paper") requirePaperEula();
    const locked = suite.fixtures.servers[kind];
    const serverSource = locked.source;
    if (serverSource.provider !== "paper")
        throw new Error("Expected a locked Fill server fixture.");
    await cli(suite, suite.root, [
        "init",
        directory,
        "--name",
        name,
        "--type",
        kind,
        "--version",
        serverSource.version,
        "--build",
        serverSource.build,
        "--source",
        `file:${locked.path}`,
    ]);
    const project = await loadProject(directory, suite.home);
    suite.projects.push(directory);
    const manifest = {
        ...project.manifest,
        java: {
            command: suite.fixtures.java,
            args: [
                "-Xms128M",
                kind === "paper" ? "-Xmx1536M" : "-Xmx384M",
                ...(faults ? ["-Dcraflet.fixture.allowFaults=true"] : []),
                ...(shared
                    ? [
                          `-Dcraflet.fixture.sharedDirectory=${shared.directory}`,
                          `-Dcraflet.fixture.instance=${shared.instance}`,
                      ]
                    : []),
            ],
            startupTimeout: 180,
            stopTimeout: faults?.stopTimeout ?? 60,
        },
        ...(kind === "paper"
            ? {
                  secrets: {
                      TEST_MANAGEMENT_SECRET: {
                          env: "CRAFLET_TEST_MANAGEMENT_SECRET",
                      },
                  },
              }
            : {}),
    };
    await writeYaml(path.join(directory, "craflet.yaml"), manifest);
    const port = await freePort();
    if (kind === "paper") {
        const properties = `${[
            "server-ip=127.0.0.1",
            `server-port=${port}`,
            "online-mode=true",
            "motd=Craflet disposable E2E",
            "level-type=minecraft:flat",
            // Mojang 26.2 worldgen/flat_level_generator_preset/classic_flat.json: settings.
            `generator-settings=${JSON.stringify({
                biome: "minecraft:plains",
                features: false,
                lakes: false,
                layers: [
                    { block: "minecraft:bedrock", height: 1 },
                    { block: "minecraft:dirt", height: 2 },
                    { block: "minecraft:grass_block", height: 1 },
                ],
                structure_overrides: "minecraft:villages",
            })}`,
            "generate-structures=false",
            "view-distance=3",
            "simulation-distance=3",
            "spawn-protection=0",
            "management-server-enabled=false",
            "management-server-secret=" +
                "$" +
                "{secret:TEST_MANAGEMENT_SECRET}",
        ].join("\n")}\n`;
        await writeFile(
            path.join(directory, "config", "server.properties"),
            properties,
            "utf8",
        );
    } else {
        // Values and config-version are from the pinned JAR's default-velocity.toml.
        const toml = `${[
            'config-version = "2.8"',
            `bind = "127.0.0.1:${port}"`,
            'motd = "Craflet disposable E2E"',
            "show-max-players = 20",
            "online-mode = true",
            'player-info-forwarding-mode = "NONE"',
            'forwarding-secret-file = "forwarding.secret"',
            "[servers]",
            'lobby = "127.0.0.1:9"',
            'factions = "127.0.0.1:9"',
            'minigames = "127.0.0.1:9"',
            'try = ["lobby"]',
            "[forced-hosts]",
            '"e2e.invalid" = ["lobby"]',
            "[query]",
            "enabled = false",
        ].join("\n")}\n`;
        await writeFile(
            path.join(directory, "config", "velocity.toml"),
            toml,
            "utf8",
        );
    }
    const selected: PluginPlatform[] =
        kind === "paper" ? ["bukkit", "paper"] : ["velocity"];
    await mkdir(path.join(directory, "imports"), { recursive: true });
    const sources: Record<string, string> = {};
    for (const platform of selected) {
        const plugin = suite.fixtures.plugins[platform].v1;
        const source = path.join(directory, "imports", `${platform}.jar`);
        await copyFile(plugin.path, source);
        sources[platform] = source;
    }
    return { dir: directory, port, platforms: selected, sources };
}

export async function setupRealBackup(
    suite: RealSuite,
    directory: string,
    alias: string,
    repositoryPath: string,
    initialize = true,
): Promise<void> {
    await cli(suite, directory, [
        "backup",
        "setup",
        alias,
        "--path",
        repositoryPath,
        "--password-env",
        "CRAFLET_TEST_BACKUP_PASSWORD",
        ...(initialize ? ["--init"] : []),
        "--yes",
    ]);
}

async function writeDiagnostics(
    suite: RealSuite,
    shutdownFailures: string[],
): Promise<void> {
    const base = await realpath(temporaryRoot);
    const root = await realpath(suite.root);
    if (
        path.dirname(root) !== base ||
        !path.basename(root).startsWith("real-e2e-")
    ) {
        throw new Error("Refusing to write diagnostics outside E2E data.");
    }
    const directory = path.join(root, "diagnostics");
    await mkdir(directory, { recursive: true });
    await writeFile(
        path.join(directory, "commands.jsonl"),
        redacted(
            suite.commands.map((entry) => JSON.stringify(entry)).join("\n"),
        ),
        "utf8",
    );
    await writeFile(
        path.join(directory, "summary.json"),
        `${JSON.stringify(
            {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                java: suite.fixtures.javaVersion,
                cliSha256: await fileHash(suite.cliEntry),
                packaged: Boolean(suite.packageDirectory),
                shutdownConfirmed: shutdownFailures.length === 0,
                shutdownFailures: shutdownFailures.map((project) =>
                    path.relative(suite.root, project),
                ),
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    for (const [index, project] of suite.projects.entries()) {
        let log = "";
        try {
            const handle = await open(
                path.join(project, ".craflet", "server.log"),
                "r",
            );
            try {
                const { size } = await handle.stat();
                const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    Math.max(0, size - buffer.length),
                );
                log = buffer.subarray(0, bytesRead).toString("utf8");
            } finally {
                await handle.close();
            }
        } catch (error) {
            log = `Server log unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}\n`;
        }
        const name = path.basename(project).replace(/[^a-zA-Z0-9_-]/g, "_");
        await writeFile(
            path.join(directory, `${index}-${name}.log`),
            redacted(log).split(/\r?\n/).slice(-400).join("\n"),
            "utf8",
        );
    }
    process.stderr.write(`Redacted E2E diagnostics: ${directory}\n`);
}

export async function cleanupRealSuite(
    suite: RealSuite | undefined,
): Promise<void> {
    if (!suite) return;
    const failures: string[] = [];
    for (const directory of suite.projects) {
        try {
            const status = await cli<ServerStatus>(suite, directory, [
                "status",
            ]);
            if (status.status !== "stopped")
                await cli(suite, directory, ["stop"]);
            expect(
                (await cli<ServerStatus>(suite, directory, ["status"])).status,
            ).toBe("stopped");
        } catch {
            // Never guess a PID, remove a guard, or delete a possibly running world.
            failures.push(directory);
        }
    }
    if (
        failures.length ||
        suite.failed ||
        process.env.CRAFLET_E2E_KEEP === "true"
    ) {
        await writeDiagnostics(suite, failures);
    }
    if (failures.length)
        throw new Error(
            `Could not confirm test server shutdown; retained directories: ${failures.join(", ")}`,
        );
    if (suite.failed || process.env.CRAFLET_E2E_KEEP === "true") {
        if (suite.packageDirectory) {
            process.stderr.write(
                `Retained isolated package: ${suite.packageDirectory}\n`,
            );
        }
        process.stderr.write(`Retained isolated E2E evidence: ${suite.root}\n`);
        return;
    }
    if (suite.packageDirectory)
        await cleanupPackageDirectory(suite.packageDirectory);
    const base = await realpath(temporaryRoot);
    const root = await realpath(suite.root);
    if (
        path.dirname(root) !== base ||
        !path.basename(root).startsWith("real-e2e-")
    ) {
        throw new Error(
            "Refusing to delete a directory outside the E2E temporary root.",
        );
    }
    await rm(root, { recursive: true, force: true });
}
