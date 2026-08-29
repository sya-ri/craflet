import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ServerStatus } from "@craflet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedEulaOperationJournal } from "../../packages/adapters/src/filesystem/eula.js";
import { ensureUserEulaConsent } from "../../packages/adapters/src/filesystem/eula-consent.js";
import {
    collectGroupBackupMetadata,
    createGroupBackupService,
    NodeRecoveryGroup,
    resolveBackupBatches,
    runtimeRootId,
    validateRecoveryGroup,
} from "../../packages/adapters/src/filesystem/groups.js";
import {
    exists,
    readJson,
    writeJson,
} from "../../packages/adapters/src/filesystem/io.js";
import { writeYaml } from "../../packages/adapters/src/filesystem/projects.js";
import {
    readState,
    saveState,
} from "../../packages/adapters/src/filesystem/state.js";
import * as java from "../../packages/adapters/src/runtime/java.js";
import {
    cleanupBackupTestDirectories,
    writeBackupTestFile,
} from "./backup-fixtures.js";
import {
    backupGroupFixture,
    requireGroupFixture as required,
} from "./backup-group-fixtures.js";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupBackupTestDirectories();
});

function controlledStatuses(
    group: NodeRecoveryGroup,
    initial: ("running" | "stopped")[],
) {
    const current = [...initial];
    const stops = group.managers.map((manager, index) => {
        vi.spyOn(manager.controller, "status").mockImplementation(
            async (): Promise<ServerStatus> => {
                const status = current[index] ?? "stopped";
                return {
                    status,
                    ...(status === "running"
                        ? {
                              activeId: required(
                                  (await readState(manager.context.dir)).active,
                              ).id,
                          }
                        : {}),
                    clean: true,
                };
            },
        );
        return vi
            .spyOn(manager.controller, "stop")
            .mockImplementation(async (): Promise<ServerStatus> => {
                current[index] = "stopped";
                return { status: "stopped", clean: true };
            });
    });
    const starts = group.managers.map((manager, index) =>
        vi
            .spyOn(manager.controller, "start")
            .mockImplementation(async (activeId): Promise<ServerStatus> => {
                current[index] = "running";
                return { status: "running", activeId };
            }),
    );
    return { current, stops, starts };
}

describe("recovery group selection on an actual workspace", () => {
    it("requires a complete explicit selection before mutation and expands read-only inspection", async () => {
        const { projects, engine } = await backupGroupFixture();
        await expect(
            resolveBackupBatches([projects[0]], { complete: true }),
        ).rejects.toMatchObject({ code: "BACKUP_GROUP_PARTIAL" });
        const readonly = await resolveBackupBatches([projects[0]]);
        expect(readonly).toHaveLength(1);
        expect(
            readonly[0]?.projects.map((project) => project.manifest.name),
        ).toEqual(["alpha", "beta"]);
        expect(
            await resolveBackupBatches(projects, { complete: true }),
        ).toHaveLength(1);
        expect(engine.snapshots.size).toBe(0);
        await expect(resolveBackupBatches([])).rejects.toMatchObject({
            code: "WORKSPACE_ROOT",
        });
        await expect(
            resolveBackupBatches([
                {
                    ...projects[0],
                    lockRoot: path.join(projects[0].lockRoot, "other"),
                },
                projects[1],
            ]),
        ).rejects.toMatchObject({ code: "WORKSPACE_ROOT" });
    });

    it("rejects duplicate members, persistent IDs, or incompatible group configuration", async () => {
        const { projects, makeBackup } = await backupGroupFixture();
        expect(() => validateRecoveryGroup("network", [])).toThrow();
        expect(() =>
            validateRecoveryGroup("network", [projects[0], projects[0]]),
        ).toThrow();
        expect(() =>
            validateRecoveryGroup("network", [
                projects[0],
                {
                    ...projects[1],
                    home: path.join(projects[1].home, "other"),
                },
            ]),
        ).toThrow();
        const beta = projects[1];
        const original = structuredClone(beta.manifest);
        beta.manifest.id = projects[0].manifest.id;
        await expect(makeBackup()).rejects.toMatchObject({
            code: "BACKUP_GROUP_MEMBERSHIP",
        });
        beta.manifest = structuredClone(original);
        beta.manifest.backup.group = "another";
        await expect(makeBackup()).rejects.toMatchObject({
            code: "BACKUP_GROUP_MEMBERSHIP",
        });
        beta.manifest = structuredClone(original);
        beta.manifest.backup.repository = "other";
        await expect(makeBackup()).rejects.toMatchObject({
            code: "BACKUP_GROUP_REPOSITORY",
        });
        beta.manifest = structuredClone(original);
        beta.manifest.backup.retention = { keepLast: 4 };
        await expect(makeBackup()).rejects.toMatchObject({
            code: "BACKUP_GROUP_RETENTION",
        });
        beta.manifest = original;
        delete projects[0].manifest.backup.repository;
        expect(
            await createGroupBackupService("network", projects),
        ).toBeUndefined();
        expect(
            await createGroupBackupService("network", projects, "local"),
        ).toBeDefined();
    });

    it("handles independent projects and repeated references without inventing additional writers", async () => {
        const { projects, home } = await backupGroupFixture();
        for (const project of projects) {
            delete project.manifest.backup.group;
            await writeYaml(
                path.join(project.dir, "craflet.yaml"),
                project.manifest,
            );
        }
        const database = {
            id: "players",
            kind: "sqlite",
            path: "runtime/players.db",
        } as const;
        projects[0].manifest.backup.databases = [database, database];
        await writeYaml(
            path.join(projects[0].dir, "craflet.yaml"),
            projects[0].manifest,
        );
        expect(
            await resolveBackupBatches([projects[0]], { complete: true }),
        ).toHaveLength(1);
        delete projects[1].manifest.backup.repository;
        await writeYaml(
            path.join(projects[1].dir, "craflet.yaml"),
            projects[1].manifest,
        );
        const selected = await resolveBackupBatches(projects, {
            complete: true,
        });
        expect(selected.map((batch) => Boolean(batch.backup))).toEqual([
            true,
            false,
        ]);
        expect(selected[0]?.projects[0]?.home).toBe(home);
    });

    it("requires one declared group for a database shared by multiple discovered writers", async () => {
        const { projects, workspace } = await backupGroupFixture();
        for (const project of projects) {
            delete project.manifest.backup.group;
            project.manifest.backup.databases = [
                {
                    id: "players",
                    kind: "sqlite",
                    path: path.join(workspace, "shared/players.sqlite3"),
                },
            ];
            await writeYaml(
                path.join(project.dir, "craflet.yaml"),
                project.manifest,
            );
        }
        await expect(
            resolveBackupBatches([projects[0]], { complete: true }),
        ).rejects.toMatchObject({ code: "BACKUP_GROUP_REQUIRED" });
    });
});

describe("one-snapshot group file and database selection", () => {
    it("deduplicates shared files, applies each member's rules, and records both active lock slices", async () => {
        const { projects, backup, engine } = await backupGroupFixture();
        await writeBackupTestFile(projects[0].dir, "runtime/.hidden", "hidden");
        await writeBackupTestFile(
            projects[0].dir,
            "runtime/plugins/custom.JaR",
            "must not be backed up",
        );
        const plan = await backup.plan();
        expect(
            plan.files.filter((file) =>
                file.source.endsWith(path.join("shared", "players.dat")),
            ),
        ).toHaveLength(1);
        expect(
            plan.files.filter((file) =>
                file.source.endsWith(path.join("world", "players.dat")),
            ),
        ).toHaveLength(2);
        expect(plan.files.some((file) => /\.jar$/iu.test(file.source))).toBe(
            false,
        );
        expect(plan.files.some((file) => file.source.endsWith(".hidden"))).toBe(
            true,
        );
        expect(new Set(plan.files.map((file) => file.destination)).size).toBe(
            plan.files.length,
        );
        await backup.prepare();
        await backup.preflight();
        const saved = await backup.create(
            await collectGroupBackupMetadata("network", projects),
        );
        expect(engine.snapshots.size).toBe(1);
        expect(saved.metadata.files.map((file) => file.destination)).toEqual(
            plan.files.map((file) => file.destination),
        );
        const active = saved.metadata.active as Awaited<
            ReturnType<typeof collectGroupBackupMetadata>
        >;
        expect(
            active.group.members.map((member) => member.installation?.id),
        ).toEqual(
            await Promise.all(
                projects.map(
                    async (project) =>
                        (await readState(project.dir)).active?.id,
                ),
            ),
        );
        expect(
            active.group.members.map((member) => member.runtimeRootId),
        ).toEqual(projects.map(runtimeRootId));
    });

    it("assigns cross-member runtime selections to their owner and collapses overlapping external roots", async () => {
        const { projects, workspace, makeBackup } = await backupGroupFixture();
        await writeBackupTestFile(
            workspace,
            "shared/nested/value.dat",
            "nested",
        );
        projects[0].manifest.backup.files = [
            "runtime/**",
            "../beta/runtime/**",
            "../../shared/nested/**",
            "!**/*.[jJ][aA][rR]",
        ];
        const plan = await (await makeBackup()).plan();
        const beta = plan.files.filter((file) =>
            file.source.startsWith(
                path.join(projects[1].dir, "runtime") + path.sep,
            ),
        );
        expect(beta.length).toBeGreaterThan(0);
        expect(
            beta.every((file) => file.rootId === runtimeRootId(projects[1])),
        ).toBe(true);
        expect(
            plan.roots.filter((root) =>
                root.path.includes(`${path.sep}shared`),
            ),
        ).toHaveLength(1);
        expect(
            plan.files.filter((file) =>
                file.source.endsWith(path.join("nested", "value.dat")),
            ),
        ).toHaveLength(1);
    });

    it("does not let one member select another member's private state", async () => {
        const { projects, makeBackup } = await backupGroupFixture();
        projects[0].manifest.backup.files.push("../beta/.craflet/**");
        await expect((await makeBackup()).plan()).rejects.toMatchObject({
            code: "BACKUP_SELF_INCLUSION",
        });
    });

    it("dumps shared SQLite once and excludes its raw file and sidecars from the file union", async () => {
        const { projects, workspace, makeBackup } = await backupGroupFixture();
        const file = path.join(workspace, "shared/players.sqlite3");
        const { DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(file);
        database.exec(
            "PRAGMA journal_mode=WAL; CREATE TABLE players(id INTEGER PRIMARY KEY); INSERT INTO players VALUES(1);",
        );
        try {
            for (const project of projects)
                project.manifest.backup.databases = [
                    {
                        id: "players",
                        kind: "sqlite",
                        path: "../../shared/players.sqlite3",
                    },
                ];
            const backup = await makeBackup();
            expect(backup.config.databases).toEqual([
                { id: "players", kind: "sqlite", path: file },
            ]);
            expect(
                (await backup.plan()).files.some((item) =>
                    item.source.startsWith(file),
                ),
            ).toBe(false);
            await backup.prepare();
            const saved = await backup.create(
                await collectGroupBackupMetadata("network", projects),
            );
            expect(saved.metadata.databases).toHaveLength(1);
            expect(saved.metadata.databases[0]?.id).toBe("players");
        } finally {
            database.close();
        }
        projects[1].manifest.backup.databases = [
            {
                id: "another",
                kind: "sqlite",
                path: "../../shared/players.sqlite3",
            },
        ];
        await expect(makeBackup()).rejects.toMatchObject({
            code: "BACKUP_GROUP_DATABASE",
        });
        projects[1].manifest.backup.databases = [
            { id: "players", kind: "sqlite", path: "runtime/another.sqlite3" },
        ];
        await expect(makeBackup()).rejects.toMatchObject({
            code: "BACKUP_GROUP_DATABASE",
        });
    });

    it("normalizes SQL credentials and explicit executable paths without placing secrets in snapshot metadata", async () => {
        const { projects, workspace, makeBackup } = await backupGroupFixture();
        const database = {
            id: "players",
            kind: "mysql",
            host: "localhost",
            database: "players",
            user: "fixture",
            password: { file: "../../secrets/database" },
            sslCa: "../../secrets/ca.pem",
            command: "../../tools/mysqldump",
            restoreCommand: "mysql",
        } as const;
        for (const project of projects)
            project.manifest.backup.databases = [database];
        const backup = await makeBackup();
        expect(backup.config.databases).toEqual([
            {
                ...database,
                password: { file: path.join(workspace, "secrets/database") },
                sslCa: path.join(workspace, "secrets/ca.pem"),
                command: path.join(workspace, "tools/mysqldump"),
            },
        ]);
        const active = await collectGroupBackupMetadata("network", projects);
        expect(active.group.members).toHaveLength(2);
        await expect(
            collectGroupBackupMetadata("network", projects, new Map()),
        ).rejects.toMatchObject({ code: "BACKUP_GROUP_STATE_CHANGED" });
    });
});

describe("group lifecycle coordinates real backup and deployment state", () => {
    it("resumes only previously running members with their fixed active version and preserves pending", async () => {
        const fixture = await backupGroupFixture();
        await fixture.stageNext();
        await writeBackupTestFile(
            fixture.projects[0].dir,
            "runtime/eula.txt",
            "eula=true\n",
        );
        const states = await Promise.all(
            fixture.projects.map((project) => readState(project.dir)),
        );
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        const controlled = controlledStatuses(group, ["running", "stopped"]);
        const result = await group.createBackup();
        expect(result).toMatchObject({
            resumed: [fixture.projects[0].lockKey],
        });
        expect(controlled.stops[0]).toHaveBeenCalledOnce();
        expect(controlled.stops[1]).not.toHaveBeenCalled();
        expect(controlled.starts[0]).toHaveBeenCalledWith(
            required(required(states[0]).active).id,
        );
        expect(controlled.starts[1]).not.toHaveBeenCalled();
        expect(
            await Promise.all(
                fixture.projects.map((project) => readState(project.dir)),
            ),
        ).toEqual(states);
        expect(fixture.engine.snapshots.size).toBe(1);
    });

    it.each(["missing", "changed"] as const)(
        "materializes a %s Paper EULA from saved user consent before resuming a group member",
        async (kind) => {
            const fixture = await backupGroupFixture();
            await ensureUserEulaConsent(fixture.home, async () => undefined);
            const eulaFile = path.join(
                fixture.projects[0].dir,
                "runtime/eula.txt",
            );
            if (kind === "missing") await rm(eulaFile, { force: true });
            else
                await writeBackupTestFile(
                    fixture.projects[0].dir,
                    "runtime/eula.txt",
                    "# changed by the server\neula=false\n",
                );
            const request = vi.fn(async () => {
                throw new Error("Saved consent must not prompt again");
            });
            const group = new NodeRecoveryGroup(
                fixture.batch,
                fixture.store,
                undefined,
                { requestEulaConsent: request },
            );
            const controlled = controlledStatuses(group, [
                "running",
                "stopped",
            ]);
            const activeId = required(
                (await readState(fixture.projects[0].dir)).active,
            ).id;
            const spawn = vi.spyOn(required(group.managers[0]), "spawnActive");

            await expect(group.createBackup()).resolves.toMatchObject({
                resumed: [fixture.projects[0].lockKey],
            });

            expect(request).not.toHaveBeenCalled();
            expect(spawn).toHaveBeenCalledWith(activeId);
            expect(controlled.starts[0]).toHaveBeenCalledWith(activeId);
            const materialized = await readFile(eulaFile, "utf8");
            expect(materialized).toContain("eula=true");
            if (kind === "changed")
                expect(materialized).toContain("# changed by the server");
        },
    );

    it("keeps the entire group stopped when snapshot creation fails and never applies pending", async () => {
        const fixture = await backupGroupFixture();
        await fixture.stageNext();
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        const controlled = controlledStatuses(group, ["running", "running"]);
        const states = await Promise.all(
            fixture.projects.map((project) => readState(project.dir)),
        );
        vi.spyOn(fixture.backup, "create").mockRejectedValue(
            new Error("snapshot failure"),
        );
        await expect(group.createBackup()).rejects.toThrow("snapshot failure");
        expect(controlled.current).toEqual(["stopped", "stopped"]);
        expect(
            controlled.starts.every((start) => start.mock.calls.length === 0),
        ).toBe(true);
        expect(
            await Promise.all(
                fixture.projects.map((project) => readState(project.dir)),
            ),
        ).toEqual(states);
    });

    it("provides a read-only plan, supports leave-stopped, and rejects missing repositories and interrupted operations", async () => {
        const fixture = await backupGroupFixture();
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        const controlled = controlledStatuses(group, ["running", "running"]);
        expect(await group.createBackup(false, true)).toHaveProperty("files");
        expect(
            controlled.stops.every((stop) => stop.mock.calls.length === 0),
        ).toBe(true);
        await group.createBackup(true);
        expect(
            controlled.starts.every((start) => start.mock.calls.length === 0),
        ).toBe(true);
        const noRepository = new NodeRecoveryGroup(
            { group: "network", projects: fixture.projects },
            fixture.store,
        );
        await expect(noRepository.createBackup()).rejects.toMatchObject({
            code: "BACKUP_REQUIRED",
        });
        expect(
            () =>
                new NodeRecoveryGroup(
                    { projects: fixture.projects },
                    fixture.store,
                ),
        ).toThrow();
        await writeJson(
            path.join(fixture.workspace, ".craflet/group-restore.json"),
            { incomplete: true },
        );
        await expect(group.createBackup()).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
        await expect(group.operate("apply")).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
    });

    it("applies both pending installations after exactly one pre-apply snapshot without changing shared lock", async () => {
        const fixture = await backupGroupFixture();
        await fixture.stageNext();
        const before = await Promise.all(
            fixture.projects.map((project) => readState(project.dir)),
        );
        const lock = await readFile(
            path.join(fixture.workspace, "craflet-lock.yaml"),
        );
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        const controlled = controlledStatuses(group, ["stopped", "stopped"]);
        for (const manager of group.managers)
            vi.spyOn(manager, "preflight").mockResolvedValue(undefined);
        expect(await group.operate("apply", false, true)).toHaveLength(2);
        expect(fixture.engine.snapshots.size).toBe(0);
        await group.operate("apply");
        expect(fixture.engine.snapshots.size).toBe(1);
        expect(
            await Promise.all(
                fixture.projects.map(
                    async (project) =>
                        (await readState(project.dir)).active?.id,
                ),
            ),
        ).toEqual(before.map((state) => state.pending?.id));
        expect(
            await Promise.all(
                fixture.projects.map(
                    async (project) => (await readState(project.dir)).pending,
                ),
            ),
        ).toEqual([undefined, undefined]);
        expect(
            await readFile(path.join(fixture.workspace, "craflet-lock.yaml")),
        ).toEqual(lock);
        expect(
            controlled.starts.every((start) => start.mock.calls.length === 0),
        ).toBe(true);
        expect(
            await exists(
                path.join(fixture.workspace, ".craflet/group-operation.json"),
            ),
        ).toBe(false);
    });

    it("retains a group journal on a partial apply and safely finishes the remaining member during recovery", async () => {
        const fixture = await backupGroupFixture();
        await fixture.stageNext();
        const before = await Promise.all(
            fixture.projects.map((project) => readState(project.dir)),
        );
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        const controlled = controlledStatuses(group, ["stopped", "stopped"]);
        for (const manager of group.managers)
            vi.spyOn(manager, "preflight").mockResolvedValue(undefined);
        const failure = vi
            .spyOn(required(group.managers[1]), "applyPrepared")
            .mockRejectedValueOnce(new Error("interrupted second member"));
        await expect(group.operate("apply")).rejects.toThrow(
            "interrupted second member",
        );
        const journalFile = path.join(
            fixture.workspace,
            ".craflet/group-operation.json",
        );
        expect(await readJson(journalFile)).toMatchObject({
            phase: "applying",
        });
        expect((await readState(fixture.projects[0].dir)).active?.id).toBe(
            required(required(before[0]).pending).id,
        );
        expect((await readState(fixture.projects[1].dir)).active?.id).toBe(
            required(required(before[1]).active).id,
        );
        expect(await group.recover(true)).toBe(true);
        expect(await exists(journalFile)).toBe(true);
        failure.mockRestore();
        expect(await group.recover()).toBe(true);
        expect(
            await Promise.all(
                fixture.projects.map(
                    async (project) =>
                        (await readState(project.dir)).active?.id,
                ),
            ),
        ).toEqual(before.map((state) => state.pending?.id));
        expect(await exists(journalFile)).toBe(false);
        expect(await group.recover()).toBe(false);
        expect(
            controlled.starts.every((start) => start.mock.calls.length === 0),
        ).toBe(true);
    });

    it("rejects recovery journals with mismatched membership or a changed intended installation", async () => {
        const fixture = await backupGroupFixture();
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        controlledStatuses(group, ["stopped", "stopped"]);
        const members = await Promise.all(
            fixture.projects.map(async (project) => ({
                key: project.lockKey,
                activeId: (await readState(project.dir)).active?.id ?? null,
                nextId: (await readState(project.dir)).active?.id ?? null,
            })),
        );
        const file = path.join(
            fixture.workspace,
            ".craflet/group-operation.json",
        );
        await writeJson(file, {
            schemaVersion: 1,
            group: "network",
            phase: "applied",
            members: [members[0], members[0]],
        });
        await expect(group.recover()).rejects.toMatchObject({
            code: "GROUP_JOURNAL",
        });
        await writeJson(file, {
            schemaVersion: 1,
            group: "network",
            phase: "applied",
            members,
            extra: true,
        });
        await expect(group.recover()).rejects.toMatchObject({
            code: "GROUP_JOURNAL",
        });
        await writeJson(file, {
            schemaVersion: 1,
            group: "network",
            phase: "applied",
            members,
        });
        await saveState(fixture.projects[1].dir, { schemaVersion: 1 });
        await expect(group.recover()).rejects.toMatchObject({
            code: "GROUP_RECOVERY_CONFLICT",
        });
        expect(await exists(file)).toBe(true);
        await rm(file);
    });

    it("records shared consent before a group restart and materializes each Paper EULA only before spawn", async () => {
        const fixture = await backupGroupFixture();
        vi.spyOn(java, "inspectJava").mockResolvedValue({
            executable: "fixture-java",
            major: 25,
            diagnostics: [],
        });
        const request = vi.fn(async () => {
            for (const project of fixture.projects)
                expect(
                    await exists(path.join(project.dir, "runtime/eula.txt")),
                ).toBe(false);
        });
        const group = new NodeRecoveryGroup(
            fixture.batch,
            fixture.store,
            undefined,
            { requestEulaConsent: request },
        );
        const controlled = controlledStatuses(group, ["running", "running"]);
        await group.operate("restart", true);
        expect(request).toHaveBeenCalledOnce();
        expect(
            controlled.stops.every((stop) => stop.mock.calls.length === 1),
        ).toBe(true);
        expect(
            controlled.starts.every((start) => start.mock.calls.length === 1),
        ).toBe(true);
        for (const project of fixture.projects)
            expect(
                await readFile(
                    path.join(project.dir, "runtime/eula.txt"),
                    "utf8",
                ),
            ).toBe("eula=true\n");
        expect(await exists(path.join(fixture.home, "eula.json"))).toBe(true);
    });

    it.each([
        { action: "start" as const, initial: ["stopped", "stopped"] as const },
        {
            action: "restart" as const,
            initial: ["running", "running"] as const,
        },
    ])(
        "applies pending Paper installations and starts the group during $action",
        async ({ action, initial }) => {
            const fixture = await backupGroupFixture();
            await fixture.stageNext();
            await ensureUserEulaConsent(fixture.home, async () => undefined);
            vi.spyOn(java, "inspectJava").mockResolvedValue({
                executable: "fixture-java",
                major: 25,
                diagnostics: [],
            });
            const request = vi.fn(async () => {
                throw new Error("Saved consent must not prompt again");
            });
            const group = new NodeRecoveryGroup(
                fixture.batch,
                fixture.store,
                undefined,
                { requestEulaConsent: request },
            );
            const controlled = controlledStatuses(group, [...initial]);
            const pendingIds = await Promise.all(
                fixture.projects.map(
                    async (project) =>
                        required((await readState(project.dir)).pending).id,
                ),
            );

            await expect(group.operate(action)).resolves.toHaveLength(2);

            expect(request).not.toHaveBeenCalled();
            expect(controlled.current).toEqual(["running", "running"]);
            expect(
                controlled.starts.every(
                    (start, index) =>
                        start.mock.calls[0]?.[0] === pendingIds[index],
                ),
            ).toBe(true);
            for (const project of fixture.projects) {
                expect(
                    await readFile(
                        path.join(project.dir, "runtime/eula.txt"),
                        "utf8",
                    ),
                ).toBe("eula=true\n");
                expect((await readState(project.dir)).pending).toBeUndefined();
            }
            expect(
                await exists(
                    path.join(
                        fixture.workspace,
                        ".craflet/group-operation.json",
                    ),
                ),
            ).toBe(false);
        },
    );

    it("verifies an owned group journal larger than the EULA file limit by exact digest", async () => {
        const fixture = await backupGroupFixture();
        await ensureUserEulaConsent(fixture.home, async () => undefined);
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        const controlled = controlledStatuses(group, ["stopped", "stopped"]);
        const manager = required(group.managers[0]);
        const activeId = required(
            (await readState(fixture.projects[0].dir)).active,
        ).id;
        const content = `${JSON.stringify(
            {
                schemaVersion: 1,
                group: "network",
                phase: "spawned",
                members: Array.from({ length: 700 }, (_, index) => ({
                    key: `servers/member-${index}`,
                    activeId: "a".repeat(64),
                    nextId: "b".repeat(64),
                })),
            },
            null,
            4,
        )}\n`;
        expect(Buffer.byteLength(content)).toBeGreaterThan(64 * 1024);
        const journalFile = path.join(
            fixture.workspace,
            ".craflet/group-operation.json",
        );
        const owned = createOwnedEulaOperationJournal(journalFile, content);
        const tampered = content.replace(
            '"phase": "spawned"',
            '"phase": "stopped"',
        );
        expect(tampered).not.toBe(content);
        expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(content));
        await writeBackupTestFile(
            fixture.workspace,
            ".craflet/group-operation.json",
            tampered,
        );

        await expect(
            manager.spawnActive(activeId, owned),
        ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(controlled.starts[0]).not.toHaveBeenCalled();

        await writeBackupTestFile(
            fixture.workspace,
            ".craflet/group-operation.json",
            content,
        );
        await expect(
            manager.spawnActive(activeId, owned),
        ).resolves.toMatchObject({ status: "running", activeId });
        expect(controlled.starts[0]).toHaveBeenCalledWith(activeId);
        expect(
            await readFile(
                path.join(fixture.projects[0].dir, "runtime/eula.txt"),
                "utf8",
            ),
        ).toBe("eula=true\n");
    });

    it("starts stopped Paper members without rewriting a running member's EULA", async () => {
        const fixture = await backupGroupFixture();
        await ensureUserEulaConsent(fixture.home, async () => undefined);
        vi.spyOn(java, "inspectJava").mockResolvedValue({
            executable: "fixture-java",
            major: 25,
            diagnostics: [],
        });
        const request = vi.fn(async () => {
            throw new Error("Saved consent must not prompt again");
        });
        const group = new NodeRecoveryGroup(
            fixture.batch,
            fixture.store,
            undefined,
            { requestEulaConsent: request },
        );
        const controlled = controlledStatuses(group, ["running", "stopped"]);

        await expect(group.operate("start")).resolves.toHaveLength(2);

        expect(request).not.toHaveBeenCalled();
        expect(controlled.current).toEqual(["running", "running"]);
        expect(
            await exists(
                path.join(fixture.projects[0].dir, "runtime/eula.txt"),
            ),
        ).toBe(false);
        expect(
            await readFile(
                path.join(fixture.projects[1].dir, "runtime/eula.txt"),
                "utf8",
            ),
        ).toBe("eula=true\n");
    });

    it("starts existing active installations without applying pending and requires restart for mixed running state", async () => {
        const fixture = await backupGroupFixture();
        const group = new NodeRecoveryGroup(fixture.batch, fixture.store);
        const controlled = controlledStatuses(group, ["running", "running"]);
        expect(await group.operate("start")).toEqual(
            fixture.projects.map((project) => ({
                project: project.manifest.name,
                status: expect.objectContaining({
                    status: "running",
                }),
            })),
        );
        expect(
            controlled.starts.every((start) => start.mock.calls.length === 0),
        ).toBe(true);
        await fixture.stageNext();
        controlled.current[1] = "stopped";
        await expect(group.operate("start")).rejects.toMatchObject({
            code: "GROUP_RESTART_REQUIRED",
        });
        for (const manager of group.managers)
            vi.spyOn(manager, "preflight").mockResolvedValue(undefined);
        for (const project of fixture.projects)
            await writeBackupTestFile(
                project.dir,
                "runtime/eula.txt",
                "eula=true\n",
            );
        await group.operate("restart", true);
        expect(fixture.engine.snapshots.size).toBe(0);
        expect(controlled.current).toEqual(["running", "running"]);
        expect(
            (await readState(fixture.projects[0].dir)).pending,
        ).toBeDefined();
        expect(controlled.stops[0]).toHaveBeenCalledOnce();
        expect(controlled.stops[1]).not.toHaveBeenCalled();
    });
});
