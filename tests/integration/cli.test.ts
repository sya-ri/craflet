import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    initProject,
    loadProject,
    NodeBackupService,
    NodeDeploymentManager,
    NodeRecoveryGroup,
    NodeServerController,
    readLock,
    readState,
    writeYaml,
} from "@craflet/adapters";
import { type BackupMetadata, CrafletError } from "@craflet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../packages/cli/src/application.js";
import { artifactJar, artifactZip } from "./artifacts-fixture.js";

let root: string;
const temporaryParent = await realpath(tmpdir());
let project: string;
let home: string;
let output: string;
let errors: string;
const entryUrl = pathToFileURL(path.resolve("packages/cli/dist/cli.mjs")).href;
const originalExitCode = process.exitCode;

beforeEach(async () => {
    root = await mkdtemp(path.join(temporaryParent, "craflet-cli-"));
    project = path.join(root, "server 日本語");
    home = path.join(root, "home");
    await writeFile(
        path.join(root, "server.jar"),
        artifactZip([
            {
                name: "META-INF/MANIFEST.MF",
                content: "Manifest-Version: 1.0\n",
            },
        ]),
    );
    await writeFile(
        path.join(root, "Example.jar"),
        artifactJar("Example", "1.0"),
    );
    await initProject(project, {
        name: "example",
        kind: "paper",
        version: "1.21.11",
        source: `file:${path.join(root, "server.jar")}`,
    });
    vi.stubEnv("CRAFLET_HOME", home);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        errors += String(chunk);
        return true;
    });
});
afterEach(async () => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (
        path.dirname(root) !== temporaryParent ||
        !path.basename(root).startsWith("craflet-cli-")
    )
        throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
});

interface Reply {
    ok: boolean;
    result?: unknown;
    help?: string;
    error?: { code: string; message: string };
}
async function command(
    args: string[],
    cwd = project,
    json = true,
): Promise<{ code: number; reply: Reply; output: string; errors: string }> {
    output = "";
    errors = "";
    process.exitCode = 0;
    await runCli(["-C", cwd, ...(json ? ["--json"] : []), ...args], entryUrl);
    const code = Number(process.exitCode ?? 0);
    const reply: Reply =
        json && output.trim()
            ? JSON.parse(output.trim().split("\n").at(-1) ?? "{}")
            : { ok: code === 0 };
    return { code, reply, output, errors };
}
async function result(args: string[], cwd = project): Promise<unknown> {
    const execution = await command(args, cwd);
    expect(execution.code, execution.output || execution.errors).toBe(0);
    expect(execution.reply.ok).toBe(true);
    return execution.reply.result;
}

describe("CLI usage and package-style project management", () => {
    it("does not confuse init's server version with the tool version", async () => {
        const target = path.join(root, "created");
        const initialized = await result([
            "init",
            target,
            "--name",
            "created",
            "--type",
            "velocity",
            "--version",
            "4.1.1",
            "--build",
            "24",
            "--source",
            `file:${path.join(root, "server.jar")}`,
        ]);
        expect(initialized).toMatchObject({
            name: "created",
            server: { type: "velocity", version: "4.1.1", build: "24" },
        });
        expect((await loadProject(target, home)).manifest.id).toMatch(
            /^[a-f0-9-]{36}$/,
        );
        expect((await command(["--version"])).reply.help).toBe("0.1.0");
    });
    it("accepts common flags before and after nested commands without losing parent values", async () => {
        const target = path.join(root, "preview");
        await result([
            "--dry-run",
            "init",
            target,
            "--version",
            "1.21.11",
            "--json",
        ]);
        await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await result(["config", "list", "--dry-run", "--json"])).toEqual(
            [],
        );
    });
    it.each(
        [
            [],
            ["backup"],
            ["deploy"],
            ["config"],
            ["workspace"],
            ["cache"],
            ["tools"],
            ["init"],
            ["import"],
            ["update"],
            ["start"],
            ["backup", "apply"],
            ["config", "resolve"],
        ].map((args) => ({ args })),
    )(
        "renders help for $args without performing an operation",
        async ({ args: parts }) => {
            const execution = await command([...parts, "--help"]);
            expect(execution.code).toBe(0);
            expect(execution.reply.help).toContain("Usage:");
            await expect(
                stat(path.join(project, ".craflet")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        },
    );
    it.each(
        [
            ["not-a-command"],
            ["add"],
            ["init", "--type", "fabric"],
            ["config", "resolve", "x.yml"],
            ["update", "--to", "2"],
            ["update", "A", "B", "--to", "2"],
            ["update", "A", "--server", "--to", "2"],
        ].map((args) => ({ args })),
    )("returns a usage error for $args", async ({ args }) => {
        const execution = await command(args);
        expect(execution.code).toBe(2);
        expect(execution.reply.ok).toBe(false);
    });
    it.each([true, false])(
        "never echoes invalid secret-shaped option values (json=%s)",
        async (json) => {
            const execution = await command(
                ["--password=do-not-print-this-secret"],
                project,
                json,
            );
            expect(execution.code).toBe(2);
            expect(execution.output + execution.errors).not.toContain(
                "do-not-print-this-secret",
            );
        },
    );
    it("requires explicit missing input in noninteractive mode", async () => {
        expect(
            (await command(["init", path.join(root, "missing"), "--yes"])).reply
                .error?.code,
        ).toBe("INPUT_REQUIRED");
    });
    it("validates a real manifest and reports stopped status without private state", async () => {
        expect(await result(["validate"])).toEqual([
            expect.objectContaining({
                project: "example",
                valid: true,
                locked: false,
            }),
        ]);
        expect(await result(["status"])).toEqual({ status: "stopped" });
        expect(await result(["list"])).toEqual([
            expect.objectContaining({ project: "example", plugins: [] }),
        ]);
    });
    it("can diagnose and stop after a user breaks the declaration, without printing its secret value", async () => {
        await writeFile(
            path.join(project, "craflet.yaml"),
            "password: do-not-print-this-secret\n",
        );
        const diagnostic = await command(["doctor"]);
        expect(diagnostic.code).toBe(3);
        expect(diagnostic.reply.ok).toBe(true);
        expect(diagnostic.output).not.toContain("do-not-print-this-secret");
        expect(await result(["stop"])).toEqual({ status: "stopped" });
        expect(await result(["status"])).toEqual({ status: "stopped" });
    });
    it("prints concise human-facing results too", async () => {
        const execution = await command(["status"], project, false);
        expect(execution.code).toBe(0);
        expect(execution.output).toContain("stopped");
    });
});

describe("CLI artifact and pending contracts", () => {
    it("inspects, adds, locks, updates, removes and discards without touching runtime JARs", async () => {
        const plugin = path.join(root, "Example.jar");
        expect(await result(["inspect", plugin])).toMatchObject({
            id: "Example",
            format: "bukkit",
        });
        await result(["add", `file:${plugin}`, "--offline"]);
        const before = await readState(project);
        expect(before.pending?.lock.plugins.Example?.version).toBe("1.0");
        await expect(
            stat(path.join(project, "runtime/plugins/Example.jar")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await writeFile(plugin, artifactJar("Example", "2.0"));
        await result(["install", "--frozen-lockfile", "--offline"]);
        expect(
            (await readState(project)).pending?.lock.plugins.Example?.version,
        ).toBe("1.0");
        expect(await result(["outdated", "Example", "--offline"])).toEqual([
            expect.objectContaining({
                updates: [expect.objectContaining({ status: "local" })],
            }),
        ]);
        await result(["update", "Example", "--offline"]);
        expect(
            (await readState(project)).pending?.lock.plugins.Example?.version,
        ).toBe("2.0");
        await mkdir(path.join(project, "runtime/plugins/Example"), {
            recursive: true,
        });
        await writeFile(
            path.join(project, "runtime/plugins/Example/data.yml"),
            "count: 42\n",
        );
        await result(["remove", "Example", "--offline"]);
        expect((await loadProject(project, home)).manifest.plugins).toEqual({});
        expect(
            await readFile(
                path.join(project, "runtime/plugins/Example/data.yml"),
                "utf8",
            ),
        ).toContain("42");
        const lock = await readFile(
            path.join(project, "craflet-lock.yaml"),
            "utf8",
        );
        await result(["deploy", "discard", "--yes"]);
        expect((await readState(project)).pending).toBeUndefined();
        expect(
            await readFile(path.join(project, "craflet-lock.yaml"), "utf8"),
        ).toBe(lock);
    });
    it("reports absent names, duplicate declarations and frozen mismatches", async () => {
        expect(
            (await command(["remove", "Missing", "--offline"])).reply.error
                ?.code,
        ).toBe("PLUGIN_UNKNOWN");
        expect(
            (await command(["install", "--frozen-lockfile", "--offline"])).reply
                .error?.code,
        ).toBe("FROZEN_LOCK");
        await result([
            "add",
            `file:${path.join(root, "Example.jar")}`,
            "--offline",
        ]);
        expect(
            (
                await command([
                    "add",
                    `file:${path.join(root, "Example.jar")}`,
                    "--offline",
                ])
            ).reply.error?.code,
        ).toBe("PLUGIN_EXISTS");
        expect(
            (await command(["outdated", "Missing", "--offline"])).reply.error
                ?.code,
        ).toBe("PLUGIN_UNKNOWN");
    });
    it.each(
        [
            ["install"],
            ["add", "modrinth:example@latest"],
            ["update", "--all"],
            ["start"],
            ["restart"],
            ["run"],
            ["deploy", "apply"],
            ["deploy", "discard"],
            ["recover"],
        ].map((args) => ({ args })),
    )("provides a nonmutating preview for $args", async ({ args }) => {
        const manifest = await readFile(
            path.join(project, "craflet.yaml"),
            "utf8",
        );
        await result([...args, "--dry-run"]);
        expect(await readFile(path.join(project, "craflet.yaml"), "utf8")).toBe(
            manifest,
        );
        await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("previews a prepared Paper installation without starting Java and stops idempotently", async () => {
        await result(["install", "--offline"]);
        // Java probing is exercised elsewhere; this CLI test never launches Java.
        expect(await result(["deploy", "plan"])).toEqual([
            expect.objectContaining({
                pending: expect.any(String),
                recoveryRequired: false,
            }),
        ]);
        expect(await result(["stop", "--yes", "--force"])).toEqual({
            status: "stopped",
        });
    });
});

describe("CLI configuration, backup and maintenance", () => {
    it("tracks runtime config, captures edits, detects conflicts and resolves explicitly", async () => {
        const runtime = path.join(project, "runtime/server.properties");
        await writeFile(runtime, "motd=initial\n");
        expect(await result(["config", "list", "--candidates"])).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ relative: "server.properties" }),
            ]),
        );
        await result(["config", "capture", "--initial"]);
        await result(["config", "track", "server.properties"]);
        await writeFile(runtime, "motd=runtime\n");
        expect(await result(["config", "diff"])).toEqual([
            expect.objectContaining({ runtimeChanged: true }),
        ]);
        await result(["config", "capture"]);
        expect(
            await readFile(
                path.join(project, "config/server.properties"),
                "utf8",
            ),
        ).toContain("runtime");
        await writeFile(runtime, "motd=another\n");
        await writeFile(
            path.join(project, "config/server.properties"),
            "motd=base\n",
        );
        expect((await command(["config", "capture"])).code).toBe(3);
        expect(
            (
                await command([
                    "config",
                    "resolve",
                    "server.properties",
                    "--use",
                    "base",
                ])
            ).reply.error?.code,
        ).toBe("CONFIRMATION_REQUIRED");
        await result([
            "config",
            "resolve",
            "server.properties",
            "--use",
            "base",
            "--yes",
        ]);
        expect(
            (await command(["config", "untrack", "server.properties"])).reply
                .error?.code,
        ).toBe("CONFIRMATION_REQUIRED");
        await result(["config", "untrack", "server.properties", "--yes"]);
        expect(await readFile(runtime, "utf8")).toContain("another");
        expect(await result(["config", "list"])).toEqual([]);
    });
    it.each(
        [
            ["config", "track", "missing.yml"],
            ["config", "untrack", "missing.yml"],
            ["config", "resolve", "missing.yml", "--use", "runtime"],
        ].map((args) => ({ args })),
    )(
        "does not modify missing config during preview $args",
        async ({ args }) => {
            await result([...args, "--dry-run"]);
            expect(await result(["config", "list"])).toEqual([]);
        },
    );
    it("previews exact backup inclusion using project-relative rules and excludes JARs", async () => {
        await writeFile(path.join(project, "runtime/data.bin"), "player data");
        await writeFile(
            path.join(project, "runtime/server.jar"),
            "downloadable",
        );
        const plan = (await result(["backup", "plan"])) as {
            files: { source: string }[];
        };
        expect(plan.files.map((file) => file.source)).toEqual([
            path.join(project, "runtime/data.bin"),
        ]);
        await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("previews repository setup without creating a destination or recording password values", async () => {
        const destination = path.join(root, "repo");
        const preview = await result([
            "backup",
            "setup",
            "main",
            "--path",
            destination,
            "--password-env",
            "TEST_PASSWORD",
            "--init",
            "--dry-run",
        ]);
        expect(preview).toMatchObject({
            alias: "main",
            path: destination,
            initialize: true,
        });
        await expect(stat(destination)).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.each([
        [
            [
                "backup",
                "setup",
                "--path",
                "relative",
                "--password-env",
                "P",
                "--dry-run",
            ],
            "BACKUP_ABSOLUTE",
        ],
        [
            [
                "backup",
                "setup",
                "--password-file",
                "file",
                "--password-env",
                "P",
            ],
            "PASSWORD_REFERENCE",
        ],
        [["backup", "setup", "--yes"], "INPUT_REQUIRED"],
        [["backup", "create"], "BACKUP_REQUIRED"],
        [["backup", "list"], "BACKUP_REQUIRED"],
        [["backup", "check"], "BACKUP_REQUIRED"],
        [
            ["backup", "restore", "12345678", "--to", "/tmp/unused"],
            "BACKUP_REQUIRED",
        ],
        [["tools", "prepare", "unknown"], "TOOL_UNKNOWN"],
        [["console"], "CONSOLE_TTY"],
        [["command", "bad\ncommand"], "COMMAND_INVALID"],
        [["logs", "--lines", "0"], "LOG_LINES"],
    ] as const)("fails safely for %j", async (args, code) => {
        expect((await command([...args])).reply.error?.code).toBe(code);
    });
    it("reads logs and previews commands and tool preparation without launching processes", async () => {
        expect(await result(["logs"])).toBe("");
        expect(await result(["command", "say hello", "--dry-run"])).toEqual({
            sent: false,
        });
        expect(
            await result(["tools", "prepare", "restic", "--dry-run"]),
        ).toMatchObject({ tool: "restic", action: "prepare" });
        expect(await result(["cache", "info"])).toMatchObject({
            bytes: 0,
            entries: [],
        });
        expect(await result(["cache", "verify"])).toMatchObject({
            entries: [],
        });
        expect(await result(["cache", "prune"])).toMatchObject({
            applied: false,
            candidates: [],
        });
        expect(
            (await command(["cache", "prune", "--apply"])).reply.error?.code,
        ).toBe("CONFIRMATION_REQUIRED");
    });
});

describe("workspace selection through the CLI", () => {
    it("filters names without modifying nonselected lock entries", async () => {
        await result(["workspace", "init", "servers/*"], root);
        for (const name of ["alpha", "beta"])
            await initProject(path.join(root, "servers", name), {
                name,
                kind: "paper",
                version: "1.21.11",
                source: `file:${path.join(root, "server.jar")}`,
            });
        expect(await result(["workspace", "list"], root)).toHaveLength(2);
        await result(["-r", "install", "--offline"], root);
        const locked = await readLock(root);
        await result(
            ["--filter", "alpha", "update", "--server", "--offline"],
            root,
        );
        expect((await readLock(root)).projects["servers/beta"]).toEqual(
            locked.projects["servers/beta"],
        );
        const statuses = await result(
            ["--filter", "alpha", "--filter", "beta", "status"],
            root,
        );
        expect(statuses).toHaveLength(2);
        expect(
            (await command(["--filter", "missing", "list"], root)).reply.error
                ?.code,
        ).toBe("EMPTY_SELECTION");
        expect(await result(["-r", "stop", "--dry-run"], root)).toHaveLength(2);
        expect(
            (await command(["-r", "config", "list"], root)).reply.error?.code,
        ).toBe("SINGLE_PROJECT");
    });
    it("refuses partial shared-data recovery groups before stopping anything", async () => {
        await result(["workspace", "init", "servers/*"], root);
        for (const name of ["alpha", "beta"]) {
            const directory = path.join(root, "servers", name);
            const manifest = await initProject(directory, {
                name,
                kind: "paper",
                version: "1.21.11",
            });
            await writeYaml(path.join(directory, "craflet.yaml"), {
                ...manifest,
                backup: { ...manifest.backup, group: "shared" },
            });
        }
        expect(
            (await command(["--filter", "alpha", "backup", "create"], root))
                .reply.error?.code,
        ).toBe("BACKUP_GROUP_PARTIAL");
        expect(
            (await command(["--filter", "alpha", "start"], root)).reply.error
                ?.code,
        ).toBe("BACKUP_GROUP_PARTIAL");
        expect(
            await result(["--filter", "alpha", "status"], root),
        ).toHaveLength(1);
    });
});

describe("CLI routing to backup and lifecycle ports", () => {
    it("requests graceful stop when foreground startup is cancelled, without reverting active", async () => {
        vi.spyOn(NodeDeploymentManager.prototype, "start").mockImplementation(
            async () => {
                process.emit("SIGINT");
                throw new DOMException("Cancelled", "AbortError");
            },
        );
        vi.spyOn(NodeServerController.prototype, "status").mockResolvedValue({
            status: "starting",
        });
        const stop = vi
            .spyOn(NodeServerController.prototype, "stop")
            .mockResolvedValue({ status: "stopped", clean: true });
        const execution = await command(["run"]);
        expect(execution.code).toBe(130);
        expect(execution.reply.error?.code).toBe("CANCELLED");
        expect(stop).toHaveBeenCalledWith();
    });
    it("detaches log following on early Ctrl-C without stopping the server", async () => {
        const stop = vi.spyOn(NodeServerController.prototype, "stop");
        const execution = command(["logs", "--follow"]);
        queueMicrotask(() => process.emit("SIGINT"));
        expect((await execution).reply.result).toMatchObject({
            detached: true,
        });
        expect(stop).not.toHaveBeenCalled();
    });
    it("ends foreground following when the server has exited", async () => {
        vi.spyOn(NodeDeploymentManager.prototype, "start").mockResolvedValue({
            status: "running",
        });
        const stop = vi.spyOn(NodeServerController.prototype, "stop");
        expect(await result(["run", "--active"])).toEqual({
            detached: false,
            status: { status: "stopped" },
        });
        expect(stop).not.toHaveBeenCalled();
    });
    async function configured() {
        const context = await loadProject(project, home);
        await writeYaml(path.join(project, "craflet.yaml"), {
            ...context.manifest,
            backup: { ...context.manifest.backup, repository: "main" },
        });
        await mkdir(home, { recursive: true });
        await writeFile(
            path.join(home, "repositories.json"),
            JSON.stringify({
                main: {
                    path: path.join(root, "repository"),
                    id: "a".repeat(64),
                    password: { env: "BACKUP_PASSWORD" },
                },
            }),
        );
        const metadata: BackupMetadata = {
            format: 1,
            projectId: context.manifest.id ?? "fixture",
            createdAt: new Date().toISOString(),
            active: { installation: null },
            roots: [],
            files: [],
            databases: [],
        };
        const prepare = vi
            .spyOn(NodeBackupService.prototype, "prepare")
            .mockResolvedValue({ path: "unused-restic", version: "test" });
        return { metadata, prepare };
    }
    it("routes explicit snapshot IDs, offline, read-data and restore destinations to the backup port", async () => {
        const { metadata, prepare } = await configured();
        const list = vi
            .spyOn(NodeBackupService.prototype, "list")
            .mockResolvedValue([]);
        const show = vi
            .spyOn(NodeBackupService.prototype, "show")
            .mockResolvedValue(metadata);
        const diff = vi
            .spyOn(NodeBackupService.prototype, "diff")
            .mockResolvedValue([{ changed: "runtime/data" }]);
        const check = vi
            .spyOn(NodeBackupService.prototype, "check")
            .mockResolvedValue({ checked: true });
        const restore = vi
            .spyOn(NodeBackupService.prototype, "restore")
            .mockImplementation(async (snapshotId, options) => ({
                snapshotId,
                target: options.target,
                metadata,
            }));
        const plan = vi
            .spyOn(NodeBackupService.prototype, "planRestore")
            .mockImplementation(async (snapshotId, options) => ({
                snapshotId,
                target: options.target,
                metadata,
                dataBytes: 1,
                archiveBytes: 2,
                requiredBytes: 3,
            }));
        expect(
            await result([
                "backup",
                "list",
                "--repository",
                "main",
                "--offline",
            ]),
        ).toEqual([]);
        expect(list).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenLastCalledWith({
            offline: true,
            signal: expect.any(AbortSignal),
        });
        expect(await result(["backup", "show", "12345678"])).toEqual(metadata);
        expect(show).toHaveBeenCalledWith("12345678", {
            signal: expect.any(AbortSignal),
        });
        expect(
            await result(["backup", "diff", "12345678", "23456789"]),
        ).toEqual([{ changed: "runtime/data" }]);
        expect(diff).toHaveBeenCalledWith("12345678", "23456789", {
            signal: expect.any(AbortSignal),
        });
        await result(["backup", "check", "--read-data"]);
        expect(check).toHaveBeenCalledWith({
            readData: true,
            signal: expect.any(AbortSignal),
        });
        await result([
            "backup",
            "restore",
            "12345678",
            "--to",
            "restored",
            "--dry-run",
        ]);
        expect(plan).toHaveBeenCalledWith("12345678", {
            target: path.join(project, "restored"),
            signal: expect.any(AbortSignal),
        });
        expect(restore).not.toHaveBeenCalled();
        await result(["backup", "restore", "12345678", "--to", "restored"]);
        expect(restore).toHaveBeenCalledWith("12345678", {
            target: path.join(project, "restored"),
            signal: expect.any(AbortSignal),
        });
    });
    it("defaults retention to preview and cannot use --yes to override --dry-run", async () => {
        await configured();
        const prune = vi
            .spyOn(NodeBackupService.prototype, "prune")
            .mockImplementation(async (options) => ({
                applied: options?.apply ?? false,
                plan: [],
            }));
        expect(await result(["backup", "prune"])).toMatchObject({
            applied: false,
        });
        expect(
            (await command(["backup", "prune", "--apply"])).reply.error?.code,
        ).toBe("CONFIRMATION_REQUIRED");
        await result(["backup", "prune", "--apply", "--yes", "--dry-run"]);
        expect(prune).toHaveBeenLastCalledWith({
            apply: false,
            confirm: false,
            signal: expect.any(AbortSignal),
        });
        await result(["backup", "prune", "--apply", "--yes"]);
        expect(prune).toHaveBeenLastCalledWith({
            apply: true,
            confirm: true,
            signal: expect.any(AbortSignal),
        });
    });
    it("creates a cold snapshot of a stopped project without starting it", async () => {
        const { metadata } = await configured();
        vi.spyOn(NodeBackupService.prototype, "preflight").mockResolvedValue({
            roots: [],
            files: [],
            bytes: 0,
            stagingBytes: 0,
            databaseIds: [],
            warnings: [],
        });
        const create = vi
            .spyOn(NodeBackupService.prototype, "create")
            .mockResolvedValue({
                snapshotId: "a".repeat(64),
                repository: "main",
                fileCount: 0,
                bytes: 0,
                metadata,
            });
        const start = vi.spyOn(NodeServerController.prototype, "start");
        expect(
            await result(["backup", "create", "--leave-stopped"]),
        ).toMatchObject({
            resumed: false,
            backup: { snapshotId: "a".repeat(64) },
        });
        expect(create).toHaveBeenCalledWith(
            { installation: null },
            { signal: expect.any(AbortSignal) },
        );
        expect(start).not.toHaveBeenCalled();
        await result(["backup", "create", "--dry-run"]);
        expect(create).toHaveBeenCalledTimes(1);
    });
    it("registers a password file reference without reading it into CLI output", async () => {
        const { prepare } = await configured();
        const setup = vi
            .spyOn(NodeBackupService.prototype, "setup")
            .mockResolvedValue({
                alias: "secondary",
                path: path.join(root, "secondary"),
                id: "b".repeat(64),
            });
        await result([
            "backup",
            "setup",
            "secondary",
            "--path",
            path.join(root, "secondary"),
            "--password-file",
            "private-password",
            "--yes",
            "--offline",
        ]);
        expect(prepare).toHaveBeenLastCalledWith({ offline: true });
        expect(setup).toHaveBeenCalledWith("secondary", {
            initialize: false,
            confirm: true,
        });
        expect(
            await readFile(path.join(home, "repositories.json"), "utf8"),
        ).toContain("private-password");
    });
    it.each(
        ["wrong", "external=relative", "__proto__=/tmp/no"].map((mapping) => ({
            mapping,
        })),
    )(
        "rejects unsafe restore mappings before production writes: $mapping",
        async ({ mapping }) => {
            await configured();
            expect(
                (
                    await command([
                        "backup",
                        "apply",
                        "missing",
                        "--map",
                        mapping,
                        "--dry-run",
                    ])
                ).reply.ok,
            ).toBe(false);
        },
    );
    it("distinguishes per-server partial failures from declaration failures", async () => {
        await result(["workspace", "init", "servers/*"], root);
        for (const name of ["alpha", "beta"])
            await initProject(path.join(root, "servers", name), {
                name,
                kind: "velocity",
                version: "4.1.1",
            });
        vi.spyOn(NodeDeploymentManager.prototype, "restart").mockImplementation(
            async function (this: NodeDeploymentManager) {
                if (this.context.manifest.name === "beta")
                    throw new CrafletError(
                        "STOP_TIMEOUT",
                        "Stop was not confirmed.",
                        3,
                    );
                return { status: "running" };
            },
        );
        const execution = await command(["-r", "restart"], root);
        expect(execution.code).toBe(4);
        expect(execution.reply.result).toEqual([
            expect.objectContaining({ project: "alpha" }),
            expect.objectContaining({ ok: false, code: "STOP_TIMEOUT" }),
        ]);
        vi.spyOn(NodeDeploymentManager.prototype, "stop").mockImplementation(
            async function (this: NodeDeploymentManager) {
                if (this.context.manifest.name === "beta")
                    throw new Error("do-not-print-this-secret");
                return { status: "stopped" };
            },
        );
        const stopped = await command(["-r", "stop"], root);
        expect(stopped.code).toBe(4);
        expect(stopped.output).not.toContain("do-not-print-this-secret");
    });
    it("dispatches full-group start, deployment and backup while rejecting partial group apply", async () => {
        await configured();
        await result(["workspace", "init", "servers/*"], root);
        for (const name of ["alpha", "beta"]) {
            const directory = path.join(root, "servers", name);
            const manifest = await initProject(directory, {
                name,
                kind: "velocity",
                version: "4.1.1",
            });
            await writeYaml(path.join(directory, "craflet.yaml"), {
                ...manifest,
                backup: {
                    ...manifest.backup,
                    repository: "main",
                    group: "shared",
                },
            });
        }
        const operate = vi
            .spyOn(NodeRecoveryGroup.prototype, "operate")
            .mockResolvedValue({ completed: true });
        const create = vi
            .spyOn(NodeRecoveryGroup.prototype, "createBackup")
            .mockResolvedValue({ backup: {}, resumed: [] });
        vi.spyOn(NodeBackupService.prototype, "list").mockResolvedValue([]);
        await result(["-r", "start", "--active"], root);
        expect(operate).toHaveBeenCalledWith("start", true, false);
        await result(["-r", "deploy", "apply", "--dry-run"], root);
        expect(operate).toHaveBeenCalledWith("apply", false, true);
        await result(["-r", "backup", "create", "--leave-stopped"], root);
        expect(create).toHaveBeenCalledWith(true, false);
        expect(
            (
                await command(
                    [
                        "--filter",
                        "alpha",
                        "backup",
                        "apply",
                        "missing",
                        "--dry-run",
                    ],
                    root,
                )
            ).reply.error?.code,
        ).toBe("BACKUP_GROUP_PARTIAL");
        expect((await command(["-r", "backup", "list"], root)).reply.ok).toBe(
            true,
        );
    });
    it("fails on absent project and renders unexpected adapter errors without raw values", async () => {
        expect((await command(["status"], root)).reply.error?.code).toBe(
            "NO_PROJECT",
        );
        const { prepare } = await configured();
        prepare.mockRejectedValue(new Error("do-not-print-this-secret"));
        const execution = await command(["backup", "list"]);
        expect(execution.code).toBe(1);
        expect(execution.output).not.toContain("do-not-print-this-secret");
    });
});
