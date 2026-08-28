import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    loadProject,
    readLock,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import {
    type Installation,
    readState,
} from "../../packages/adapters/src/filesystem/state.js";
import type {
    PluginIdentity,
    ServerKind,
} from "../../packages/core/src/domain/artifacts.js";
import type {
    BackupCreateResult,
    BackupMetadata,
    BackupSnapshot,
} from "../../packages/core/src/domain/backup.js";
import type { ConfigCaptureResult } from "../../packages/core/src/domain/config.js";
import type { ServerStatus } from "../../packages/core/src/ports/runtime.js";
import {
    assertPortReleased,
    cleanupRealSuite,
    cli,
    cliError,
    fileHash,
    initRealProject,
    prepareRealSuite,
    type RealSuite,
    requirePaperEula,
    setupRealBackup,
    withRuntimeRootWriteDenied,
    withUnavailableRepository,
} from "./real-fixtures.js";

let suite: RealSuite;
beforeAll(async () => {
    suite = await prepareRealSuite();
});
afterEach((context) => {
    if (suite && context.task.result?.state === "fail") suite.failed = true;
});
afterAll(async () => cleanupRealSuite(suite));

const originalPlayerState = "fixture-player: original\n";
const changedPlayerState = "fixture-player: changed-after-backup\n";

function pluginData(directory: string, id: string, file: string): string {
    return path.join(directory, "runtime", "plugins", id, file);
}

function pluginJar(directory: string, id: string): string {
    return path.join(directory, "runtime", "plugins", `${id}.jar`);
}

async function waitForStopped(directory: string): Promise<ServerStatus> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const status = await cli<ServerStatus>(suite, directory, ["status"]);
        // OS exit can be visible just before the runner persists its final exit code.
        if (status.status === "stopped" && status.exitCode !== undefined)
            return status;
        await delay(200);
    }
    throw new Error("The disposable Java process did not finish stopping.");
}

async function waitForStopDelay(file: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            if ((await readFile(file, "utf8")) === "delaying\n") return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(30);
    }
    throw new Error(
        "The disposable plugin never entered its controlled stop delay.",
    );
}

describe("real servers through the packaged CLI", () => {
    for (const kind of [
        "paper",
        "velocity",
    ] as const satisfies readonly ServerKind[]) {
        const label = kind === "paper" ? "Paper" : "Velocity";
        it(`${label} stages upgrades, backs up active bytes, and applies restored data with the original plugin`, async () => {
            if (kind === "paper") requirePaperEula();
            const directory = path.join(suite.root, `single-${kind}`);
            const project = await initRealProject(
                suite,
                directory,
                kind,
                `single-${kind}`,
            );
            await setupRealBackup(
                suite,
                directory,
                `single-${kind}`,
                path.join(suite.root, `${kind}-repository`),
            );
            const sources = project.platforms.map((platform) => {
                const source = project.sources[platform];
                if (!source) throw new Error("Missing local fixture source.");
                return `file:${source}`;
            });
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v1;
                const inspected = await cli<PluginIdentity>(suite, directory, [
                    "inspect",
                    plugin.path,
                ]);
                expect(inspected).toMatchObject({
                    id: plugin.id,
                    version: "1.0.0",
                    format: platform,
                });
            }
            await cli(suite, directory, ["--offline", "add", ...sources]);
            const prepared = await readState(directory);
            expect(prepared.active).toBeUndefined();
            expect(prepared.pending?.lock.server.sha256).toBe(
                suite.fixtures.servers[kind].sha256,
            );
            await cli(suite, directory, [
                "--offline",
                "install",
                "--frozen-lockfile",
            ]);

            if (kind === "paper") {
                await cliError(
                    suite,
                    directory,
                    ["--yes", "start"],
                    "EULA_REQUIRED",
                );
                expect(
                    (await cli<ServerStatus>(suite, directory, ["status"]))
                        .status,
                ).toBe("stopped");
                // This is guarded by explicit test-user acceptance, not --yes.
                await writeFile(
                    path.join(directory, "runtime", "eula.txt"),
                    "eula=true\n",
                    "utf8",
                );
            }
            await cli(suite, directory, ["start"]);
            const firstStatus = await cli<ServerStatus>(suite, directory, [
                "status",
            ]);
            expect(firstStatus.status).toBe("running");
            expect(firstStatus.javaPid).toBeGreaterThan(0);
            const active = (await readState(directory)).active;
            expect(active).toBeDefined();
            if (!active)
                throw new Error("No active installation after real startup.");
            const stamps = new Map<string, number>();
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v1;
                const runtimeJar = path.join(
                    directory,
                    "runtime",
                    "plugins",
                    `${plugin.id}.jar`,
                );
                expect(await fileHash(runtimeJar)).toBe(plugin.sha256);
                stamps.set(plugin.id, (await stat(runtimeJar)).mtimeMs);
                expect(
                    await readFile(
                        path.join(
                            directory,
                            "runtime",
                            "plugins",
                            plugin.id,
                            "enabled-version.txt",
                        ),
                        "utf8",
                    ),
                ).toBe("1.0.0\n");
                expect(
                    await readFile(
                        pluginData(
                            directory,
                            plugin.id,
                            "observed-message.txt",
                        ),
                        "utf8",
                    ),
                ).toBe("runtime-generated\n");
                expect(
                    await readFile(
                        pluginData(
                            directory,
                            plugin.id,
                            "observed-player-state.txt",
                        ),
                        "utf8",
                    ),
                ).toBe(originalPlayerState);
            }
            expect(
                await fileHash(path.join(directory, "runtime", "server.jar")),
            ).toBe(suite.fixtures.servers[kind].sha256);
            // Read startup evidence before a console command can push it out
            // of the bounded log tail (Paper's help exceeds 200 lines).
            const logs = await cli<string>(suite, directory, [
                "logs",
                "--lines",
                "200",
            ]);
            expect(logs).toContain("CRAFLET_FIXTURE");
            expect(logs).toMatch(/\bDone \([\d.,]+s\)!/);
            await cli(suite, directory, ["command", "help"]);

            const captured = await cli<ConfigCaptureResult>(suite, directory, [
                "config",
                "capture",
                "--initial",
            ]);
            expect(captured.conflicts).toEqual([]);
            if (kind === "paper") {
                const base = await readFile(
                    path.join(directory, "config", "server.properties"),
                    "utf8",
                );
                const secret = suite.env.CRAFLET_TEST_MANAGEMENT_SECRET;
                if (!secret)
                    throw new Error(
                        "The explicit management fixture secret is missing.",
                    );
                expect(base).toContain("$" + "{secret:TEST_MANAGEMENT_SECRET}");
                expect(base).not.toContain(secret);
            }
            const firstPlatform = project.platforms[0];
            if (!firstPlatform) throw new Error("No fixture plugin.");
            const firstPlugin = suite.fixtures.plugins[firstPlatform].v1;
            const configRelative = `plugins/${firstPlugin.id}/config.yml`;
            await cli(suite, directory, ["config", "track", configRelative]);
            const baseConfig = path.join(directory, "config", configRelative);
            const runtimeConfig = path.join(
                directory,
                "runtime",
                configRelative,
            );
            await writeFile(
                baseConfig,
                (await readFile(baseConfig, "utf8")).replace(
                    "runtime-generated",
                    "declared-by-user",
                ),
                "utf8",
            );
            await writeFile(
                runtimeConfig,
                `${await readFile(runtimeConfig, "utf8")}runtime-only: captured\n`,
                "utf8",
            );
            expect(
                (
                    await cli<ConfigCaptureResult>(suite, directory, [
                        "config",
                        "capture",
                        configRelative,
                    ])
                ).conflicts,
            ).toEqual([]);
            const merged = await readFile(baseConfig, "utf8");
            expect(merged).toContain("declared-by-user");
            expect(merged).toContain("runtime-only: captured");
            expect(await readFile(runtimeConfig, "utf8")).toContain(
                "runtime-generated",
            );

            for (const platform of project.platforms) {
                const source = project.sources[platform];
                if (!source) throw new Error("Missing local source.");
                await copyFile(
                    suite.fixtures.plugins[platform].v2.path,
                    source,
                );
            }
            // Plain install must reproduce the old file hash even after the source changes.
            await cli(suite, directory, [
                "--offline",
                "install",
                "--frozen-lockfile",
            ]);
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v1;
                expect(
                    (await readState(directory)).pending?.lock.plugins[
                        plugin.id
                    ]?.sha256,
                ).toBe(plugin.sha256);
            }
            await cli(suite, directory, ["--offline", "update"]);
            const staged = await readState(directory);
            expect(staged.active?.id).toBe(active.id);
            expect(staged.pending?.id).not.toBe(active.id);
            for (const platform of project.platforms) {
                const previous = suite.fixtures.plugins[platform].v1;
                const next = suite.fixtures.plugins[platform].v2;
                expect(staged.active?.lock.plugins[previous.id]?.sha256).toBe(
                    previous.sha256,
                );
                expect(staged.pending?.lock.plugins[next.id]?.sha256).toBe(
                    next.sha256,
                );
                const runtimeJar = path.join(
                    directory,
                    "runtime",
                    "plugins",
                    `${previous.id}.jar`,
                );
                expect(await fileHash(runtimeJar)).toBe(previous.sha256);
                expect((await stat(runtimeJar)).mtimeMs).toBe(
                    stamps.get(previous.id),
                );
            }

            const withoutPassword: RealSuite = {
                ...suite,
                env: { ...suite.env },
            };
            delete withoutPassword.env.CRAFLET_TEST_BACKUP_PASSWORD;
            await cliError(
                withoutPassword,
                directory,
                ["restart"],
                "BACKUP_SECRET",
            );
            expect(
                await cli<ServerStatus>(suite, directory, ["status"]),
            ).toMatchObject({
                status: "running",
                javaPid: firstStatus.javaPid,
                activeId: active.id,
            });

            const saved = await cli<{
                backup: BackupCreateResult;
                resumed: boolean;
            }>(suite, directory, ["backup", "create"]);
            expect(saved.resumed).toBe(true);
            expect(saved.backup.metadata.active.installation).toMatchObject({
                id: active.id,
            });
            expect(
                (saved.backup.metadata.active.installation as Installation)
                    .lock,
            ).toEqual(active.lock);
            expect(
                saved.backup.metadata.files.every(
                    (file) => !/\.jar$/i.test(file.destination),
                ),
            ).toBe(true);
            expect((await readState(directory)).pending?.id).toBe(
                staged.pending?.id,
            );
            expect((await readState(directory)).active?.id).toBe(active.id);
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v1;
                expect(
                    await readFile(
                        path.join(
                            directory,
                            "runtime",
                            "plugins",
                            plugin.id,
                            "enabled-version.txt",
                        ),
                        "utf8",
                    ),
                ).toBe("1.0.0\n");
            }
            const shown = await cli<BackupMetadata>(suite, directory, [
                "backup",
                "show",
                saved.backup.snapshotId,
            ]);
            expect(shown.active).toEqual(saved.backup.metadata.active);
            const restoredDirectory = path.join(suite.root, `restored-${kind}`);
            await cli(suite, directory, [
                "backup",
                "restore",
                saved.backup.snapshotId,
                "--to",
                restoredDirectory,
            ]);
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v1;
                expect(
                    await readFile(
                        path.join(
                            restoredDirectory,
                            "data",
                            "runtime",
                            "plugins",
                            plugin.id,
                            "saved-version.txt",
                        ),
                        "utf8",
                    ),
                ).toBe("1.0.0\n");
            }
            await expect(
                stat(
                    path.join(
                        restoredDirectory,
                        "data",
                        "runtime",
                        "server.jar",
                    ),
                ),
            ).rejects.toMatchObject({ code: "ENOENT" });
            const restoredWorld = path.join(
                restoredDirectory,
                "data",
                "runtime",
                "world",
                "level.dat",
            );
            const runtimeWorld = path.join(
                directory,
                "runtime",
                "world",
                "level.dat",
            );
            const savedWorldHash =
                kind === "paper" ? await fileHash(restoredWorld) : undefined;
            if (kind === "paper")
                expect((await stat(restoredWorld)).size).toBeGreaterThan(0);

            // A server can rewrite config during the backup's active restart.
            // Refresh the observations explicitly instead of applying a stale pending snapshot.
            expect(
                (
                    await cli<ConfigCaptureResult>(suite, directory, [
                        "config",
                        "capture",
                    ])
                ).conflicts,
            ).toEqual([]);
            await cli(suite, directory, [
                "--offline",
                "install",
                "--frozen-lockfile",
            ]);
            for (const platform of project.platforms) {
                await writeFile(
                    pluginData(
                        directory,
                        suite.fixtures.plugins[platform].v2.id,
                        "player-state.txt",
                    ),
                    changedPlayerState,
                    "utf8",
                );
            }
            await cli(suite, directory, ["restart"]);
            const upgraded = await readState(directory);
            expect(upgraded.pending).toBeUndefined();
            expect(upgraded.active?.id).not.toBe(active.id);
            expect(
                (await cli<ServerStatus>(suite, directory, ["status"])).status,
            ).toBe("running");
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v2;
                expect(
                    await fileHash(
                        path.join(
                            directory,
                            "runtime",
                            "plugins",
                            `${plugin.id}.jar`,
                        ),
                    ),
                ).toBe(plugin.sha256);
                expect(
                    await readFile(
                        path.join(
                            directory,
                            "runtime",
                            "plugins",
                            plugin.id,
                            "enabled-version.txt",
                        ),
                        "utf8",
                    ),
                ).toBe("2.0.0\n");
                expect(
                    await readFile(
                        pluginData(
                            directory,
                            plugin.id,
                            "observed-player-state.txt",
                        ),
                        "utf8",
                    ),
                ).toBe(changedPlayerState);
            }
            expect(
                await readFile(
                    pluginData(
                        directory,
                        firstPlugin.id,
                        "observed-message.txt",
                    ),
                    "utf8",
                ),
            ).toBe("declared-by-user\n");
            if (kind === "paper")
                await cli(suite, directory, ["command", "time set 12345"]);
            await cli(suite, directory, ["stop"]);
            expect(
                await cli<ServerStatus>(suite, directory, ["status"]),
            ).toMatchObject({ status: "stopped", clean: true, exitCode: 0 });
            await assertPortReleased(project.port);
            if (kind === "paper")
                expect(await fileHash(runtimeWorld)).not.toBe(savedWorldHash);
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v2;
                expect(
                    await readFile(
                        path.join(
                            directory,
                            "runtime",
                            "plugins",
                            plugin.id,
                            "saved-version.txt",
                        ),
                        "utf8",
                    ),
                ).toBe("2.0.0\n");
            }

            // Production restore must discard staging, retain desired Git inputs, and
            // leave the old active installation stopped until explicitly requested.
            expect(
                (
                    await cli<ConfigCaptureResult>(suite, directory, [
                        "config",
                        "capture",
                    ])
                ).conflicts,
            ).toEqual([]);
            await writeFile(
                baseConfig,
                `${await readFile(baseConfig, "utf8")}pending-only: after-upgrade\n`,
                "utf8",
            );
            await cli(suite, directory, [
                "--offline",
                "install",
                "--frozen-lockfile",
            ]);
            expect((await readState(directory)).pending).toBeDefined();
            const desiredLock = await readFile(
                path.join(directory, "craflet-lock.yaml"),
            );
            const desiredManifest = await readFile(
                path.join(directory, "craflet.yaml"),
            );
            const desiredConfig = await readFile(baseConfig);
            const applied = await cli(suite, directory, [
                "--offline",
                "--yes",
                "backup",
                "apply",
                restoredDirectory,
            ]);
            expect(applied).toMatchObject({
                applied: true,
                pendingDiscarded: true,
                startAfterApply: false,
                sharedLockUnchanged: true,
                preRestoreSnapshot: expect.any(String),
            });
            expect(
                (await cli<ServerStatus>(suite, directory, ["status"])).status,
            ).toBe("stopped");
            await assertPortReleased(project.port);
            const reapplied = await readState(directory);
            expect(reapplied.pending).toBeUndefined();
            expect(reapplied.active?.id).not.toBe(upgraded.active?.id);
            expect(reapplied.active?.lock).toEqual(active.lock);
            expect(
                await readFile(path.join(directory, "craflet-lock.yaml")),
            ).toEqual(desiredLock);
            expect(
                await readFile(path.join(directory, "craflet.yaml")),
            ).toEqual(desiredManifest);
            expect(await readFile(baseConfig)).toEqual(desiredConfig);
            if (kind === "paper")
                expect(await fileHash(runtimeWorld)).toBe(savedWorldHash);
            const restoredEvents = new Map<string, string>();
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v1;
                restoredEvents.set(
                    plugin.id,
                    await readFile(
                        pluginData(directory, plugin.id, "events.log"),
                        "utf8",
                    ),
                );
                expect(await fileHash(pluginJar(directory, plugin.id))).toBe(
                    plugin.sha256,
                );
                expect(
                    await readFile(
                        pluginData(directory, plugin.id, "saved-version.txt"),
                        "utf8",
                    ),
                ).toBe("1.0.0\n");
                expect(
                    await readFile(
                        pluginData(directory, plugin.id, "player-state.txt"),
                        "utf8",
                    ),
                ).toBe(originalPlayerState);
            }
            await cli(suite, directory, ["start", "--active"]);
            expect(
                (await cli<ServerStatus>(suite, directory, ["status"])).status,
            ).toBe("running");
            for (const platform of project.platforms) {
                const plugin = suite.fixtures.plugins[platform].v1;
                expect(
                    await readFile(
                        pluginData(directory, plugin.id, "events.log"),
                        "utf8",
                    ),
                ).toBe(`${restoredEvents.get(plugin.id)}enable:1.0.0\n`);
                expect(
                    await readFile(
                        pluginData(directory, plugin.id, "enabled-version.txt"),
                        "utf8",
                    ),
                ).toBe("1.0.0\n");
                expect(
                    await readFile(
                        pluginData(
                            directory,
                            plugin.id,
                            "observed-message.txt",
                        ),
                        "utf8",
                    ),
                ).toBe("runtime-generated\n");
                expect(
                    await readFile(
                        pluginData(
                            directory,
                            plugin.id,
                            "observed-player-state.txt",
                        ),
                        "utf8",
                    ),
                ).toBe(originalPlayerState);
            }
            expect(await readFile(baseConfig)).toEqual(desiredConfig);
            await cli(suite, directory, ["stop"]);
            expect(await waitForStopped(directory)).toMatchObject({
                clean: true,
                exitCode: 0,
            });
            await assertPortReleased(project.port);
        }, 300_000);
    }

    it("Velocity workspace snapshots and restores every member and its explicitly mapped shared data", async () => {
        const workspace = path.join(suite.root, "workspace");
        const shared = path.join(workspace, "shared-data");
        await mkdir(shared, { recursive: true });
        await writeFile(
            path.join(shared, "shared-data.txt"),
            "data shared by both disposable servers\n",
            "utf8",
        );
        await cli(suite, workspace, ["workspace", "init", "servers/*"]);
        const repositoryPath = path.join(suite.root, "group-repository");
        const members = [];
        for (const name of ["alpha", "beta"]) {
            const directory = path.join(workspace, "servers", name);
            const member = await initRealProject(
                suite,
                directory,
                "velocity",
                name,
                { directory: shared, instance: name },
            );
            await setupRealBackup(
                suite,
                directory,
                "e2e-group",
                repositoryPath,
                name === "alpha",
            );
            const loaded = await loadProject(directory, suite.home);
            await writeYaml(path.join(directory, "craflet.yaml"), {
                ...loaded.manifest,
                backup: {
                    ...loaded.manifest.backup,
                    group: "e2e-group",
                    files: [
                        ...(loaded.manifest.backup?.files ?? []),
                        `${shared.replaceAll("\\", "/")}/**`,
                    ],
                },
            });
            const source = member.sources.velocity;
            if (!source)
                throw new Error("Missing workspace local fixture source.");
            await cli(suite, directory, ["--offline", "add", `file:${source}`]);
            members.push({ ...member, name });
        }
        expect(
            (
                await cli<{ name: string }[]>(suite, workspace, [
                    "workspace",
                    "list",
                ])
            ).map((entry) => entry.name),
        ).toEqual(["alpha", "beta"]);
        await cli(suite, workspace, [
            "-r",
            "--offline",
            "install",
            "--frozen-lockfile",
        ]);
        const lock = await readLock(workspace);
        expect(
            Object.values(lock.projects)
                .map((project) => project.name)
                .sort(),
        ).toEqual(["alpha", "beta"]);
        for (const member of members) {
            await expect(
                stat(path.join(member.dir, "craflet-lock.yaml")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        await cliError(
            suite,
            workspace,
            ["--filter", "alpha", "start"],
            "BACKUP_GROUP_PARTIAL",
        );
        expect(
            await cli<(ServerStatus & { project: string })[]>(
                suite,
                workspace,
                ["-r", "status"],
            ),
        ).toEqual([
            expect.objectContaining({ project: "alpha", status: "stopped" }),
            expect.objectContaining({ project: "beta", status: "stopped" }),
        ]);
        expect(
            await cli<(ServerStatus & { project: string })[]>(
                suite,
                workspace,
                ["--filter", "alpha", "status"],
            ),
        ).toEqual([
            expect.objectContaining({ project: "alpha", status: "stopped" }),
        ]);
        await cli(suite, workspace, ["-r", "start"]);
        for (const name of ["alpha", "beta"]) {
            expect(
                await readFile(path.join(shared, `${name}.running`), "utf8"),
            ).toBe("1.0.0\n");
        }
        const first = members[0];
        if (!first?.sources.velocity)
            throw new Error("Missing first workspace member.");
        await copyFile(
            suite.fixtures.plugins.velocity.v2.path,
            first.sources.velocity,
        );
        await cli(suite, first.dir, ["--offline", "update"]);
        const pending = (await readState(first.dir)).pending;
        expect(pending?.lock.plugins.crafletvelocityfixture?.sha256).toBe(
            suite.fixtures.plugins.velocity.v2.sha256,
        );
        const activeIds = await Promise.all(
            members.map(
                async (member) => (await readState(member.dir)).active?.id,
            ),
        );
        const snapshotsBefore = await cli<BackupSnapshot[]>(suite, workspace, [
            "-r",
            "backup",
            "list",
        ]);

        await cliError(
            suite,
            workspace,
            ["--filter", "alpha", "backup", "create"],
            "BACKUP_GROUP_PARTIAL",
        );
        expect(
            (await cli<ServerStatus>(suite, first.dir, ["status"])).status,
        ).toBe("running");
        const results = await cli<
            {
                group: string;
                result: { backup: BackupCreateResult; resumed: string[] };
            }[]
        >(suite, workspace, ["-r", "backup", "create", "--leave-stopped"]);
        expect(results).toHaveLength(1);
        const result = results[0];
        if (!result) throw new Error("No group snapshot result.");
        expect(result.group).toBe("e2e-group");
        expect(result.result.resumed).toEqual([]);
        const backup = result.result.backup;
        expect(backup.metadata.active.group).toBeDefined();
        const activeMetadata = JSON.stringify(backup.metadata.active.group);
        for (const member of members)
            expect(activeMetadata).toContain(member.name);
        for (const id of activeIds) {
            if (!id)
                throw new Error("A group member had no active installation.");
            expect(activeMetadata).toContain(id);
        }
        expect(activeMetadata).toContain(
            suite.fixtures.plugins.velocity.v1.sha256,
        );
        expect(activeMetadata).not.toContain(
            suite.fixtures.plugins.velocity.v2.sha256,
        );
        expect(
            backup.metadata.files.some((file) =>
                file.destination.endsWith(".running"),
            ),
        ).toBe(false);
        expect(
            backup.metadata.files.filter((file) =>
                file.destination.endsWith("/shared-data.txt"),
            ),
        ).toHaveLength(1);
        expect(
            backup.metadata.files.filter((file) =>
                file.destination.endsWith("/saved-version.txt"),
            ),
        ).toHaveLength(2);
        expect(
            backup.metadata.files.some((file) =>
                /\.jar$/i.test(file.destination),
            ),
        ).toBe(false);
        expect((await readState(first.dir)).pending?.id).toBe(pending?.id);
        for (const member of members) {
            expect(
                await cli<ServerStatus>(suite, member.dir, ["status"]),
            ).toMatchObject({ status: "stopped", clean: true });
            await assertPortReleased(member.port);
            await expect(
                stat(path.join(shared, `${member.name}.running`)),
            ).rejects.toMatchObject({ code: "ENOENT" });
        }
        const snapshots = await cli<BackupSnapshot[]>(suite, workspace, [
            "-r",
            "backup",
            "list",
        ]);
        expect(snapshots).toHaveLength(snapshotsBefore.length + 1);
        expect(snapshots.map((snapshot) => snapshot.id).sort()).toEqual(
            [
                ...snapshotsBefore.map((snapshot) => snapshot.id),
                backup.snapshotId,
            ].sort(),
        );
        const restored = path.join(suite.root, "restored-group");
        await cli(suite, workspace, [
            "-r",
            "backup",
            "restore",
            backup.snapshotId,
            "--to",
            restored,
        ]);
        for (const file of backup.metadata.files.filter((file) =>
            file.destination.endsWith("/saved-version.txt"),
        )) {
            expect(
                await readFile(path.join(restored, file.destination), "utf8"),
            ).toBe("1.0.0\n");
        }
        const sharedData = backup.metadata.files.find((file) =>
            file.destination.endsWith("/shared-data.txt"),
        );
        if (!sharedData)
            throw new Error("Missing shared data in the group snapshot.");
        expect(
            await readFile(path.join(restored, sharedData.destination), "utf8"),
        ).toBe("data shared by both disposable servers\n");

        // Run alpha v2 against changed state before proving that the snapshot
        // restores the actual old JVM plugin, not merely its extracted bytes.
        for (const member of members) {
            await cli(suite, member.dir, ["config", "capture", "--initial"]);
        }
        await cli(suite, workspace, [
            "-r",
            "--offline",
            "install",
            "--frozen-lockfile",
        ]);
        for (const member of members) {
            await writeFile(
                pluginData(
                    member.dir,
                    "crafletvelocityfixture",
                    "player-state.txt",
                ),
                changedPlayerState,
                "utf8",
            );
        }
        await writeFile(
            path.join(shared, "shared-data.txt"),
            "changed shared data after the original snapshot\n",
            "utf8",
        );
        await cli(suite, workspace, ["-r", "start"]);
        for (const member of members) {
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "enabled-version.txt",
                    ),
                    "utf8",
                ),
            ).toBe(member.name === "alpha" ? "2.0.0\n" : "1.0.0\n");
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "observed-player-state.txt",
                    ),
                    "utf8",
                ),
            ).toBe(changedPlayerState);
        }
        for (const member of members) {
            const config = path.join(member.dir, "config", "velocity.toml");
            await writeFile(
                config,
                `${await readFile(config, "utf8")}\n# Desired config staged before restoration.\n`,
                "utf8",
            );
        }
        await cli(suite, workspace, [
            "-r",
            "--offline",
            "install",
            "--frozen-lockfile",
        ]);
        for (const member of members)
            expect((await readState(member.dir)).pending).toBeDefined();
        const desiredLock = await readFile(
            path.join(workspace, "craflet-lock.yaml"),
        );
        const desiredActiveIds = await Promise.all(
            members.map(
                async (member) => (await readState(member.dir)).active?.id,
            ),
        );
        const sharedRoot = sharedData.destination.split("/")[2];
        if (!sharedRoot || !sharedData.destination.startsWith("data/external/"))
            throw new Error(
                "Shared fixture root was not explicitly identified in the backup.",
            );
        await cliError(
            suite,
            workspace,
            ["--filter", "alpha", "--yes", "backup", "apply", restored],
            "BACKUP_GROUP_PARTIAL",
        );
        await cliError(
            suite,
            workspace,
            ["-r", "--yes", "--offline", "backup", "apply", restored],
            "RESTORE_MAPPING",
        );
        for (const [index, member] of members.entries()) {
            expect(
                await cli<ServerStatus>(suite, member.dir, ["status"]),
            ).toMatchObject({
                status: "running",
                activeId: desiredActiveIds[index],
            });
        }
        const applied = await cli(suite, workspace, [
            "-r",
            "--yes",
            "--offline",
            "backup",
            "apply",
            restored,
            "--map",
            `${sharedRoot}=${shared}`,
        ]);
        expect(applied).toMatchObject({
            group: "e2e-group",
            applied: true,
            pendingDiscarded: true,
            startAfterApply: false,
            sharedLockUnchanged: true,
            preRestoreSnapshot: expect.any(String),
        });
        expect(
            await readFile(path.join(workspace, "craflet-lock.yaml")),
        ).toEqual(desiredLock);
        expect(
            await readFile(path.join(shared, "shared-data.txt"), "utf8"),
        ).toBe("data shared by both disposable servers\n");
        const restoredEvents = new Map<string, string>();
        for (const [index, member] of members.entries()) {
            restoredEvents.set(
                member.name,
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "events.log",
                    ),
                    "utf8",
                ),
            );
            const state = await readState(member.dir);
            expect(state.pending).toBeUndefined();
            expect(state.active?.id).not.toBe(desiredActiveIds[index]);
            expect(
                state.active?.lock.plugins.crafletvelocityfixture?.sha256,
            ).toBe(suite.fixtures.plugins.velocity.v1.sha256);
            expect(
                await cli<ServerStatus>(suite, member.dir, ["status"]),
            ).toMatchObject({
                status: "stopped",
                clean: true,
            });
            await assertPortReleased(member.port);
            expect(
                await fileHash(pluginJar(member.dir, "crafletvelocityfixture")),
            ).toBe(suite.fixtures.plugins.velocity.v1.sha256);
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "saved-version.txt",
                    ),
                    "utf8",
                ),
            ).toBe("1.0.0\n");
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "player-state.txt",
                    ),
                    "utf8",
                ),
            ).toBe(originalPlayerState);
            await expect(
                stat(path.join(shared, `${member.name}.running`)),
            ).rejects.toMatchObject({
                code: "ENOENT",
            });
            await expect(
                stat(path.join(member.dir, ".craflet", "restore.json")),
            ).rejects.toMatchObject({
                code: "ENOENT",
            });
        }
        await expect(
            stat(path.join(workspace, ".craflet", "group-restore.json")),
        ).rejects.toMatchObject({
            code: "ENOENT",
        });
        await cli(suite, workspace, ["-r", "start", "--active"]);
        for (const member of members) {
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "events.log",
                    ),
                    "utf8",
                ),
            ).toBe(`${restoredEvents.get(member.name)}enable:1.0.0\n`);
            expect(
                (await cli<ServerStatus>(suite, member.dir, ["status"])).status,
            ).toBe("running");
            expect(
                await readFile(
                    path.join(shared, `${member.name}.running`),
                    "utf8",
                ),
            ).toBe("1.0.0\n");
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "enabled-version.txt",
                    ),
                    "utf8",
                ),
            ).toBe("1.0.0\n");
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "observed-message.txt",
                    ),
                    "utf8",
                ),
            ).toBe("runtime-generated\n");
            expect(
                await readFile(
                    pluginData(
                        member.dir,
                        "crafletvelocityfixture",
                        "observed-player-state.txt",
                    ),
                    "utf8",
                ),
            ).toBe(originalPlayerState);
        }
        await cli(suite, workspace, ["-r", "stop"]);
        for (const member of members) {
            expect(await waitForStopped(member.dir)).toMatchObject({
                clean: true,
                exitCode: 0,
            });
            await assertPortReleased(member.port);
        }
    }, 300_000);

    it("Velocity leaves active and pending untouched when its real backup repository disappears during shutdown", async () => {
        const directory = path.join(suite.root, "backup-failure-velocity");
        const repositoryPath = path.join(suite.root, "unavailable-repository");
        const project = await initRealProject(
            suite,
            directory,
            "velocity",
            "backup-failure-velocity",
            undefined,
            { stopTimeout: 20 },
        );
        await setupRealBackup(suite, directory, "unavailable", repositoryPath);
        expect(
            (await stat(path.join(repositoryPath, "config"))).size,
        ).toBeGreaterThan(0);
        const source = project.sources.velocity;
        if (!source) throw new Error("Missing backup-failure fixture source.");
        const plugin = suite.fixtures.plugins.velocity.v1;
        await cli(suite, directory, ["--offline", "add", `file:${source}`]);
        await cli(suite, directory, ["start"]);
        await cli(suite, directory, ["config", "capture", "--initial"]);
        await copyFile(suite.fixtures.plugins.velocity.v2.path, source);
        await cli(suite, directory, ["--offline", "update"]);
        const before = await readState(directory);
        expect(before.active?.lock.plugins[plugin.id]?.sha256).toBe(
            plugin.sha256,
        );
        expect(before.pending?.lock.plugins[plugin.id]?.sha256).toBe(
            suite.fixtures.plugins.velocity.v2.sha256,
        );
        const snapshots = await cli<BackupSnapshot[]>(suite, directory, [
            "backup",
            "list",
        ]);
        const jar = pluginJar(directory, plugin.id);
        const timestamp = (await stat(jar)).mtimeMs;
        const events = await readFile(
            pluginData(directory, plugin.id, "events.log"),
            "utf8",
        );
        const marker = pluginData(
            directory,
            plugin.id,
            "stop-delay-started.txt",
        );
        await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        await writeFile(
            pluginData(directory, plugin.id, "stop-delay-ms.txt"),
            "7000\n",
            "utf8",
        );

        // Observe a real Java shutdown before removing only this owned repository.
        // Attach both handlers immediately so an early CLI failure is never unhandled.
        const restarting = cliError(
            suite,
            directory,
            ["restart"],
            "BACKUP_REPOSITORY",
        ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );
        try {
            await waitForStopDelay(marker);
            expect(
                (await cli<ServerStatus>(suite, directory, ["status"])).status,
            ).toBe("stopping");
            await withUnavailableRepository(suite, repositoryPath, async () => {
                const result = await restarting;
                if (!result.ok) throw result.error;
                expect(await waitForStopped(directory)).toMatchObject({
                    clean: true,
                    exitCode: 0,
                });
                await assertPortReleased(project.port);
                expect(await readState(directory)).toEqual(before);
                expect(await fileHash(jar)).toBe(plugin.sha256);
                expect((await stat(jar)).mtimeMs).toBe(timestamp);
                expect(
                    await readFile(
                        pluginData(directory, plugin.id, "saved-version.txt"),
                        "utf8",
                    ),
                ).toBe("1.0.0\n");
                expect(
                    await readFile(
                        pluginData(directory, plugin.id, "events.log"),
                        "utf8",
                    ),
                ).toBe(`${events}disable:1.0.0\n`);
                await expect(
                    stat(path.join(directory, ".craflet", "deploy.json")),
                ).rejects.toMatchObject({
                    code: "ENOENT",
                });
            });
        } finally {
            await restarting;
        }
        // The original repository was put back before cleanup or another operation.
        expect(
            await cli<BackupSnapshot[]>(suite, directory, ["backup", "list"]),
        ).toEqual(snapshots);
        expect(
            (await cli<ServerStatus>(suite, directory, ["status"])).status,
        ).toBe("stopped");
        await assertPortReleased(project.port);
    }, 120_000);

    it("Velocity recovers a real partial deployment after runtime configuration becomes unwritable", async () => {
        const directory = path.join(suite.root, "interrupted-velocity");
        const project = await initRealProject(
            suite,
            directory,
            "velocity",
            "interrupted-velocity",
        );
        await setupRealBackup(
            suite,
            directory,
            "interrupted",
            path.join(suite.root, "interrupted-repository"),
        );
        const source = project.sources.velocity;
        if (!source)
            throw new Error("Missing interrupted-deployment fixture source.");
        const previous = suite.fixtures.plugins.velocity.v1;
        const next = suite.fixtures.plugins.velocity.v2;
        await cli(suite, directory, ["--offline", "add", `file:${source}`]);
        await cli(suite, directory, ["start"]);
        expect(
            await readFile(
                pluginData(directory, previous.id, "enabled-version.txt"),
                "utf8",
            ),
        ).toBe("1.0.0\n");
        await cli(suite, directory, ["stop"]);
        expect(await waitForStopped(directory)).toMatchObject({
            clean: true,
            exitCode: 0,
        });
        await assertPortReleased(project.port);
        await cli(suite, directory, ["config", "capture", "--initial"]);
        const baseConfig = path.join(directory, "config", "velocity.toml");
        const runtimeConfig = path.join(directory, "runtime", "velocity.toml");
        const oldConfig = await readFile(runtimeConfig);
        const declared = (await readFile(baseConfig, "utf8")).replace(
            "Craflet disposable E2E",
            "Craflet interrupted deployment",
        );
        expect(declared).toContain("Craflet interrupted deployment");
        await writeFile(baseConfig, declared, "utf8");
        await copyFile(next.path, source);
        await cli(suite, directory, ["--offline", "update"]);
        const before = await readState(directory);
        expect(before.active?.lock.plugins[previous.id]?.sha256).toBe(
            previous.sha256,
        );
        expect(before.pending?.lock.plugins[next.id]?.sha256).toBe(next.sha256);
        const desiredLock = await readFile(
            path.join(directory, "craflet-lock.yaml"),
        );
        const journalFile = path.join(directory, ".craflet", "deploy.json");

        // Keep plugins/ writable so the real JAR is replaced, then deny the root
        // config's atomic write. The helper always restores the original ACL/mode.
        await withRuntimeRootWriteDenied(suite, directory, async () => {
            await cliError(
                suite,
                directory,
                ["--offline", "deploy", "apply"],
                "DEPLOY_INTERRUPTED",
            );
            expect(await readState(directory)).toEqual(before);
            expect(await fileHash(pluginJar(directory, previous.id))).toBe(
                next.sha256,
            );
            expect(await readFile(runtimeConfig)).toEqual(oldConfig);
            const journal = JSON.parse(await readFile(journalFile, "utf8")) as {
                phase: string;
                previous: { id: string };
                next: { id: string };
            };
            expect(journal.phase).toBe("applying");
            expect(journal.previous.id).toBe(before.active?.id);
            expect(journal.next.id).toBe(before.pending?.id);
            const interruptedEvents = await readFile(
                pluginData(directory, previous.id, "events.log"),
                "utf8",
            );
            await cliError(
                suite,
                directory,
                ["start", "--active"],
                "RECOVERY_REQUIRED",
            );
            expect(
                await readFile(
                    pluginData(directory, previous.id, "events.log"),
                    "utf8",
                ),
            ).toBe(interruptedEvents);
            expect(
                (await cli<ServerStatus>(suite, directory, ["status"])).status,
            ).toBe("stopped");
            await assertPortReleased(project.port);
        });

        const recovered = await cli(suite, directory, ["--offline", "recover"]);
        expect(recovered).toEqual([
            expect.objectContaining({
                project: "interrupted-velocity",
                recovered: true,
            }),
        ]);
        expect(await readState(directory)).toEqual(before);
        expect(await fileHash(pluginJar(directory, previous.id))).toBe(
            previous.sha256,
        );
        expect(await readFile(runtimeConfig)).toEqual(oldConfig);
        expect(await readFile(baseConfig, "utf8")).toBe(declared);
        expect(
            await readFile(path.join(directory, "craflet-lock.yaml")),
        ).toEqual(desiredLock);
        await expect(stat(journalFile)).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(
            (await cli<ServerStatus>(suite, directory, ["status"])).status,
        ).toBe("stopped");
        await assertPortReleased(project.port);
        const events = await readFile(
            pluginData(directory, previous.id, "events.log"),
            "utf8",
        );
        await cli(suite, directory, ["start", "--active"]);
        expect(
            await readFile(
                pluginData(directory, previous.id, "events.log"),
                "utf8",
            ),
        ).toBe(`${events}enable:1.0.0\n`);
        expect(
            await readFile(
                pluginData(directory, previous.id, "enabled-version.txt"),
                "utf8",
            ),
        ).toBe("1.0.0\n");
        expect(
            await readFile(
                pluginData(directory, previous.id, "observed-player-state.txt"),
                "utf8",
            ),
        ).toBe(originalPlayerState);
        await cli(suite, directory, ["stop"]);
        expect(await waitForStopped(directory)).toMatchObject({
            clean: true,
            exitCode: 0,
        });
        await assertPortReleased(project.port);
    }, 120_000);

    it("Velocity keeps pending bytes untouched after a real stop timeout and records an explicit Java crash", async () => {
        const directory = path.join(suite.root, "faults-velocity");
        const project = await initRealProject(
            suite,
            directory,
            "velocity",
            "faults-velocity",
            undefined,
            { stopTimeout: 1 },
        );
        await setupRealBackup(
            suite,
            directory,
            "faults-velocity",
            path.join(suite.root, "faults-repository"),
        );
        const source = project.sources.velocity;
        if (!source) throw new Error("Missing fault-test fixture source.");
        const plugin = suite.fixtures.plugins.velocity.v1;
        await cli(suite, directory, ["--offline", "add", `file:${source}`]);
        await cli(suite, directory, ["start"]);
        const active = (await readState(directory)).active;
        expect(active).toBeDefined();
        await cli(suite, directory, ["config", "capture", "--initial"]);
        await copyFile(suite.fixtures.plugins.velocity.v2.path, source);
        await cli(suite, directory, ["--offline", "update"]);
        const pending = (await readState(directory)).pending;
        expect(pending?.lock.plugins[plugin.id]?.sha256).toBe(
            suite.fixtures.plugins.velocity.v2.sha256,
        );
        const snapshotsBefore = await cli<BackupSnapshot[]>(suite, directory, [
            "backup",
            "list",
        ]);
        await writeFile(
            pluginData(directory, plugin.id, "stop-delay-ms.txt"),
            "3500\n",
            "utf8",
        );
        await cliError(suite, directory, ["restart"], "STOP_TIMEOUT");
        expect(
            await readFile(
                pluginData(directory, plugin.id, "stop-delay-started.txt"),
                "utf8",
            ),
        ).toBe("delaying\n");
        expect((await readState(directory)).active?.id).toBe(active?.id);
        expect((await readState(directory)).pending?.id).toBe(pending?.id);
        expect(await fileHash(pluginJar(directory, plugin.id))).toBe(
            plugin.sha256,
        );
        expect(await waitForStopped(directory)).toMatchObject({
            clean: true,
            exitCode: 0,
        });
        await assertPortReleased(project.port);
        expect(
            await readFile(
                pluginData(directory, plugin.id, "saved-version.txt"),
                "utf8",
            ),
        ).toBe("1.0.0\n");
        expect(
            await cli<BackupSnapshot[]>(suite, directory, ["backup", "list"]),
        ).toEqual(snapshotsBefore);

        // This opt-in fixture halts its own disposable JVM; no PID is guessed or killed.
        await writeFile(
            pluginData(directory, plugin.id, "stop-delay-ms.txt"),
            "0\n",
            "utf8",
        );
        await cli(suite, directory, ["start", "--active"]);
        expect(
            (await cli<ServerStatus>(suite, directory, ["status"])).status,
        ).toBe("running");
        await writeFile(
            pluginData(directory, plugin.id, "crash.request"),
            "halt the disposable fixture JVM\n",
            "utf8",
        );
        expect(await waitForStopped(directory)).toMatchObject({
            clean: false,
            exitCode: 17,
        });
        await assertPortReleased(project.port);
        expect(
            await readFile(
                pluginData(directory, plugin.id, "crashed-version.txt"),
                "utf8",
            ),
        ).toBe("1.0.0\n");
        expect((await readState(directory)).active?.id).toBe(active?.id);
        expect((await readState(directory)).pending?.id).toBe(pending?.id);
        expect(await fileHash(pluginJar(directory, plugin.id))).toBe(
            plugin.sha256,
        );
    }, 120_000);
});
