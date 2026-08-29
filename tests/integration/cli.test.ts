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
    NodeArtifactStore,
    NodeBackupService,
    NodeDeploymentManager,
    NodeRecoveryGroup,
    NodeServerController,
    readLock,
    readState,
    saveState,
    writeYaml,
} from "@craflet/adapters";
import {
    type BackupMetadata,
    CrafletError,
    type LockedArtifact,
    parseSource,
    stableStringify,
} from "@craflet/core";
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

interface WorkspaceProjectSpec {
    name: string;
    group?: string;
    repository?: string;
}

async function initializeWorkspaceProjects(
    specs: readonly WorkspaceProjectSpec[],
): Promise<void> {
    await result(["workspace", "init", "servers/*"], root);
    for (const spec of specs) {
        const directory = path.join(root, "servers", spec.name);
        const manifest = await initProject(directory, {
            name: spec.name,
            kind: "velocity",
            version: "4.1.1",
        });
        if (spec.group || spec.repository)
            await writeYaml(path.join(directory, "craflet.yaml"), {
                ...manifest,
                backup: {
                    ...manifest.backup,
                    ...(spec.group ? { group: spec.group } : {}),
                    ...(spec.repository ? { repository: spec.repository } : {}),
                },
            });
    }
}

describe("CLI usage and package-style project management", () => {
    it("does not interpret positional text after -- as a global option", async () => {
        output = "";
        errors = "";
        process.exitCode = 0;

        await runCli(["--", "--json"], entryUrl);

        expect(Number(process.exitCode)).toBe(2);
        expect(output).toBe("");
        expect(errors).toContain("Error [CLI_USAGE]");
    });

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

    it.each([
        {
            kind: "paper",
            version: "1.21.11",
            source: "velocity:3.4.0@20",
        },
        {
            kind: "velocity",
            version: "3.4.0",
            source: "paper:1.21.11@200",
        },
    ] as const)(
        "rejects a mismatched explicit source for $kind init without project or EULA files",
        async ({ kind, version, source }) => {
            const target = path.join(root, `mismatched-${kind}`);
            const execution = await command([
                "init",
                target,
                "--name",
                `mismatched-${kind}`,
                "--type",
                kind,
                "--version",
                version,
                "--source",
                source,
                "--yes",
            ]);

            expect(execution.reply.error?.code).toBe("SERVER_PLATFORM");
            await expect(
                stat(path.join(target, "craflet.yaml")),
            ).rejects.toMatchObject({ code: "ENOENT" });
            await expect(
                stat(path.join(home, "eula.json")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        },
    );

    it("remembers explicit Paper EULA consent for this host user during init", async () => {
        const rejected = path.join(root, "paper-rejected");
        const failure = await command([
            "init",
            rejected,
            "--name",
            "paper-rejected",
            "--type",
            "paper",
            "--version",
            "1.21.11",
        ]);
        expect(failure.code).toBe(3);
        expect(failure.reply.error?.code).toBe("CONFIRMATION_REQUIRED");
        await expect(
            stat(path.join(rejected, "craflet.yaml")),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(stat(path.join(home, "eula.json"))).rejects.toMatchObject({
            code: "ENOENT",
        });

        const accepted = path.join(root, "paper-accepted");
        await result([
            "init",
            accepted,
            "--name",
            "paper-accepted",
            "--type",
            "paper",
            "--version",
            "1.21.11",
            "--yes",
        ]);
        expect(
            JSON.parse(await readFile(path.join(home, "eula.json"), "utf8")),
        ).toMatchObject({
            schemaVersion: 1,
            accepted: true,
            url: "https://www.minecraft.net/eula",
        });
        await expect(
            stat(path.join(accepted, "runtime/eula.txt")),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });

        const remembered = path.join(root, "paper-remembered");
        await result([
            "init",
            remembered,
            "--name",
            "paper-remembered",
            "--type",
            "paper",
            "--version",
            "1.21.11",
        ]);
        await expect(
            stat(path.join(remembered, "runtime/eula.txt")),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it.each(["start", "restart"] as const)(
        "passes the EULA interaction to %s launches",
        async (action) => {
            const launch = vi
                .spyOn(NodeDeploymentManager.prototype, action)
                .mockImplementation(async function (
                    this: NodeDeploymentManager,
                ) {
                    expect(this.options.requestEulaConsent).toBeTypeOf(
                        "function",
                    );
                    await this.options.requestEulaConsent?.({
                        path: path.join(project, "runtime/eula.txt"),
                        text: "eula=false\n",
                        url: "https://www.minecraft.net/eula",
                    });
                    return { status: "running" };
                });
            const failure = await command([action]);
            expect(failure.code).toBe(3);
            expect(failure.reply.error?.code).toBe("CONFIRMATION_REQUIRED");
            expect(await result([action, "--yes"])).toEqual([
                { project: "example", result: { status: "running" } },
            ]);
            expect(launch).toHaveBeenCalledTimes(2);
        },
    );

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
            ["plugins"],
            ["server"],
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
            ["inspect", "Example.jar"],
            ["add", "file:Example.jar"],
            ["remove", "Example"],
            ["list"],
            ["outdated"],
            ["update"],
            ["plugins", "list"],
            ["plugins", "outdated"],
            ["plugins", "add"],
            ["init", "--type", "fabric"],
            ["config", "resolve", "x.yml"],
            ["plugins", "update", "--to", "2"],
            ["plugins", "update", "A", "B", "--to", "2"],
            ["plugins", "update", "A", "--to", ""],
            ["server", "update", "A", "--to", "2"],
            ["server", "update", "--to", ""],
        ].map((args) => ({ args })),
    )("returns a usage error for $args", async ({ args }) => {
        const execution = await command(args);
        expect(execution.code).toBe(2);
        expect(execution.reply.ok).toBe(false);
        expect(execution.reply.error?.code).toBe("CLI_USAGE");
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
        expect(await result(["plugins"])).toEqual([
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
    it("prints human-facing results by default and preserves explicit JSON", async () => {
        const status = await command(["status"], project, false);
        expect(status.code).toBe(0);
        expect(status.output).toBe("Server: stopped\n");
        expect(status.output).not.toContain("{");

        const json = await command(["status"], project, true);
        expect(json.output).toBe(
            `${JSON.stringify({ ok: true, result: { status: "stopped" } })}\n`,
        );

        const target = path.join(root, "human-output");
        const initialized = await command(
            [
                "init",
                target,
                "--name",
                "human-output",
                "--type",
                "velocity",
                "--version",
                "4.1.1",
                "--source",
                `file:${path.join(root, "server.jar")}`,
            ],
            root,
            false,
        );
        expect(initialized.output).toContain(
            'Created Velocity server "human-output"',
        );
        expect(initialized.output).toContain("Next: Review craflet.yaml");
        expect(initialized.output).not.toContain('"directory"');
    });

    it("explains plugin pending and update state without raw JSON", async () => {
        const plugin = path.join(root, "Example.jar");
        const added = await command(
            ["plugins", "add", `file:${plugin}`, "--offline"],
            project,
            false,
        );
        expect(added.output).toContain(
            "Added plugins and prepared 1 pending installation.",
        );
        expect(added.output).toContain("Running JARs were not replaced.");

        const before = await command(["plugins"], project, false);
        expect(before.output).toContain(
            "Example: requested local file | active - | pending 1.0 | locked 1.0",
        );
        expect(before.output).not.toContain("{");

        await writeFile(plugin, artifactJar("Example", "2.0"));
        const checked = await command(
            ["plugins", "check", "Example", "--offline"],
            project,
            false,
        );
        expect(checked.output).toContain("local JAR locked at 1.0");
        const updated = await command(
            ["plugins", "update", "Example", "--offline"],
            project,
            false,
        );
        expect(updated.output).toContain(
            "Resolved updates and prepared 1 pending installation.",
        );
        expect(updated.output).toContain("declared plugins: Example");
        const after = await command(["plugins"], project, false);
        expect(after.output).toContain(
            "Example: requested local file | active - | pending 2.0 | locked 2.0",
        );
    });

    it("rejects global plugin declaration key collisions before grouped latest checks", async () => {
        const configured = await loadProject(project, home);
        await writeYaml(path.join(project, "craflet.yaml"), {
            ...configured.manifest,
            plugins: {
                Foo: "modrinth:foo@1.0",
                foo: "modrinth:foo@1.0",
            },
        });
        const latest = vi
            .spyOn(NodeArtifactStore.prototype, "latest")
            .mockRejectedValue(new Error("Provider should not run."));

        for (const args of [
            ["plugins", "--latest"],
            ["plugins", "check", "Foo"],
        ]) {
            const execution = await command(args);
            expect(execution.reply.error?.code).toBe("DUPLICATE_PLUGIN");
        }
        expect(latest).not.toHaveBeenCalled();
    });

    it("sanitizes human log tails without changing JSON string results", async () => {
        await mkdir(path.join(project, ".craflet"), { recursive: true });
        const log = "line\tvalue\n\u001b]52;c;payload\u0007\rend   \n\n";
        await writeFile(path.join(project, ".craflet/server.log"), log);

        const human = await command(["logs"], project, false);
        expect(human.output).toBe("line\tvalue\n?]52;c;payload??end   \n\n");
        expect(human.output).not.toContain("\u001b");

        const json = await command(["logs"], project, true);
        expect(json.output).toBe(
            `${JSON.stringify({ ok: true, result: log.slice(0, -1) })}\n`,
        );
        expect(json.reply.result).toBe(log.slice(0, -1));
    });
});

describe("CLI artifact and pending contracts", () => {
    it("preserves locked versions while adding provider display labels to update-check JSON", async () => {
        await result([
            "plugins",
            "add",
            `file:${path.join(root, "Example.jar")}`,
            "--offline",
        ]);
        const configured = await loadProject(project, home);
        const pluginSource = {
            provider: "modrinth" as const,
            project: "example",
            version: "opaque-current-id",
        };
        const serverSource = {
            provider: "paper" as const,
            project: "paper" as const,
            version: "1.21.11",
            build: "120",
        };
        await writeYaml(path.join(project, "craflet.yaml"), {
            ...configured.manifest,
            server: { ...configured.manifest.server, source: serverSource },
            plugins: { Example: pluginSource },
        });
        const lock = await readLock(configured.lockRoot);
        const locked = lock.projects[configured.lockKey];
        if (!locked) throw new Error("Expected the project lock slice");
        locked.requests.server = stableStringify(serverSource);
        locked.requests.plugins.Example = stableStringify(pluginSource);
        locked.server.source = serverSource;
        locked.server.version = "1.21.11";
        const plugin = locked.plugins.Example;
        if (!plugin) throw new Error("Expected the plugin lock entry");
        plugin.source = pluginSource;
        plugin.version = "Example release 1.0";
        await writeYaml(
            path.join(configured.lockRoot, "craflet-lock.yaml"),
            lock,
        );
        const state = await readState(project);
        if (!state.pending)
            throw new Error("Expected the pending installation state");
        const active = structuredClone(state.pending);
        active.manifest.plugins = {};
        active.lock.plugins = {};
        active.lock.requests.plugins = {};
        active.lock.server = {
            ...locked.server,
            source: { ...serverSource, build: "119" },
        };
        const pending = structuredClone(state.pending);
        pending.lock.server = {
            ...locked.server,
            source: { ...serverSource, build: "121" },
        };
        await saveState(project, { schemaVersion: 1, active, pending });

        const matchingList = await command(["plugins"], project, false);
        expect(matchingList.output).toContain(
            "Example: requested modrinth@Example release 1.0 | active - | pending 1.0 | locked Example release 1.0",
        );
        expect(matchingList.output).not.toContain("opaque-current-id");
        expect(matchingList.output).not.toContain(root);

        await writeYaml(path.join(project, "craflet.yaml"), {
            ...configured.manifest,
            server: { ...configured.manifest.server, source: serverSource },
            plugins: {
                Example: {
                    ...pluginSource,
                    version: "opaque-stale-request",
                },
            },
        });
        const staleList = await command(["plugins"], project, false);
        expect(staleList.output).toContain(
            "Example: requested modrinth | active - | pending 1.0 | locked Example release 1.0",
        );
        expect(staleList.output).not.toContain("opaque-stale-request");
        expect(staleList.output).not.toContain("opaque-current-id");
        expect(staleList.output).not.toContain(root);

        await writeYaml(path.join(project, "craflet.yaml"), {
            ...configured.manifest,
            server: { ...configured.manifest.server, source: serverSource },
            plugins: {},
        });
        const pendingOnlyList = await command(["plugins"], project, false);
        expect(pendingOnlyList.output).toContain(
            "Example: requested not declared | active - | pending 1.0 | locked Example release 1.0",
        );
        expect(pendingOnlyList.output).not.toContain("none declared");

        await writeYaml(path.join(project, "craflet.yaml"), {
            ...configured.manifest,
            server: { ...configured.manifest.server, source: serverSource },
            plugins: { Example: pluginSource },
        });
        vi.spyOn(NodeArtifactStore.prototype, "latest").mockImplementation(
            async (input) => {
                const source = parseSource(input);
                return source.provider === "paper"
                    ? {
                          source: { ...source, build: "121" },
                          version: "121",
                      }
                    : {
                          source: {
                              ...pluginSource,
                              version: "opaque-next-id",
                          },
                          version: "Example release 2.0",
                      };
            },
        );

        expect(await result(["plugins", "--latest"])).toEqual([
            expect.objectContaining({
                project: "example",
                plugins: [
                    expect.objectContaining({
                        name: "Example",
                        latest: "Example release 2.0",
                        status: "update-available",
                    }),
                ],
            }),
        ]);
        const pluginInventory = await command(
            ["plugins", "--latest"],
            project,
            false,
        );
        expect(pluginInventory.output).toContain(
            "latest Example release 2.0 (update available)",
        );
        expect(pluginInventory.output).not.toContain("opaque-next-id");

        expect(await result(["server", "--latest"])).toEqual([
            expect.objectContaining({
                project: "example",
                server: expect.objectContaining({
                    locked: "120",
                    active: "119",
                    pending: "121",
                    latest: "121",
                    status: "update-available",
                }),
            }),
        ]);
        const serverInventory = await command(
            ["server", "--latest"],
            project,
            false,
        );
        expect(serverInventory.output).toContain(
            "Server: requested paper 1.21.11 build 120",
        );
        expect(serverInventory.output).toContain(
            "locked 120 | active 119 | pending 121",
        );
        expect(serverInventory.output).toContain(
            "latest 121 (update available)",
        );

        await writeYaml(path.join(project, "craflet.yaml"), {
            ...configured.manifest,
            server: {
                type: "paper",
                version: "1.21.11",
                build: "121",
            },
            plugins: { Example: pluginSource },
        });
        const staleServer = await command(["server"], project, false);
        expect(staleServer.output).toContain(
            "Server: requested paper 1.21.11 build 121 | locked 120",
        );

        const pluginExpected = [
            {
                project: "example",
                updates: [
                    {
                        kind: "provider",
                        name: "Example",
                        lockedVersion: "Example release 1.0",
                        latestSource: "modrinth:example@opaque-next-id",
                        latestVersion: "Example release 2.0",
                        updateAvailable: true,
                    },
                ],
            },
        ];
        const pluginResult = await command(["plugins", "check", "Example"]);
        expect(pluginResult.reply.result).toEqual(pluginExpected);
        expect(pluginResult.output).toBe(
            `${JSON.stringify({ ok: true, result: pluginExpected })}\n`,
        );

        const serverExpected = [
            {
                project: "example",
                updates: [
                    {
                        kind: "provider",
                        name: "server",
                        lockedVersion: "120",
                        latestSource: "paper:1.21.11@121",
                        latestVersion: "121",
                        updateAvailable: true,
                    },
                ],
            },
        ];
        const serverResult = await command(["server", "check"]);
        expect(serverResult.reply.result).toEqual(serverExpected);
        expect(serverResult.output).toBe(
            `${JSON.stringify({ ok: true, result: serverExpected })}\n`,
        );
    });

    it("inspects, adds, locks, updates, removes and discards without touching runtime JARs", async () => {
        const plugin = path.join(root, "Example.jar");
        expect(await result(["plugins", "inspect", plugin])).toMatchObject({
            id: "Example",
            format: "bukkit",
        });
        await result(["plugins", "add", `file:${plugin}`, "--offline"]);
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
        expect(
            await result(["plugins", "check", "Example", "--offline"]),
        ).toEqual([
            expect.objectContaining({
                updates: [expect.objectContaining({ kind: "local" })],
            }),
        ]);
        await result(["plugins", "update", "Example", "--offline"]);
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
        await result(["plugins", "remove", "Example", "--offline"]);
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
            (await command(["plugins", "remove", "Missing", "--offline"])).reply
                .error?.code,
        ).toBe("PLUGIN_UNKNOWN");
        expect(
            (await command(["install", "--frozen-lockfile", "--offline"])).reply
                .error?.code,
        ).toBe("FROZEN_LOCK");
        await result([
            "plugins",
            "add",
            `file:${path.join(root, "Example.jar")}`,
            "--offline",
        ]);
        expect(
            (
                await command([
                    "plugins",
                    "add",
                    `file:${path.join(root, "Example.jar")}`,
                    "--offline",
                ])
            ).reply.error?.code,
        ).toBe("PLUGIN_EXISTS");
        expect(
            (await command(["plugins", "check", "Missing", "--offline"])).reply
                .error?.code,
        ).toBe("PLUGIN_UNKNOWN");
    });
    it.each(
        [
            ["install"],
            ["plugins", "add", "modrinth:example@latest"],
            ["plugins", "update"],
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
        expect(await result(["console", "--dry-run"])).toEqual({
            status: "stopped",
        });
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
            ["--filter", "alpha", "server", "update", "--offline"],
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
            (await command(["--filter", "missing", "plugins"], root)).reply
                .error?.code,
        ).toBe("EMPTY_SELECTION");
        expect(await result(["-r", "stop", "--dry-run"], root)).toHaveLength(2);
        expect(
            (await command(["-r", "config", "list"], root)).reply.error?.code,
        ).toBe("SINGLE_PROJECT");
    });
    it("preflights recursive artifact checks before provider requests", async () => {
        await result(["workspace", "init", "servers/*"], root);
        const alphaDir = path.join(root, "servers", "alpha");
        const betaDir = path.join(root, "servers", "beta");
        const alpha = await initProject(alphaDir, {
            name: "alpha",
            kind: "velocity",
            version: "4.1.1",
        });
        const beta = await initProject(betaDir, {
            name: "beta",
            kind: "velocity",
            version: "4.1.1",
        });
        alpha.plugins.Example = "modrinth:example@1";
        await writeYaml(path.join(alphaDir, "craflet.yaml"), alpha);
        await writeYaml(path.join(betaDir, "craflet.yaml"), beta);
        const latest = vi
            .spyOn(NodeArtifactStore.prototype, "latest")
            .mockRejectedValue(new Error("Provider preflight failed."));

        expect(
            (await command(["-r", "plugins", "check", "Example"], root)).reply
                .error?.code,
        ).toBe("PLUGIN_UNKNOWN");
        expect(latest).not.toHaveBeenCalled();

        beta.plugins.Broken = "not-a-source";
        await writeYaml(path.join(betaDir, "craflet.yaml"), beta);
        expect(
            (await command(["-r", "plugins", "--latest"], root)).reply.error
                ?.code,
        ).toBe("INVALID_SOURCE");
        expect(latest).not.toHaveBeenCalled();

        beta.server.source = "not-a-source";
        await writeYaml(path.join(betaDir, "craflet.yaml"), beta);
        for (const args of [
            ["-r", "server", "check"],
            ["-r", "server", "--latest"],
        ]) {
            expect((await command(args, root)).reply.error?.code).toBe(
                "INVALID_SOURCE",
            );
            expect(latest).not.toHaveBeenCalled();
        }

        delete beta.plugins.Broken;
        delete beta.server.source;
        await writeYaml(path.join(betaDir, "craflet.yaml"), beta);
        await mkdir(path.join(betaDir, ".craflet"), { recursive: true });
        await writeFile(path.join(betaDir, ".craflet/state.json"), "not-json");
        for (const args of [
            ["-r", "plugins", "--latest"],
            ["-r", "server", "--latest"],
        ]) {
            expect((await command(args, root)).reply.error?.code).toBe(
                "STATE_INVALID",
            );
            expect(latest).not.toHaveBeenCalled();
        }
    });
    it("validates every contextual lock invariant before provider update checks", async () => {
        await result(["workspace", "init", "servers/*"], root);
        for (const name of ["alpha", "beta"]) {
            const directory = path.join(root, "servers", name);
            const manifest = await initProject(directory, {
                name,
                kind: "velocity",
                version: "4.1.1",
                source: `file:${path.join(root, "server.jar")}`,
            });
            manifest.plugins =
                name === "alpha"
                    ? { Alpha: "modrinth:alpha@1" }
                    : {
                          Broken: "modrinth:broken@1",
                          Partner: "modrinth:partner@1",
                      };
            await writeYaml(path.join(directory, "craflet.yaml"), manifest);
        }
        const server = {
            source: parseSource(`file:${path.join(root, "server.jar")}`),
            version: "fixture",
            sha256: "0".repeat(64),
            size: 1,
        };
        const plugin = (id: string): LockedArtifact => ({
            source: parseSource(`modrinth:${id.toLowerCase()}@1`),
            version: "1",
            sha256: "1".repeat(64),
            size: 1,
            identity: {
                id,
                version: "1",
                format: "velocity" as const,
                dependencies: [] as string[],
                optionalDependencies: [] as string[],
                provides: [] as string[],
            },
        });
        const baseLock = {
            lockVersion: 1 as const,
            projects: {
                "servers/alpha": {
                    name: "alpha",
                    requests: {
                        server: "fixture",
                        plugins: { Alpha: "fixture" },
                    },
                    server: structuredClone(server),
                    plugins: { Alpha: plugin("Alpha") },
                },
                "servers/beta": {
                    name: "beta",
                    requests: {
                        server: "fixture",
                        plugins: {
                            Broken: "fixture",
                            Partner: "fixture",
                        },
                    },
                    server: structuredClone(server),
                    plugins: {
                        Broken: plugin("Broken"),
                        Partner: plugin("Partner"),
                    },
                },
            },
        };
        const brokenIdentity = (lock: typeof baseLock) => {
            const identity =
                lock.projects["servers/beta"].plugins.Broken.identity;
            if (!identity) throw new Error("Expected the fixture identity.");
            return identity;
        };
        const corruptions: Array<{
            name: string;
            code: string;
            mutate(lock: typeof baseLock): void;
        }> = [
            {
                name: "missing identity",
                code: "LOCK_IDENTITY",
                mutate(lock) {
                    Reflect.deleteProperty(
                        lock.projects["servers/beta"].plugins.Broken,
                        "identity",
                    );
                },
            },
            {
                name: "identity key mismatch",
                code: "LOCK_IDENTITY",
                mutate(lock) {
                    brokenIdentity(lock).id = "Renamed";
                },
            },
            {
                name: "wrong plugin platform",
                code: "PLUGIN_PLATFORM",
                mutate(lock) {
                    brokenIdentity(lock).format = "bukkit";
                },
            },
            {
                name: "case-insensitive provides collision",
                code: "DUPLICATE_PLUGIN",
                mutate(lock) {
                    brokenIdentity(lock).provides = ["partner"];
                },
            },
            {
                name: "missing required dependency",
                code: "MISSING_PLUGIN_DEPENDENCY",
                mutate(lock) {
                    brokenIdentity(lock).dependencies = ["Required"];
                },
            },
            {
                name: "wrong server source target",
                code: "SERVER_PLATFORM",
                mutate(lock) {
                    lock.projects["servers/beta"].server.source =
                        parseSource("paper:1.21.11@1");
                },
            },
            {
                name: "server source used as a plugin",
                code: "NOT_PLUGIN",
                mutate(lock) {
                    lock.projects["servers/beta"].plugins.Broken.source =
                        parseSource("velocity:4.1.1@1");
                },
            },
        ];
        const latest = vi
            .spyOn(NodeArtifactStore.prototype, "latest")
            .mockRejectedValue(new Error("Provider should not run."));

        for (const corruption of corruptions) {
            const lock = structuredClone(baseLock);
            corruption.mutate(lock);
            await writeYaml(path.join(root, "craflet-lock.yaml"), lock);
            latest.mockClear();

            const execution = await command(["-r", "plugins", "check"], root);

            expect(execution.reply.error?.code, corruption.name).toBe(
                corruption.code,
            );
            expect(latest, corruption.name).not.toHaveBeenCalled();
        }
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
    it("stops a recursive launch immediately after cancellation", async () => {
        await result(["workspace", "init", "servers/*"], root);
        for (const name of ["alpha", "beta"])
            await initProject(path.join(root, "servers", name), {
                name,
                kind: "velocity",
                version: "4.1.1",
            });
        const start = vi
            .spyOn(NodeDeploymentManager.prototype, "start")
            .mockRejectedValue(
                new CrafletError("CANCELLED", "Operation cancelled.", 130),
            );
        const execution = await command(["-r", "start"], root);
        expect(execution.code).toBe(130);
        expect(execution.reply.error?.code).toBe("CANCELLED");
        expect(start).toHaveBeenCalledOnce();
    });

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

        await mkdir(path.join(project, ".craflet"), { recursive: true });
        await writeFile(
            path.join(project, ".craflet/server.log"),
            "follow\tline\n\u001b]52;c;payload\u0007\rend\n",
        );
        const humanExecution = command(["logs", "--follow"], project, false);
        queueMicrotask(() => process.emit("SIGINT"));
        const human = await humanExecution;
        expect(human.output).toContain("follow\tline\n?]52;c;payload??end\n");
        expect(human.output).not.toContain("\u001b");
        expect(stop).not.toHaveBeenCalled();
    });
    it("passes EULA consent into foreground run and ends when the server exits", async () => {
        vi.spyOn(NodeDeploymentManager.prototype, "start").mockImplementation(
            async function (this: NodeDeploymentManager) {
                expect(this.options.requestEulaConsent).toBeTypeOf("function");
                await this.options.requestEulaConsent?.({
                    path: path.join(project, "runtime/eula.txt"),
                    text: "eula=false\n",
                    url: "https://www.minecraft.net/eula",
                });
                return { status: "running" };
            },
        );
        const stop = vi.spyOn(NodeServerController.prototype, "stop");
        expect(await result(["run", "--active", "--yes"])).toEqual({
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
            { project: "alpha", result: { status: "running" } },
            {
                project: "beta",
                ok: false,
                code: "STOP_TIMEOUT",
                message: "Stop was not confirmed.",
            },
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
    it("rethrows recursive stop cancellation without touching later projects", async () => {
        await initializeWorkspaceProjects([
            { name: "alpha" },
            { name: "beta" },
            { name: "gamma" },
        ]);
        const stopped: string[] = [];
        vi.spyOn(NodeDeploymentManager.prototype, "stop").mockImplementation(
            async function (this: NodeDeploymentManager) {
                const name = this.context.manifest.name;
                stopped.push(name);
                if (name === "beta")
                    throw new DOMException("Cancelled", "AbortError");
                return { status: "stopped" };
            },
        );

        const execution = await command(["-r", "stop"], root);

        expect(execution.code).toBe(130);
        expect(execution.reply.error?.code).toBe("CANCELLED");
        expect(stopped).toEqual(["alpha", "beta"]);
    });
    it("preserves deploy apply results, sanitizes failures and rethrows cancellation", async () => {
        await initializeWorkspaceProjects([
            { name: "alpha" },
            { name: "beta" },
            { name: "gamma" },
        ]);
        const applied: string[] = [];
        const apply = vi
            .spyOn(NodeDeploymentManager.prototype, "apply")
            .mockImplementation(async function (this: NodeDeploymentManager) {
                const name = this.context.manifest.name;
                applied.push(name);
                if (name === "beta")
                    throw new CrafletError(
                        "DEPLOY_FAILED",
                        "Unsafe\u001b[31m failure\nline",
                        3,
                    );
                return { applied: name };
            });

        const execution = await command(
            ["-r", "deploy", "apply", "--dry-run"],
            root,
        );
        expect(execution.code).toBe(4);
        expect(execution.reply.result).toEqual([
            { project: "alpha", result: { applied: "alpha" } },
            {
                project: "beta",
                ok: false,
                code: "DEPLOY_FAILED",
                message: "Unsafe?[31m failure?line",
            },
            { project: "gamma", result: { applied: "gamma" } },
        ]);
        expect(applied).toEqual(["alpha", "beta", "gamma"]);

        const single = await command(
            ["--filter", "beta", "deploy", "apply", "--dry-run"],
            root,
        );
        expect(single.code).toBe(3);
        expect(single.reply.error?.code).toBe("DEPLOY_FAILED");

        applied.length = 0;
        apply.mockImplementation(async function (this: NodeDeploymentManager) {
            const name = this.context.manifest.name;
            applied.push(name);
            if (name === "beta")
                throw new DOMException("Cancelled", "AbortError");
            return { applied: name };
        });
        const cancelled = await command(
            ["-r", "deploy", "apply", "--dry-run"],
            root,
        );
        expect(cancelled.code).toBe(130);
        expect(cancelled.reply.error?.code).toBe("CANCELLED");
        expect(applied).toEqual(["alpha", "beta"]);
    });
    it("reports a failed recovery group once and continues with independent units", async () => {
        await initializeWorkspaceProjects([
            { name: "alpha" },
            { name: "beta", group: "shared" },
            { name: "charlie", group: "shared" },
            { name: "delta" },
        ]);
        const recovered: string[] = [];
        vi.spyOn(NodeDeploymentManager.prototype, "recover").mockImplementation(
            async function (this: NodeDeploymentManager) {
                recovered.push(this.context.manifest.name);
                return { recovered: false };
            },
        );
        const groupRecover = vi
            .spyOn(NodeRecoveryGroup.prototype, "recover")
            .mockRejectedValue(
                new CrafletError(
                    "GROUP_RECOVERY_FAILED",
                    "Group recovery stopped.",
                    4,
                ),
            );

        const execution = await command(["-r", "recover"], root);
        expect(execution.code).toBe(4);
        expect(execution.reply.result).toEqual([
            expect.objectContaining({ project: "alpha" }),
            expect.objectContaining({ project: "delta" }),
            {
                group: "shared",
                ok: false,
                code: "GROUP_RECOVERY_FAILED",
                message: "Group recovery stopped.",
            },
        ]);
        expect(recovered).toEqual(["alpha", "delta"]);
        expect(groupRecover).toHaveBeenCalledOnce();

        const single = await command(
            ["--filter", "beta", "--filter", "charlie", "recover"],
            root,
        );
        expect(single.code).toBe(4);
        expect(single.reply.error?.code).toBe("GROUP_RECOVERY_FAILED");
        expect(groupRecover).toHaveBeenCalledTimes(2);
    });
    it("drops partial group recovery rows when a later member fails preliminary recovery", async () => {
        await initializeWorkspaceProjects([
            { name: "alpha" },
            { name: "beta", group: "shared" },
            { name: "charlie", group: "shared" },
            { name: "echo", group: "shared" },
            { name: "delta" },
        ]);
        await mkdir(
            path.join(root, "servers", "charlie", ".craflet", "runner.json"),
            { recursive: true },
        );
        await mkdir(path.join(root, ".craflet"), { recursive: true });
        await writeFile(
            path.join(root, ".craflet", "group-restore.json"),
            "{}\n",
        );
        const checked: string[] = [];
        const originalStatus = NodeServerController.prototype.status;
        vi.spyOn(NodeServerController.prototype, "status").mockImplementation(
            async function (this: NodeServerController) {
                checked.push(path.basename(this.projectDir));
                return originalStatus.call(this);
            },
        );
        vi.spyOn(NodeDeploymentManager.prototype, "recover").mockResolvedValue({
            recovered: false,
        });
        const groupRecover = vi
            .spyOn(NodeRecoveryGroup.prototype, "recover")
            .mockResolvedValue(false);

        const execution = await command(["-r", "recover", "--unlock"], root);

        expect(execution.code).toBe(4);
        expect(execution.reply.result).toEqual([
            expect.objectContaining({ project: "alpha" }),
            expect.objectContaining({ project: "delta" }),
            {
                group: "shared",
                ok: false,
                code: "UNKNOWN_PROCESS",
                message:
                    "The runner ownership record is invalid; no locks were removed.",
            },
        ]);
        for (const name of ["beta", "charlie", "echo"])
            expect(execution.reply.result).not.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ project: name }),
                ]),
            );
        expect(checked).toEqual(["alpha", "beta", "delta"]);
        expect(groupRecover).not.toHaveBeenCalled();
    });
    it("preserves successful discards and skips the rest of a failed recovery group", async () => {
        await initializeWorkspaceProjects([
            { name: "alpha" },
            { name: "beta", group: "shared" },
            { name: "charlie", group: "shared" },
            { name: "delta" },
        ]);
        const discarded: string[] = [];
        vi.spyOn(NodeDeploymentManager.prototype, "discard").mockImplementation(
            async function (this: NodeDeploymentManager) {
                const name = this.context.manifest.name;
                discarded.push(name);
                if (name === "beta")
                    throw new CrafletError(
                        "DISCARD_FAILED",
                        "Pending state could not be removed.",
                        4,
                    );
            },
        );

        expect(
            (
                await command(
                    ["--filter", "alpha", "deploy", "discard", "--dry-run"],
                    root,
                )
            ).reply.result,
        ).toEqual({ discarded: ["alpha"] });
        discarded.length = 0;

        const execution = await command(
            ["-r", "deploy", "discard", "--dry-run"],
            root,
        );
        expect(execution.code).toBe(4);
        expect(execution.reply.result).toEqual([
            { discarded: ["alpha", "delta"] },
            {
                group: "shared",
                ok: false,
                code: "DISCARD_FAILED",
                message: "Pending state could not be removed.",
            },
        ]);
        expect(discarded).toEqual(["alpha", "beta", "delta"]);

        discarded.length = 0;
        const single = await command(
            [
                "--filter",
                "beta",
                "--filter",
                "charlie",
                "deploy",
                "discard",
                "--dry-run",
            ],
            root,
        );
        expect(single.code).toBe(4);
        expect(single.reply.error?.code).toBe("DISCARD_FAILED");
        expect(discarded).toEqual(["beta"]);
    });
    it("preserves multi-unit backup results and aborts without retrying a group", async () => {
        await configured();
        await initializeWorkspaceProjects([
            { name: "alpha", repository: "main" },
            { name: "beta", group: "shared", repository: "main" },
            { name: "charlie", group: "shared", repository: "main" },
            { name: "delta", repository: "main" },
        ]);
        const created: string[] = [];
        vi.spyOn(
            NodeDeploymentManager.prototype,
            "createBackup",
        ).mockImplementation(async function (this: NodeDeploymentManager) {
            const name = this.context.manifest.name;
            created.push(name);
            return { backup: { project: name }, resumed: false };
        });
        const groupCreate = vi
            .spyOn(NodeRecoveryGroup.prototype, "createBackup")
            .mockRejectedValue(new Error("do-not-print-backup-secret"));

        const execution = await command(
            ["-r", "backup", "create", "--leave-stopped"],
            root,
        );
        expect(execution.code).toBe(4);
        expect(execution.output).not.toContain("do-not-print-backup-secret");
        expect(execution.reply.result).toEqual([
            {
                project: "alpha",
                result: { backup: { project: "alpha" }, resumed: false },
            },
            {
                group: "shared",
                ok: false,
                code: "OPERATION_FAILED",
                message:
                    "Backup creation failed; inspect this recovery unit with craflet doctor before retrying.",
            },
            {
                project: "delta",
                result: { backup: { project: "delta" }, resumed: false },
            },
        ]);
        expect(created).toEqual(["alpha", "delta"]);
        expect(groupCreate).toHaveBeenCalledOnce();

        const single = await command(
            ["--filter", "beta", "--filter", "charlie", "backup", "create"],
            root,
        );
        expect(single.code).toBe(1);
        expect(single.reply.error?.code).toBe("UNEXPECTED");
        expect(groupCreate).toHaveBeenCalledTimes(2);

        created.length = 0;
        groupCreate.mockRejectedValue(
            new DOMException("Cancelled", "AbortError"),
        );
        const cancelled = await command(
            ["-r", "backup", "create", "--leave-stopped"],
            root,
        );
        expect(cancelled.code).toBe(130);
        expect(cancelled.reply.error?.code).toBe("CANCELLED");
        expect(created).toEqual(["alpha"]);
        expect(groupCreate).toHaveBeenCalledTimes(3);
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
