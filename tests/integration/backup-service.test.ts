import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    NodeBackupService,
    validateBackupMetadata,
    validateBackupRelativePath,
} from "../../packages/adapters/src/restic/backup-service.js";
import type { BackupConfig } from "../../packages/core/src/domain/backup.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    FixtureRestic,
    TEST_REPOSITORY_ID,
    writeBackupTestFile,
} from "./backup-fixtures.js";

afterEach(cleanupBackupTestDirectories);

async function fixture(overrides: Partial<BackupConfig> = {}) {
    const root = await backupTestDirectory();
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const repository = path.join(root, "repository");
    await mkdir(repository);
    await writeBackupTestFile(
        project,
        "runtime/world/level.dat",
        "world before backup",
    );
    await writeBackupTestFile(
        project,
        "runtime/plugins/own.jar",
        "excluded jar",
    );
    await writeBackupTestFile(
        project,
        "runtime/.secret",
        "private runtime data",
    );
    const engine = new FixtureRestic();
    const config: BackupConfig = {
        projectId: "test-project",
        repository: "local",
        repositories: {
            local: {
                path: repository,
                password: { env: "CRAFLEET_TEST_PASSWORD" },
                id: TEST_REPOSITORY_ID,
            },
        },
        files: ["**", "!**/*.jar"],
        retention: { keepLast: 2 },
        ...overrides,
    };
    const service = new NodeBackupService(
        project,
        home,
        config,
        async () => "repository-secret",
        {
            runner: engine.runner,
            bootstrap: {
                prepare: async () => ({
                    path: "fixture-restic",
                    version: "0.19.1",
                }),
            },
        },
    );
    return { root, project, home, repository, service, engine, config };
}

describe("backup service safety with real staging files and a fault-injected restic port", () => {
    it("records active metadata and restores only to a separate empty directory", async () => {
        const { root, project, home, service, engine } = await fixture();
        const active = {
            generation: "active-g1",
            lockSlice: { server: { version: "fixed" }, plugins: [] },
        };
        const preflight = await service.preflight();
        expect(preflight.files).toHaveLength(2);
        const result = await service.create(active);
        expect(result.metadata.active).toEqual(active);
        expect(result.fileCount).toBe(preflight.files.length);
        expect(result.metadata.files.map((file) => file.destination)).toEqual(
            preflight.files.map((file) => file.destination),
        );
        expect(await readdir(path.join(home, "tmp", "backup"))).toEqual([]);
        expect((await service.list())[0]?.id).toBe(result.snapshotId);
        expect(await service.show(result.snapshotId)).toEqual(result.metadata);
        expect(await service.check({ readData: true })).toEqual({
            checked: true,
        });
        expect(
            await service.diff(result.snapshotId, result.snapshotId),
        ).toHaveLength(1);
        const target = path.join(root, "restored");
        const plannedRestore = await service.planRestore(result.snapshotId, {
            target,
        });
        expect(plannedRestore.requiredBytes).toBe(
            plannedRestore.dataBytes +
                plannedRestore.archiveBytes +
                16 * 1024 * 1024,
        );
        expect(plannedRestore.dataBytes).toBeGreaterThan(result.bytes);
        expect(await readdir(root)).not.toContain("restored");
        const restored = await service.restore(result.snapshotId, { target });
        expect(restored.metadata.active).toEqual(active);
        expect(
            await readFile(
                path.join(target, "data/runtime/world/level.dat"),
                "utf8",
            ),
        ).toBe("world before backup");
        expect(
            await readFile(
                path.join(project, "runtime/world/level.dat"),
                "utf8",
            ),
        ).toBe("world before backup");
        expect(await readdir(target)).not.toContain(
            ".crafleet-restore-incomplete.json",
        );
        expect(
            engine.calls.find((call) => call.args.includes("backup"))?.args,
        ).toContain("--files-from-raw");
        expect(
            engine.calls.some((call) =>
                call.args.some((arg) => arg.includes("repository-secret")),
            ),
        ).toBe(false);
        expect(engine.calls.some((call) => call.args.includes("restore"))).toBe(
            false,
        );
        expect(
            engine.calls.find((call) => call.args.includes("--archive"))
                ?.maxFileOutputBytes,
        ).toBe(plannedRestore.archiveBytes);
    });

    it("matches project-relative runtime, shared data and explicit outside roots identically in plan and create", async () => {
        const { root, project, service } = await fixture({
            files: [
                "runtime/**",
                "shared-data/**",
                "../external/**",
                "!**/*.[jJ][aA][rR]",
                "!runtime/logs/**",
                "runtime/logs/keep.txt",
            ],
        });
        await writeBackupTestFile(
            project,
            "shared-data/player.data",
            "shared player",
        );
        await writeBackupTestFile(
            project,
            "shared-data/custom.JaR",
            "excluded custom jar",
        );
        await writeBackupTestFile(
            project,
            "runtime/logs/skip.txt",
            "excluded log",
        );
        await writeBackupTestFile(
            project,
            "runtime/logs/keep.txt",
            "explicitly included log",
        );
        await writeBackupTestFile(
            project,
            "config/template.yml",
            "not operational data",
        );
        await writeBackupTestFile(
            root,
            "external/player.data",
            "external player",
        );
        await writeBackupTestFile(
            root,
            "external/custom.JAR",
            "excluded external jar",
        );
        const plan = await service.plan();
        const selected = plan.files
            .map((file) =>
                path.relative(project, file.source).replaceAll("\\", "/"),
            )
            .sort();
        expect(selected).toEqual([
            "../external/player.data",
            "runtime/.secret",
            "runtime/logs/keep.txt",
            "runtime/world/level.dat",
            "shared-data/player.data",
        ]);
        const saved = await service.create({ generation: "active" });
        expect(saved.metadata.files.map((file) => file.destination)).toEqual(
            plan.files.map((file) => file.destination),
        );
        const shared = saved.metadata.roots.find(
            (entry) => entry.path === path.join(project, "shared-data"),
        );
        const external = saved.metadata.roots.find(
            (entry) => entry.path === path.join(root, "external"),
        );
        expect(shared?.external).toBe(true);
        expect(external?.external).toBe(true);
        const target = path.join(root, "restored");
        await service.restore(saved.snapshotId, { target });
        expect(
            await readFile(
                path.join(target, `data/external/${shared?.id}/player.data`),
                "utf8",
            ),
        ).toBe("shared player");
        expect(
            await readFile(
                path.join(target, `data/external/${external?.id}/player.data`),
                "utf8",
            ),
        ).toBe("external player");
        expect(
            await readFile(
                path.join(target, "data/runtime/logs/keep.txt"),
                "utf8",
            ),
        ).toBe("explicitly included log");
    });

    it("uses one injected selected-files provider for group previews and snapshot staging", async () => {
        const { root, project, home, service, engine, config } =
            await fixture();
        const selected = await service.plan();
        selected.roots = selected.roots.map((entry) => ({
            ...entry,
            id: "member-a",
            external: true,
        }));
        selected.files = selected.files.map((file) => ({
            ...file,
            rootId: "member-a",
            destination: file.destination.replace(
                "data/runtime/",
                "data/external/member-a/",
            ),
        }));
        let plans = 0;
        const group = new NodeBackupService(
            project,
            home,
            { ...config, projectId: "group-fixture", files: [] },
            async () => "repository-secret",
            {
                runner: engine.runner,
                bootstrap: {
                    prepare: async () => ({
                        path: "fixture-restic",
                        version: "0.19.1",
                    }),
                },
                planFiles: async () => {
                    plans++;
                    return structuredClone(selected);
                },
            },
        );
        const preview = await group.plan();
        const saved = await group.create({ group: { members: ["member-a"] } });
        expect(plans).toBe(2);
        expect(saved.metadata.files.map((file) => file.destination)).toEqual(
            preview.files.map((file) => file.destination),
        );
        expect(saved.metadata.roots.every((entry) => entry.external)).toBe(
            true,
        );
        const target = path.join(root, "group-restore");
        await group.restore(saved.snapshotId, { target });
        expect(
            await readFile(
                path.join(target, "data/external/member-a/world/level.dat"),
                "utf8",
            ),
        ).toBe("world before backup");
    });

    it("does not initialize repositories during create and detects changed repository IDs", async () => {
        const { service, engine } = await fixture();
        engine.initialized = false;
        await expect(
            service.create({ generation: "g1" }),
        ).rejects.toMatchObject({ code: "BACKUP_REPOSITORY" });
        expect(engine.calls.some((call) => call.args.includes("init"))).toBe(
            false,
        );
        engine.initialized = true;
        engine.repositoryId = "e".repeat(64);
        await expect(service.preflight()).rejects.toMatchObject({
            code: "BACKUP_REPOSITORY_ID",
        });
        expect(engine.calls.some((call) => call.args.includes("backup"))).toBe(
            false,
        );
    });

    it("requires explicit setup initialization and verifies existing IDs", async () => {
        const { service, engine, repository } = await fixture();
        engine.initialized = false;
        await expect(service.setup("local")).rejects.toMatchObject({
            code: "BACKUP_REPOSITORY_UNINITIALIZED",
        });
        expect(
            await service.setup("local", { initialize: true, confirm: true }),
        ).toEqual({ alias: "local", path: repository, id: TEST_REPOSITORY_ID });
        await expect(
            service.setup("local", { expectedId: "e".repeat(64) }),
        ).rejects.toMatchObject({ code: "BACKUP_REPOSITORY_ID" });
    });

    it("rejects nonempty setup destinations rather than reinitializing them", async () => {
        const { service, engine, repository } = await fixture();
        engine.initialized = false;
        await writeBackupTestFile(repository, "unrelated", "valuable data");
        await expect(
            service.setup("local", { initialize: true, confirm: true }),
        ).rejects.toMatchObject({ code: "BACKUP_REPOSITORY_NONEMPTY" });
        expect(engine.calls.some((call) => call.args.includes("init"))).toBe(
            false,
        );
    });

    it("treats restic exit 3 as failure and cleans private staging", async () => {
        const { home, service, engine } = await fixture();
        engine.backupExit = 3;
        await expect(
            service.create({ generation: "g1" }),
        ).rejects.toMatchObject({ code: "BACKUP_INCOMPLETE" });
        expect(await readdir(path.join(home, "tmp", "backup"))).toEqual([]);
        expect(engine.snapshots.size).toBe(1);
        engine.backupExit = 2;
        await expect(
            service.create({ generation: "g1" }),
        ).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    });

    it("rejects implicit aliases, missing pinned IDs and self inclusion", async () => {
        const missing = await fixture();
        delete missing.config.repository;
        await expect(missing.service.list()).rejects.toMatchObject({
            code: "BACKUP_REPOSITORY",
        });
        const { config, service, project } = await fixture();
        const local = config.repositories?.local;
        if (!local) throw new Error("fixture repository");
        delete local.id;
        await expect(service.list()).rejects.toMatchObject({
            code: "BACKUP_REPOSITORY_ID",
        });
        local.id = TEST_REPOSITORY_ID;
        local.path = path.join(project, "runtime", "repository");
        await expect(service.list()).rejects.toMatchObject({
            code: "BACKUP_SELF_INCLUSION",
        });
        local.path = "sftp:host:/repo";
        await expect(service.list()).rejects.toMatchObject({
            code: "BACKUP_REPOSITORY_PATH",
        });
        await expect(
            service.list({ repository: "unknown" }),
        ).rejects.toMatchObject({ code: "BACKUP_REPOSITORY" });
    });

    it("keeps retention non-destructive by default and scopes deletion to its project", async () => {
        const { service, engine } = await fixture();
        await service.create({ generation: "g1" });
        const planned = await service.prune();
        expect(planned.applied).toBe(false);
        expect(
            engine.calls
                .filter((call) => call.args.includes("forget"))
                .every((call) => call.args.includes("--dry-run")),
        ).toBe(true);
        await expect(service.prune({ apply: true })).rejects.toMatchObject({
            code: "BACKUP_PRUNE_CONFIRM",
        });
        expect(
            (await service.prune({ apply: true, confirm: true })).applied,
        ).toBe(true);
        const applied = engine.calls.find((call) =>
            call.args.includes("--prune"),
        );
        expect(applied?.args).toContain("crafleet-project:test-project");
    });

    it("refuses live, nonempty, linked and undeclared restore targets/content", async () => {
        const { root, project, service, engine } = await fixture();
        const result = await service.create({ generation: "g1" });
        await expect(
            service.restore(result.snapshotId, {
                target: path.join(project, "runtime"),
            }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_TARGET" });
        const nonempty = path.join(root, "nonempty");
        await writeBackupTestFile(nonempty, "keep", "preserve");
        await expect(
            service.restore(result.snapshotId, { target: nonempty }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_TARGET" });
        engine.treeExtra.push({
            struct_type: "node",
            type: "symlink",
            path: "/data/runtime/link",
        });
        await expect(
            service.restore(result.snapshotId, {
                target: path.join(root, "restored"),
            }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_TREE" });
        engine.treeExtra = [
            { struct_type: "node", type: "file", path: "/undeclared" },
        ];
        await expect(
            service.restore(result.snapshotId, {
                target: path.join(root, "restored"),
            }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_TREE" });
        engine.treeExtra = [
            { struct_type: "node", type: "dir", path: "/undeclared" },
        ];
        await expect(
            service.restore(result.snapshotId, {
                target: path.join(root, "restored"),
            }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_TREE" });
        expect(
            engine.calls.some((call) => call.args.includes("--archive")),
        ).toBe(false);
    });

    it("preserves a visible incomplete marker after restore failure", async () => {
        const { root, service, engine } = await fixture();
        const result = await service.create({ generation: "g1" });
        engine.restoreExit = 1;
        const target = path.join(root, "failed-restore");
        await expect(
            service.restore(result.snapshotId, { target }),
        ).rejects.toMatchObject({ code: "BACKUP_REPOSITORY" });
        expect(
            JSON.parse(
                await readFile(
                    path.join(target, ".crafleet-restore-incomplete.json"),
                    "utf8",
                ),
            ).status,
        ).toBe("restoring");
        await expect(
            service.restore(result.snapshotId, { target }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_TARGET" });
    });

    it("detects corrupted restored data and never modifies the original", async () => {
        const { root, project, service, engine } = await fixture();
        const result = await service.create({ generation: "g1" });
        engine.snapshots
            .get(result.snapshotId)
            ?.files.set(
                "data/runtime/world/level.dat",
                Buffer.alloc(Buffer.byteLength("world before backup"), 0x43),
            );
        await expect(
            service.restore(result.snapshotId, {
                target: path.join(root, "corrupt"),
            }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_VERIFY" });
        expect(
            await readFile(
                path.join(project, "runtime/world/level.dat"),
                "utf8",
            ),
        ).toBe("world before backup");
    });

    it("rejects payload entries that appear only in the ZIP after tree inspection", async () => {
        const { root, service, engine } = await fixture();
        const result = await service.create({ generation: "g1" });
        engine.archiveTransform = (entries) => [
            ...entries,
            { name: "data/runtime/undeclared", bytes: Buffer.from("unlisted") },
        ];
        const target = path.join(root, "undeclared-archive");
        await expect(
            service.restore(result.snapshotId, { target }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
        expect(await readdir(target)).toContain(
            ".crafleet-restore-incomplete.json",
        );
        expect(
            (await readdir(target)).some((name) =>
                name.startsWith(".crafleet-restore-work-"),
            ),
        ).toBe(false);
    });

    it("rechecks empty targets after repository inspection and preserves newly created content", async () => {
        const { root, service, engine } = await fixture();
        const result = await service.create({ generation: "g1" });
        const target = path.join(root, "concurrent");
        engine.nextResult = async (request) => {
            if (request.args.includes("ls"))
                await writeBackupTestFile(
                    target,
                    "keep",
                    "concurrently created",
                );
            return undefined;
        };
        await expect(
            service.restore(result.snapshotId, { target }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_TARGET" });
        expect(await readFile(path.join(target, "keep"), "utf8")).toBe(
            "concurrently created",
        );
        expect(
            engine.calls.some((call) => call.args.includes("--archive")),
        ).toBe(false);
    });

    it("rejects undeclared directories introduced after extraction begins", async () => {
        const { root, service, engine } = await fixture();
        const result = await service.create({ generation: "g1" });
        const target = path.join(root, "unexpected-directory");
        engine.nextResult = async (request) => {
            if (request.args.includes("--archive"))
                await mkdir(path.join(target, "undeclared"));
            return undefined;
        };
        await expect(
            service.restore(result.snapshotId, { target }),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_VERIFY" });
        expect(await readdir(target)).toContain(
            ".crafleet-restore-incomplete.json",
        );
    });

    it("rejects foreign or malformed metadata and escaping paths", async () => {
        const { service } = await fixture();
        const result = await service.create({ generation: "g1" });
        expect(() =>
            validateBackupMetadata(result.metadata, "different-project"),
        ).toThrow();
        expect(() => validateBackupMetadata({}, "test-project")).toThrow();
        for (const invalid of [
            "",
            "/absolute",
            "../outside",
            "data/../outside",
            "a//b",
            "a\\b",
            "a\0b",
        ])
            expect(() => validateBackupRelativePath(invalid)).toThrow();
        expect(validateBackupRelativePath("data/runtime/world/level.dat")).toBe(
            "data/runtime/world/level.dat",
        );
        expect(() =>
            validateBackupMetadata(
                {
                    ...result.metadata,
                    files: [...result.metadata.files, result.metadata.files[0]],
                },
                "test-project",
            ),
        ).toThrow(/colliding/u);
    });

    it("rejects missing snapshot IDs and oversized active metadata without taking a backup", async () => {
        const { service, engine } = await fixture();
        engine.nextResult = (request) =>
            request.args.includes("backup")
                ? { exitCode: 0, stdout: "{}", stderr: "" }
                : undefined;
        await expect(
            service.create({ generation: "g1" }),
        ).rejects.toMatchObject({ code: "BACKUP_SNAPSHOT" });
        await expect(
            service.create({ large: "a".repeat(4 * 1024 * 1024) }),
        ).rejects.toMatchObject({ code: "BACKUP_ACTIVE_METADATA" });
        await expect(
            service.create({ unicode: "界".repeat(2 * 1024 * 1024) }),
        ).rejects.toMatchObject({ code: "BACKUP_ACTIVE_METADATA" });
        await expect(service.show("latest")).rejects.toMatchObject({
            code: "BACKUP_SNAPSHOT",
        });
    });

    it("routes registered SQLite files through database metadata instead of implicit file restoration", async () => {
        const { project, service } = await fixture({
            databases: [
                { id: "players", kind: "sqlite", path: "runtime/players.db" },
            ],
        });
        await writeBackupTestFile(project, "runtime/players.db", "fixture");
        await writeBackupTestFile(project, "runtime/players.db-wal", "fixture");
        const plan = await service.plan();
        expect(plan.databaseIds).toEqual(["players"]);
        expect(
            plan.files.some((file) => file.source.includes("players.db")),
        ).toBe(false);
        expect(plan.warnings.join("\n")).toContain("SQLite");
    });

    it("does not swallow invalid JSON or repository exit failures", async () => {
        const { service, engine } = await fixture();
        engine.nextResult = (request) =>
            request.args.includes("cat")
                ? { exitCode: 0, stdout: "not json", stderr: "" }
                : undefined;
        await expect(service.list()).rejects.toMatchObject({
            code: "BACKUP_JSON",
        });
        engine.nextResult = (request) =>
            request.args.includes("cat")
                ? { exitCode: 12, stdout: "", stderr: "repository-secret" }
                : undefined;
        await expect(service.list()).rejects.not.toThrow(/repository-secret/u);
        engine.nextResult = (request) =>
            request.args.includes("cat")
                ? { exitCode: 0, stdout: "{}", stderr: "" }
                : undefined;
        await expect(service.list()).rejects.toMatchObject({
            code: "BACKUP_REPOSITORY_ID",
        });
    });
});
