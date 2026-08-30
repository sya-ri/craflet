import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    type BackupConfig,
    type BackupMetadata,
    CrafleetError,
    type DatabaseBackupConfig,
    stableStringify,
} from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeDatabaseBackupAdapter } from "../../packages/adapters/src/database/backup.js";
import { NodeArtifactStore } from "../../packages/adapters/src/filesystem/artifact-store.js";
import * as backupFiles from "../../packages/adapters/src/filesystem/backup-files.js";
import { NodeConfigManager } from "../../packages/adapters/src/filesystem/config.js";
import { NodeDeploymentManager } from "../../packages/adapters/src/filesystem/deployment.js";
import { installProjects } from "../../packages/adapters/src/filesystem/installations.js";
import * as io from "../../packages/adapters/src/filesystem/io.js";
import {
    initProject,
    loadProject,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import {
    applyBackupRestore,
    executePreparedRestore,
    inspectBackupRestore,
    type PreparedRestoreApplication,
    prepareRestoreApplication,
    type RestoreApplyOptions,
    recoverBackupRestore,
} from "../../packages/adapters/src/filesystem/restore.js";
import {
    type Installation,
    readState,
    saveState,
} from "../../packages/adapters/src/filesystem/state.js";
import {
    NodeBackupService,
    validateBackupMetadata,
} from "../../packages/adapters/src/restic/backup-service.js";
import { NodeServerController } from "../../packages/adapters/src/runtime/controller.js";
import { artifactJar, artifactZip } from "./artifacts-fixture.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    FixtureRestic,
    writeBackupTestFile as put,
    TEST_REPOSITORY_ID,
} from "./backup-fixtures.js";

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupBackupTestDirectories();
});

const sha = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");

async function tree(root: string): Promise<Record<string, string>> {
    return Object.fromEntries(
        await Promise.all(
            (await io.listFiles(root)).map(async (relative) => [
                relative,
                (await readFile(path.join(root, relative))).toString("base64"),
            ]),
        ),
    );
}

async function fixture(
    options: { external?: boolean; fileRoot?: boolean } = {},
) {
    const root = await backupTestDirectory();
    const dir = path.join(root, "project");
    const home = path.join(root, "home");
    const source = path.join(root, "extracted");
    const repository = path.join(root, "repository");
    await mkdir(repository);
    const manifest = await initProject(dir, {
        name: "restore-fixture",
        kind: "paper",
        version: "26.1",
        source: "file:imports/server.jar",
    });
    manifest.plugins.Example = "file:imports/example.jar";
    await writeYaml(path.join(dir, "crafleet.yaml"), manifest);
    const server = artifactZip([
        {
            name: "META-INF/MANIFEST.MF",
            content: "Manifest-Version: 1.0\nImplementation-Version: old\n",
        },
    ]);
    await put(dir, "imports/server.jar", server);
    await put(dir, "imports/example.jar", artifactJar("Example", "1.0.0"));
    await put(dir, "config/server.properties", "motd=old\n");
    const context = await loadProject(dir, home);
    const store = new NodeArtifactStore(home);
    await installProjects([context], store, { offline: true });
    await new NodeDeploymentManager(context, store).applyPrepared();
    await put(dir, "runtime/world/level.dat", "snapshot-world");
    await put(dir, "runtime/keep.log", "excluded-current");
    if (options.external)
        await put(dir, "shared-data/scores.dat", "snapshot-scores");
    const config: BackupConfig = {
        projectId: manifest.id ?? "restore-fixture",
        repository: "local",
        repositories: {
            local: {
                path: repository,
                password: { env: "CRAFLEET_FIXTURE_BACKUP_PASSWORD" },
                id: TEST_REPOSITORY_ID,
            },
        },
        files: [
            "runtime/**",
            ...(options.external
                ? [
                      options.fileRoot
                          ? "shared-data/scores.dat"
                          : "shared-data/**",
                  ]
                : []),
            "!runtime/keep.log",
            "!**/*.[jJ][aA][rR]",
        ],
    };
    const engine = new FixtureRestic();
    const backup = new NodeBackupService(
        dir,
        home,
        config,
        async () => "fixture-repository-password",
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
    const active = (await readState(dir)).active;
    if (!active) throw new Error("Expected active fixture installation");
    // Exercise the actual filesystem snapshot planner/stager. The binary process
    // port is a fixture only for the safety backup made by public apply().
    const plan = await backup.plan();
    const files = await backupFiles.stageBackupPlan(plan, source);
    const metadata: BackupMetadata = {
        format: 1,
        projectId: config.projectId ?? "restore-fixture",
        createdAt: new Date().toISOString(),
        active: { installation: active },
        roots: plan.roots,
        files,
        databases: [],
    };
    validateBackupMetadata(metadata, metadata.projectId);
    await io.writeJson(path.join(source, "metadata/backup.json"), metadata);
    await io.writeJson(
        path.join(source, "metadata/active.json"),
        metadata.active,
    );
    await put(dir, "runtime/world/level.dat", "current-world");
    await put(dir, "runtime/world/new.dat", "new-since-snapshot");
    if (options.external)
        await put(dir, "shared-data/scores.dat", "current-scores");
    return {
        root,
        dir,
        home,
        source,
        repository,
        context,
        store,
        config,
        backup,
        engine,
        metadata,
        active,
        server,
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function changeMetadata(
    current: Fixture,
    change: (metadata: BackupMetadata) => void,
): Promise<BackupMetadata> {
    const metadata = await io.readJson<BackupMetadata>(
        path.join(current.source, "metadata/backup.json"),
    );
    change(metadata);
    await io.writeJson(
        path.join(current.source, "metadata/backup.json"),
        metadata,
    );
    await io.writeJson(
        path.join(current.source, "metadata/active.json"),
        metadata.active,
    );
    return metadata;
}

async function prepare(
    current: Fixture,
    options: RestoreApplyOptions = {},
): Promise<PreparedRestoreApplication> {
    return prepareRestoreApplication(
        current.context,
        current.source,
        { offline: true, ...options },
        current.store,
        current.backup,
    );
}

async function execute(
    current: Fixture,
    prepared: PreparedRestoreApplication,
    checkpoint?: (stage: string) => Promise<void>,
): Promise<void> {
    return io.withMutex(
        path.join(current.context.lockRoot, ".crafleet/operation.lock"),
        () =>
            executePreparedRestore(
                current.context,
                prepared,
                current.store,
                current.backup,
                {
                    operationLockHeld: true,
                    preRestoreSnapshot: "fixture-pre-restore-snapshot",
                    ...(checkpoint ? { checkpoint } : {}),
                },
            ),
    );
}

async function addDatabase(
    current: Fixture,
    config: DatabaseBackupConfig,
    bytes: Buffer | string,
): Promise<void> {
    const file = `databases/${config.id}.${config.kind === "sqlite" ? "sqlite3" : "sql"}`;
    await put(current.source, file, bytes);
    await changeMetadata(current, (metadata) => {
        metadata.databases.push({
            id: config.id,
            kind: config.kind,
            file,
            sha256: sha(bytes),
            bytes: Buffer.byteLength(bytes),
        });
    });
    current.config.databases ??= [];
    current.config.databases.push(config);
}

describe("verified production restore application", () => {
    it("previews exact file changes without downloads, stopping, metadata or cache writes", async () => {
        const current = await fixture();
        const before = await tree(current.root);
        const ensure = vi.spyOn(current.store, "ensure");
        const stop = vi.spyOn(NodeServerController.prototype, "stop");
        const create = vi.spyOn(current.backup, "create");
        const result = await applyBackupRestore(
            current.context,
            current.source,
            { dryRun: true },
            current.store,
            current.backup,
        );
        expect(result).toMatchObject({
            startAfterApply: false,
            sharedLockUnchanged: true,
            changes: expect.arrayContaining([
                {
                    target: path.join(current.dir, "runtime/world/new.dat"),
                    before: sha("new-since-snapshot"),
                    after: null,
                    kind: "data",
                },
            ]),
        });
        expect(ensure).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(await tree(current.root)).toEqual(before);
    });

    it("saves a pre-restore snapshot, restores selected data and exact old JARs, drops pending without auto-start", async () => {
        const current = await fixture();
        await put(
            current.dir,
            "imports/server.jar",
            artifactZip([
                {
                    name: "META-INF/MANIFEST.MF",
                    content:
                        "Manifest-Version: 1.0\nImplementation-Version: new\n",
                },
            ]),
        );
        await put(
            current.dir,
            "imports/example.jar",
            artifactJar("Example", "2.0.0"),
        );
        await put(
            current.dir,
            "imports/extra.jar",
            artifactJar("Extra", "1.0.0"),
        );
        current.context.manifest.plugins.Extra = "file:imports/extra.jar";
        await writeYaml(
            path.join(current.dir, "crafleet.yaml"),
            current.context.manifest,
        );
        current.context = await loadProject(current.dir, current.home);
        await installProjects([current.context], current.store, {
            offline: true,
            updateServer: true,
            updateAllPlugins: true,
        });
        await new NodeDeploymentManager(
            current.context,
            current.store,
        ).applyPrepared();
        expect(
            await readFile(path.join(current.dir, "runtime/server.jar")),
        ).not.toEqual(current.server);
        expect(
            await readFile(
                path.join(current.dir, "runtime/plugins/Example.jar"),
            ),
        ).toEqual(artifactJar("Example", "2.0.0"));
        await put(
            current.dir,
            "config/server.properties",
            "motd=desired-future\n",
        );
        await installProjects([current.context], current.store, {
            offline: true,
        });
        const declarations = {
            manifest: await readFile(path.join(current.dir, "crafleet.yaml")),
            lock: await readFile(path.join(current.dir, "crafleet-lock.yaml")),
            base: await readFile(
                path.join(current.dir, "config/server.properties"),
            ),
        };
        const start = vi.spyOn(NodeServerController.prototype, "start");
        const create = vi.spyOn(current.backup, "create");
        const result = await applyBackupRestore(
            current.context,
            current.source,
            { offline: true },
            current.store,
            current.backup,
        );
        expect(result).toMatchObject({
            applied: true,
            pendingDiscarded: true,
            startAfterApply: false,
        });
        expect(create).toHaveBeenCalledTimes(1);
        await expect(create.mock.results[0]?.value).resolves.toMatchObject({
            metadata: {
                files: expect.arrayContaining([
                    {
                        destination: "data/runtime/world/level.dat",
                        sha256: sha("current-world"),
                        size: Buffer.byteLength("current-world"),
                        mode: expect.any(Number),
                    },
                ]),
            },
        });
        expect(start).not.toHaveBeenCalled();
        expect(
            await readFile(path.join(current.dir, "runtime/server.jar")),
        ).toEqual(current.server);
        expect(
            await readFile(
                path.join(current.dir, "runtime/plugins/Example.jar"),
            ),
        ).toEqual(artifactJar("Example", "1.0.0"));
        expect(
            await readFile(
                path.join(current.dir, "runtime/world/level.dat"),
                "utf8",
            ),
        ).toBe("snapshot-world");
        expect(
            await io.exists(path.join(current.dir, "runtime/world/new.dat")),
        ).toBe(false);
        expect(
            await readFile(path.join(current.dir, "runtime/keep.log"), "utf8"),
        ).toBe("excluded-current");
        expect((await readState(current.dir)).pending).toBeUndefined();
        expect(
            await io.exists(
                path.join(current.dir, "runtime/plugins/Extra.jar"),
            ),
        ).toBe(false);
        expect((await readState(current.dir)).active?.lock).toEqual(
            current.active.lock,
        );
        expect(await readFile(path.join(current.dir, "crafleet.yaml"))).toEqual(
            declarations.manifest,
        );
        expect(
            await readFile(path.join(current.dir, "crafleet-lock.yaml")),
        ).toEqual(declarations.lock);
        expect(
            await readFile(path.join(current.dir, "config/server.properties")),
        ).toEqual(declarations.base);
        expect(
            await io.exists(path.join(current.dir, ".crafleet/restore.json")),
        ).toBe(false);
    });

    it("stops a running server only after complete JAR, backup-tool and database preflight", async () => {
        const current = await fixture();
        const events: string[] = [];
        let running = true;
        vi.spyOn(NodeServerController.prototype, "status").mockImplementation(
            async () => ({ status: running ? "running" : "stopped" }),
        );
        vi.spyOn(NodeServerController.prototype, "stop").mockImplementation(
            async () => {
                events.push("stop");
                running = false;
                return { status: "stopped", clean: true };
            },
        );
        const originalPrepare = current.backup.prepare.bind(current.backup);
        vi.spyOn(current.backup, "prepare").mockImplementation(
            async (options) => {
                events.push("tool");
                return originalPrepare(options);
            },
        );
        const originalPreflight = current.backup.preflight.bind(current.backup);
        vi.spyOn(current.backup, "preflight").mockImplementation(
            async (options) => {
                events.push("preflight");
                return originalPreflight(options);
            },
        );
        await applyBackupRestore(
            current.context,
            current.source,
            { offline: true },
            current.store,
            current.backup,
        );
        expect(events.indexOf("tool")).toBeLessThan(events.indexOf("stop"));
        expect(events.indexOf("preflight")).toBeLessThan(
            events.indexOf("stop"),
        );
    });

    it.each(["artifact", "backup", "database", "stop"])(
        "does not write runtime or journal when %s preflight fails",
        async (failure) => {
            const current = await fixture();
            const before = await tree(current.dir);
            vi.spyOn(
                NodeServerController.prototype,
                "status",
            ).mockResolvedValue({ status: "running" });
            const stop = vi
                .spyOn(NodeServerController.prototype, "stop")
                .mockRejectedValue(
                    new CrafleetError("FIXTURE_STOP", "fixture stop failure"),
                );
            if (failure === "artifact")
                vi.spyOn(current.store, "ensure").mockRejectedValue(
                    new CrafleetError(
                        "FIXTURE_MISSING",
                        "exact old artifact unavailable",
                    ),
                );
            if (failure === "backup")
                vi.spyOn(current.backup, "prepare").mockRejectedValue(
                    new CrafleetError(
                        "FIXTURE_TOOL",
                        "fixture tool unavailable",
                    ),
                );
            if (failure === "database")
                vi.spyOn(
                    NodeDatabaseBackupAdapter.prototype,
                    "preflightRestore",
                ).mockRejectedValue(
                    new CrafleetError(
                        "FIXTURE_DATABASE",
                        "fixture database unavailable",
                    ),
                );
            await expect(
                applyBackupRestore(
                    current.context,
                    current.source,
                    { offline: true },
                    current.store,
                    current.backup,
                ),
            ).rejects.toBeInstanceOf(CrafleetError);
            expect(stop).toHaveBeenCalledTimes(failure === "stop" ? 1 : 0);
            expect(await tree(current.dir)).toEqual(before);
        },
    );

    it.each(["unknown", "starting", "stopping"] as const)(
        "refuses an unconfirmed %s process without touching data",
        async (status) => {
            const current = await fixture();
            vi.spyOn(
                NodeServerController.prototype,
                "status",
            ).mockResolvedValue({ status });
            const before = await tree(current.dir);
            await expect(
                applyBackupRestore(
                    current.context,
                    current.source,
                    {},
                    current.store,
                    current.backup,
                ),
            ).rejects.toBeInstanceOf(CrafleetError);
            expect(await tree(current.dir)).toEqual(before);
        },
    );

    it.each([
        ".crafleet/restore.json",
        ".crafleet/deploy.json",
        ".crafleet/import-incomplete.json",
        ".crafleet/manifest-transaction.json",
        ".crafleet/group-operation.json",
        ".crafleet/group-restore.json",
    ])(
        "blocks production application while %s awaits recovery",
        async (marker) => {
            const current = await fixture();
            await put(current.dir, marker, "{}");
            const before = await tree(current.dir);
            await expect(
                applyBackupRestore(
                    current.context,
                    current.source,
                    {},
                    current.store,
                    current.backup,
                ),
            ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
            expect(await tree(current.dir)).toEqual(before);
        },
    );

    it("does not allow single-member application of a configured recovery group", async () => {
        const current = await fixture();
        current.context.manifest.backup = {
            files: current.config.files,
            group: "network",
        };
        await expect(
            applyBackupRestore(
                current.context,
                current.source,
                { dryRun: true },
                current.store,
                current.backup,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_GROUP" });
    });
});

describe("restore extraction, mappings and protection boundaries", () => {
    it.each([
        "extra",
        "missing",
        "payload-hash",
        "payload-size",
        "active-mismatch",
        "no-installation",
        "foreign-installation",
        "unsafe-path",
        "incomplete",
    ])("rejects %s before changing any target", async (problem) => {
        const current = await fixture();
        const first = current.metadata.files[0];
        if (!first) throw new Error("Missing fixture data");
        if (problem === "extra")
            await put(current.source, "unlisted.txt", "unexpected");
        if (problem === "missing")
            await rm(path.join(current.source, first.destination));
        if (problem === "payload-hash")
            await put(
                current.source,
                first.destination,
                "changed snapshot bytes",
            );
        if (problem === "payload-size")
            await changeMetadata(current, (metadata) => {
                const file = metadata.files[0];
                if (file) file.size++;
            });
        if (problem === "active-mismatch")
            await io.writeJson(
                path.join(current.source, "metadata/active.json"),
                { another: "active" },
            );
        if (problem === "no-installation")
            await changeMetadata(current, (metadata) => {
                metadata.active = {};
            });
        if (problem === "foreign-installation")
            await changeMetadata(current, (metadata) => {
                (metadata.active.installation as Installation).manifest.id =
                    randomUUID();
            });
        if (problem === "unsafe-path")
            await changeMetadata(current, (metadata) => {
                const file = metadata.files[0];
                if (file) file.destination = "data/runtime/../../../outside";
            });
        if (problem === "incomplete")
            await put(
                current.source,
                ".crafleet-restore-incomplete.json",
                "{}",
            );
        const before = await tree(current.dir);
        await expect(
            inspectBackupRestore(
                current.context,
                current.source,
                {},
                current.backup,
            ),
        ).rejects.toBeInstanceOf(CrafleetError);
        expect(await tree(current.dir)).toEqual(before);
    });

    it.each(["project", "home", "linked"])(
        "refuses extraction from %s protected locations",
        async (location) => {
            const current = await fixture();
            let source = location === "project" ? current.dir : current.home;
            if (location === "linked") {
                source = path.join(current.root, "linked");
                await symlink(
                    current.source,
                    source,
                    process.platform === "win32" ? "junction" : "dir",
                );
            }
            await expect(
                inspectBackupRestore(
                    current.context,
                    source,
                    {},
                    current.backup,
                ),
            ).rejects.toBeInstanceOf(CrafleetError);
        },
    );

    it.each(["unmanaged", "drift"])(
        "protects %s runtime JARs before stopping or journaling",
        async (kind) => {
            const current = await fixture();
            await put(
                current.dir,
                kind === "unmanaged"
                    ? "runtime/plugins/unknown.jar"
                    : "runtime/plugins/Example.jar",
                "owned-jar",
            );
            const before = await tree(current.dir);
            const stop = vi.spyOn(NodeServerController.prototype, "stop");
            await expect(
                applyBackupRestore(
                    current.context,
                    current.source,
                    {},
                    current.store,
                    current.backup,
                ),
            ).rejects.toMatchObject({
                code:
                    kind === "unmanaged"
                        ? "UNMANAGED_JAR"
                        : "RUNTIME_JAR_DRIFT",
            });
            expect(stop).not.toHaveBeenCalled();
            expect(await tree(current.dir)).toEqual(before);
        },
    );

    it("requires exact old custom JAR bytes before stopping and never substitutes the current file", async () => {
        const current = await fixture();
        const cacheFile = path.join(
            current.home,
            "cache/artifacts/sha256",
            current.active.lock.server.sha256,
            "artifact.jar",
        );
        await rm(cacheFile);
        await put(
            current.dir,
            "imports/server.jar",
            artifactZip([
                {
                    name: "META-INF/MANIFEST.MF",
                    content:
                        "Manifest-Version: 1.0\nImplementation-Version: changed\n",
                },
            ]),
        );
        vi.spyOn(NodeServerController.prototype, "status").mockResolvedValue({
            status: "running",
        });
        const stop = vi.spyOn(NodeServerController.prototype, "stop");
        const before = await tree(current.dir);
        await expect(
            applyBackupRestore(
                current.context,
                current.source,
                { offline: true },
                current.store,
                current.backup,
            ),
        ).rejects.toBeInstanceOf(CrafleetError);
        expect(stop).not.toHaveBeenCalled();
        expect(await tree(current.dir)).toEqual(before);
    });

    it.each([false, true])(
        "requires explicit external mappings and handles fileRoot=%s without trusting snapshot source paths",
        async (fileRoot) => {
            const current = await fixture({ external: true, fileRoot });
            const external = current.metadata.roots.find(
                (root) => root.external,
            );
            if (!external) throw new Error("Missing fixture external root");
            await expect(prepare(current)).rejects.toMatchObject({
                code: "RESTORE_MAPPING",
            });
            const mapping = fileRoot
                ? path.join(current.dir, "shared-data/scores.dat")
                : path.join(current.dir, "shared-data");
            const prepared = await prepare(current, {
                mappings: { [external.id]: mapping },
            });
            await execute(current, prepared);
            expect(
                await readFile(
                    path.join(current.dir, "shared-data/scores.dat"),
                    "utf8",
                ),
            ).toBe("snapshot-scores");
        },
    );

    it.each([
        "relative",
        "unknown",
        "runtime",
        "config",
        "home",
        "repository",
        "source",
        "secret",
        "overlap",
    ])("rejects unsafe external mapping: %s", async (kind) => {
        const current = await fixture({ external: true });
        const external = current.metadata.roots.find((root) => root.external);
        if (!external) throw new Error("Missing fixture external root");
        let mapping = path.join(current.dir, "shared-data");
        if (kind === "relative") mapping = "relative-data";
        if (kind === "runtime") mapping = path.join(current.dir, "runtime");
        if (kind === "config") mapping = path.join(current.dir, "config");
        if (kind === "home") mapping = current.home;
        if (kind === "repository") mapping = current.repository;
        if (kind === "source") mapping = current.source;
        if (kind === "secret") {
            mapping = await put(current.root, "secrets.txt", "private-data");
            current.context.manifest.secrets = { SECRET: { file: mapping } };
        }
        if (kind === "overlap")
            await changeMetadata(current, (metadata) => {
                metadata.roots.push({
                    id: "second-root",
                    path: path.join(current.root, "another"),
                    external: true,
                    kind: "directory",
                });
            });
        const mappings =
            kind === "unknown"
                ? { unknown: mapping }
                : {
                      [external.id]: mapping,
                      ...(kind === "overlap" ? { "second-root": mapping } : {}),
                  };
        await expect(
            inspectBackupRestore(
                current.context,
                current.source,
                { mappings },
                current.backup,
            ),
        ).rejects.toBeInstanceOf(CrafleetError);
    });

    it("never deletes currently backed-up external roots absent from the snapshot", async () => {
        const current = await fixture();
        await put(current.dir, "shared-data/new-scope.dat", "must-survive");
        current.config.files.splice(1, 0, "shared-data/**");
        const prepared = await prepare(current);
        expect(
            prepared.changes.some((change) =>
                change.target.includes("shared-data"),
            ),
        ).toBe(false);
        await execute(current, prepared);
        expect(
            await readFile(
                path.join(current.dir, "shared-data/new-scope.dat"),
                "utf8",
            ),
        ).toBe("must-survive");
    });

    it("does not replace existing data outside the actual pre-backup plan even when a broad glob matches it", async () => {
        const current = await fixture({ external: true });
        const external = current.metadata.roots.find((root) => root.external);
        if (!external) throw new Error("Missing fixture external root");
        current.config.files.splice(
            0,
            current.config.files.length,
            "**",
            "!**/*.jar",
        );
        const arbitrary = path.join(current.root, "unselected-data");
        await put(arbitrary, "scores.dat", "must-survive");
        await expect(
            prepare(current, { mappings: { [external.id]: arbitrary } }),
        ).rejects.toMatchObject({ code: "RESTORE_UNPROTECTED_TARGET" });
        expect(await readFile(path.join(arbitrary, "scores.dat"), "utf8")).toBe(
            "must-survive",
        );
    });

    it("binds a same-ID backup to a new project path without mutating its snapshot fingerprint", async () => {
        const current = await fixture();
        const moved = path.join(current.root, "moved-project");
        await cp(current.dir, moved, { recursive: true });
        const context = await loadProject(moved, current.home);
        const expectedProjectId = sha(
            process.platform === "win32"
                ? path.resolve(moved).toLowerCase()
                : path.resolve(moved),
        );
        const before = await tree(current.source);
        const restored = await inspectBackupRestore(
            context,
            current.source,
            {},
            current.backup,
        );
        expect(restored.installation.config.projectId).toBe(expectedProjectId);
        expect(restored.fingerprint).toBe(
            sha(stableStringify(current.metadata)),
        );
        expect(
            (restored.metadata.active.installation as Installation).config
                .projectId,
        ).toBe(current.active.config.projectId);
        expect(await tree(current.source)).toEqual(before);
        await expect(
            new NodeConfigManager(moved).prepareRestoredBundle(
                current.active.config,
            ),
        ).rejects.toBeInstanceOf(CrafleetError);
        expect(
            (
                await new NodeConfigManager(moved).prepareRestoredBundle(
                    current.active.config,
                    true,
                )
            ).projectId,
        ).toBe(expectedProjectId);
    });
});

describe("restore journal and interruption safety", () => {
    it("preflights every target before journal creation and refuses changed source, policy or state", async () => {
        for (const kind of ["target", "source", "policy", "state"] as const) {
            const current = await fixture();
            const prepared = await prepare(current);
            if (kind === "target")
                await put(
                    current.dir,
                    "runtime/world/new.dat",
                    "concurrent-edit",
                );
            if (kind === "source")
                await put(
                    current.source,
                    "data/runtime/world/level.dat",
                    "changed-snapshot",
                );
            if (kind === "policy")
                current.config.files.push("!runtime/world/new.dat");
            if (kind === "state")
                await saveState(current.dir, { schemaVersion: 1 });
            const before = await tree(current.dir);
            await expect(execute(current, prepared)).rejects.toBeInstanceOf(
                CrafleetError,
            );
            expect(await tree(current.dir)).toEqual(before);
            expect(
                await io.exists(
                    path.join(current.dir, ".crafleet/restore.json"),
                ),
            ).toBe(false);
        }
    });

    it("recovers only the fixed original deletion set and retains files created after interruption", async () => {
        const current = await fixture();
        const prepared = await prepare(current);
        let stopped = false;
        await expect(
            execute(current, prepared, async (stage) => {
                if (!stopped && stage.startsWith("file:")) {
                    stopped = true;
                    throw new Error("fixture interruption");
                }
            }),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        await put(
            current.dir,
            "runtime/world/after-interruption.dat",
            "must-survive",
        );
        const before = await tree(current.dir);
        const ensure = vi.spyOn(current.store, "ensure");
        await expect(
            recoverBackupRestore(
                current.context,
                current.store,
                current.backup,
                true,
            ),
        ).resolves.toBe(true);
        expect(ensure).not.toHaveBeenCalled();
        expect(await tree(current.dir)).toEqual(before);
        await expect(
            recoverBackupRestore(
                current.context,
                current.store,
                current.backup,
            ),
        ).resolves.toBe(true);
        expect(
            await readFile(
                path.join(current.dir, "runtime/world/after-interruption.dat"),
                "utf8",
            ),
        ).toBe("must-survive");
        expect(
            await io.exists(path.join(current.dir, "runtime/world/new.dat")),
        ).toBe(false);
        expect(
            await readFile(
                path.join(current.dir, "runtime/world/level.dat"),
                "utf8",
            ),
        ).toBe("snapshot-world");
        await expect(
            recoverBackupRestore(
                current.context,
                current.store,
                current.backup,
            ),
        ).resolves.toBe(false);
    });

    it("refuses recovery when a remaining target was externally edited", async () => {
        const current = await fixture();
        const prepared = await prepare(current);
        await expect(
            execute(current, prepared, async () => {
                throw new Error("interrupted");
            }),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        await put(current.dir, "runtime/world/level.dat", "external-edit");
        const before = await tree(current.dir);
        await expect(
            recoverBackupRestore(
                current.context,
                current.store,
                current.backup,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
        expect(await tree(current.dir)).toEqual(before);
    });

    it("finishes applied bookkeeping without repeating file operations", async () => {
        const current = await fixture();
        const prepared = await prepare(current);
        await expect(
            execute(current, prepared, async (stage) => {
                if (stage === "applied")
                    throw new Error("bookkeeping interruption");
            }),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        expect(
            (
                await io.readJson<{ phase: string }>(
                    path.join(current.dir, ".crafleet/restore.json"),
                )
            ).phase,
        ).toBe("applied");
        const state = await readState(current.dir);
        await recoverBackupRestore(
            current.context,
            current.store,
            current.backup,
        );
        expect(await readState(current.dir)).toEqual(state);
        expect(
            await io.exists(path.join(current.dir, ".crafleet/restore.json")),
        ).toBe(false);
    });

    it.each([
        "invalid-json",
        "invalid-schema",
        "duplicate",
        "escape",
        "unknown-delete",
        "missing-write",
        "unknown-jar",
        "completed-database",
        "unknown-jar-delete",
        "array-mappings",
    ])(
        "refuses tampered %s journals without partially applying",
        async (kind) => {
            const current = await fixture();
            const prepared = await prepare(current);
            await expect(
                execute(current, prepared, async () => {
                    throw new Error("interrupted");
                }),
            ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
            const file = path.join(current.dir, ".crafleet/restore.json");
            const journal = await io.readJson<Record<string, unknown>>(file);
            const changes =
                journal.changes as PreparedRestoreApplication["changes"];
            if (kind === "duplicate" && changes[0])
                changes.push({ ...changes[0] });
            if (kind === "escape" && changes[0])
                changes[0].target = "../outside";
            if (kind === "unknown-delete")
                changes.push({
                    target: path.join(current.root, "outside"),
                    before: sha("outside"),
                    after: null,
                    kind: "data",
                });
            if (kind === "missing-write") changes.splice(0, 1);
            if (kind === "unknown-jar")
                await put(current.dir, "runtime/plugins/unknown.jar", "owned");
            if (kind === "completed-database")
                journal.completedDatabases = ["not-a-database"];
            if (kind === "array-mappings") journal.mappings = [];
            if (kind === "unknown-jar-delete") {
                const target = await put(
                    current.dir,
                    "runtime/plugins/owned.jar",
                    "owned",
                );
                changes.push({
                    target,
                    before: sha("owned"),
                    after: null,
                    kind: "jar",
                });
            }
            if (kind === "invalid-schema") journal.schemaVersion = 2;
            if (kind === "invalid-json")
                await writeFile(file, "private-broken{");
            else await io.writeJson(file, journal);
            const before = await tree(current.dir);
            await expect(
                recoverBackupRestore(
                    current.context,
                    current.store,
                    current.backup,
                ),
            ).rejects.toBeInstanceOf(CrafleetError);
            expect(await tree(current.dir)).toEqual(before);
        },
    );

    it("refuses execution without the coordinator's backup and lock contract", async () => {
        const current = await fixture();
        await expect(
            executePreparedRestore(
                current.context,
                await prepare(current),
                current.store,
                current.backup,
                { operationLockHeld: true, preRestoreSnapshot: "" },
            ),
        ).rejects.toMatchObject({ code: "RESTORE_CONTEXT" });
        expect(
            await io.exists(path.join(current.dir, ".crafleet/restore.json")),
        ).toBe(false);
    });

    it("does not overwrite a target that changes while its replacement is being copied", async () => {
        const current = await fixture();
        const prepared = await prepare(current);
        const original = backupFiles.hashBackupFile;
        let changed = false;
        vi.spyOn(backupFiles, "hashBackupFile").mockImplementation(
            async (file) => {
                const result = await original(file);
                if (
                    !changed &&
                    path.basename(file).startsWith(".crafleet-restore-") &&
                    path.dirname(file) ===
                        path.join(current.dir, "runtime/world")
                ) {
                    changed = true;
                    await put(
                        current.dir,
                        "runtime/world/level.dat",
                        "concurrent-copy-edit",
                    );
                }
                return result;
            },
        );
        await expect(execute(current, prepared)).rejects.toMatchObject({
            code: "RESTORE_INTERRUPTED",
        });
        expect(changed).toBe(true);
        expect(
            await readFile(
                path.join(current.dir, "runtime/world/level.dat"),
                "utf8",
            ),
        ).toBe("concurrent-copy-edit");
        expect(
            (await io.listFiles(path.join(current.dir, "runtime"))).some(
                (file) => file.endsWith(".tmp"),
            ),
        ).toBe(false);
    });
});

describe("database restore confirmation and replay boundaries", () => {
    it("requires explicit matching database selection and verifies every SQL payload", async () => {
        const current = await fixture();
        const config: DatabaseBackupConfig = {
            id: "players",
            kind: "mysql",
            host: "localhost",
            database: "fixture",
            user: "fixture",
            password: { env: "CRAFLEET_FIXTURE_DATABASE_PASSWORD" },
        };
        await addDatabase(current, config, "SELECT 1;\n");
        await expect(
            inspectBackupRestore(
                current.context,
                current.source,
                {},
                current.backup,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_DATABASE" });
        await expect(
            inspectBackupRestore(
                current.context,
                current.source,
                { databases: ["players", "unknown"] },
                current.backup,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_DATABASE" });
        await put(current.source, "databases/players.sql", "modified-sql");
        await expect(
            inspectBackupRestore(
                current.context,
                current.source,
                { databases: ["players"] },
                current.backup,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_HASH" });
    });

    it("does not automatically replay an SQL import that may have partially completed", async () => {
        const current = await fixture();
        const config: DatabaseBackupConfig = {
            id: "players",
            kind: "mysql",
            host: "localhost",
            database: "fixture",
            user: "fixture",
            password: { env: "CRAFLEET_FIXTURE_DATABASE_PASSWORD" },
        };
        await addDatabase(current, config, "SELECT 1;\n");
        vi.spyOn(
            NodeDatabaseBackupAdapter.prototype,
            "preflightRestore",
        ).mockResolvedValue();
        const restore = vi
            .spyOn(NodeDatabaseBackupAdapter.prototype, "restore")
            .mockRejectedValue(new Error("fixture partially imported SQL"));
        await expect(
            execute(
                current,
                await prepare(current, { databases: ["players"] }),
            ),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        expect(restore).toHaveBeenCalledTimes(1);
        const before = await tree(current.dir);
        await expect(
            recoverBackupRestore(
                current.context,
                current.store,
                current.backup,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_DATABASE_RECOVERY" });
        expect(restore).toHaveBeenCalledTimes(1);
        expect(await tree(current.dir)).toEqual(before);
        expect(
            await io.readJson(path.join(current.dir, ".crafleet/restore.json")),
        ).toMatchObject({
            phase: "database",
            databaseInProgress: "players",
            backupId: "fixture-pre-restore-snapshot",
        });
    });

    it("records completed SQL imports before allowing recovery to skip their replay", async () => {
        const current = await fixture();
        const config: DatabaseBackupConfig = {
            id: "players",
            kind: "mysql",
            host: "localhost",
            database: "fixture",
            user: "fixture",
            password: { env: "CRAFLEET_FIXTURE_DATABASE_PASSWORD" },
        };
        await addDatabase(current, config, "SELECT 1;\n");
        vi.spyOn(
            NodeDatabaseBackupAdapter.prototype,
            "preflightRestore",
        ).mockResolvedValue();
        const restore = vi
            .spyOn(NodeDatabaseBackupAdapter.prototype, "restore")
            .mockResolvedValue();
        await expect(
            execute(
                current,
                await prepare(current, { databases: ["players"] }),
                async (stage) => {
                    if (stage === "database:players:complete")
                        throw new Error("after SQL completed");
                },
            ),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        await recoverBackupRestore(
            current.context,
            current.store,
            current.backup,
        );
        expect(restore).toHaveBeenCalledTimes(1);
        expect(
            await io.exists(path.join(current.dir, ".crafleet/restore.json")),
        ).toBe(false);
    });

    it("restores a verified closed SQLite database exactly and can resume its file copy", async () => {
        const current = await fixture();
        const source = path.join(current.root, "snapshot.sqlite3");
        const database = new DatabaseSync(source);
        database.exec(
            "CREATE TABLE players(name TEXT); INSERT INTO players VALUES ('snapshot-player');",
        );
        database.close();
        const bytes = await readFile(source);
        await put(current.dir, "shared-data/players.sqlite3", bytes);
        const config: DatabaseBackupConfig = {
            id: "players",
            kind: "sqlite",
            path: "shared-data/players.sqlite3",
        };
        await addDatabase(current, config, bytes);
        const live = new DatabaseSync(path.join(current.dir, config.path));
        live.exec("INSERT INTO players VALUES ('new-player');");
        live.close();
        const prepared = await prepare(current, { databases: ["players"] });
        await expect(
            execute(current, prepared, async (stage) => {
                if (stage === `file:${path.join(current.dir, config.path)}`)
                    throw new Error("SQLite copied");
            }),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        await recoverBackupRestore(
            current.context,
            current.store,
            current.backup,
        );
        expect(await readFile(path.join(current.dir, config.path))).toEqual(
            bytes,
        );
        const restored = new DatabaseSync(path.join(current.dir, config.path), {
            readOnly: true,
        });
        expect(restored.prepare("SELECT name FROM players").all()).toEqual([
            { name: "snapshot-player" },
        ]);
        restored.close();
    });

    it.each(["sidecar", "invalid-dump", "target-collision"])(
        "rejects unsafe SQLite state: %s",
        async (kind) => {
            const current = await fixture();
            const dump = path.join(current.root, "snapshot.sqlite3");
            const database = new DatabaseSync(dump);
            database.exec("CREATE TABLE players(name TEXT)");
            database.close();
            const config: DatabaseBackupConfig = {
                id: "players",
                kind: "sqlite",
                path:
                    kind === "target-collision"
                        ? "runtime/server.properties"
                        : "shared-data/players.sqlite3",
            };
            await addDatabase(
                current,
                config,
                kind === "invalid-dump" ? "not sqlite" : await readFile(dump),
            );
            if (kind === "sidecar")
                await put(current.dir, `${config.path}-wal`, "writer-present");
            const before = await tree(current.dir);
            await expect(
                prepare(current, { databases: ["players"] }),
            ).rejects.toBeInstanceOf(CrafleetError);
            expect(await tree(current.dir)).toEqual(before);
        },
    );
});
