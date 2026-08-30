import { createHash, randomUUID } from "node:crypto";
import {
    mkdir,
    open,
    readdir,
    readFile,
    rm,
    rmdir,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { BackupMetadata, ServerStatus } from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeDatabaseBackupAdapter } from "../../packages/adapters/src/database/backup.js";
import { NodeDeploymentManager } from "../../packages/adapters/src/filesystem/deployment.js";
import {
    applyGroupBackupRestore,
    recoverGroupBackupRestore,
} from "../../packages/adapters/src/filesystem/group-restore.js";
import {
    createGroupRestoreWorkspace,
    inspectGroupBackupRestore,
    removeGroupRestoreWorkspace,
} from "../../packages/adapters/src/filesystem/group-restore-layout.js";
import {
    collectGroupBackupMetadata,
    type GroupBackupActive,
    runtimeRootId,
} from "../../packages/adapters/src/filesystem/groups.js";
import {
    exists,
    readJson,
    writeJson,
} from "../../packages/adapters/src/filesystem/io.js";
import {
    readState,
    saveState,
} from "../../packages/adapters/src/filesystem/state.js";
import { NodeServerController } from "../../packages/adapters/src/runtime/controller.js";
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

async function extractedFixture() {
    const fixture = await backupGroupFixture();
    const source = path.join(fixture.root, "extracted");
    async function extract() {
        const backup = fixture.batch.backup;
        await backup.prepare();
        const saved = await backup.create(
            await collectGroupBackupMetadata("network", fixture.projects),
        );
        await backup.restore(saved.snapshotId, { target: source });
        const shared = required(
            saved.metadata.roots.find(
                (root) => root.path === path.join(fixture.workspace, "shared"),
            ),
        );
        return {
            saved,
            options: {
                mappings: {
                    [shared.id]: path.join(fixture.workspace, "shared"),
                },
            },
        };
    }
    return { ...fixture, source, extract };
}

function runtimeStates(
    projects: Awaited<ReturnType<typeof backupGroupFixture>>["projects"],
    initial: "running" | "stopped" = "stopped",
) {
    const states = new Map(projects.map((project) => [project.dir, initial]));
    vi.spyOn(NodeServerController.prototype, "status").mockImplementation(
        async function (this: NodeServerController): Promise<ServerStatus> {
            return {
                status: states.get(this.projectDir) ?? "stopped",
                clean: true,
            };
        },
    );
    const stop = vi
        .spyOn(NodeServerController.prototype, "stop")
        .mockImplementation(async function (
            this: NodeServerController,
        ): Promise<ServerStatus> {
            states.set(this.projectDir, "stopped");
            return { status: "stopped", clean: true };
        });
    const start = vi
        .spyOn(NodeServerController.prototype, "start")
        .mockRejectedValue(new Error("A restore must never start a JVM"));
    return { states, stop, start };
}

async function modifyData(
    fixture: Awaited<ReturnType<typeof extractedFixture>>,
) {
    for (const project of fixture.projects) {
        await writeBackupTestFile(
            project.dir,
            "runtime/world/players.dat",
            `${project.manifest.name} modified`,
        );
        await writeBackupTestFile(
            project.dir,
            "runtime/world/added.dat",
            "new data to remove only after a pre-restore snapshot",
        );
    }
    await writeBackupTestFile(
        fixture.workspace,
        "shared/players.dat",
        "shared modified",
    );
}

async function assertOriginalData(
    fixture: Awaited<ReturnType<typeof extractedFixture>>,
) {
    for (const project of fixture.projects) {
        expect(
            await readFile(
                path.join(project.dir, "runtime/world/players.dat"),
                "utf8",
            ),
        ).toBe(`${project.manifest.name} original`);
        expect(
            await exists(path.join(project.dir, "runtime/world/added.dat")),
        ).toBe(false);
    }
    expect(
        await readFile(
            path.join(fixture.workspace, "shared/players.dat"),
            "utf8",
        ),
    ).toBe("shared player original");
}

describe("group production restore with actual temporary files", () => {
    it("takes one pre-restore snapshot, restores both runtimes and shared data, discards pending, and never starts members", async () => {
        const fixture = await extractedFixture();
        const { options, saved } = await fixture.extract();
        await fixture.stageNext();
        for (const project of fixture.projects)
            await new NodeDeploymentManager(
                project,
                fixture.store,
            ).applyPrepared();
        const activeBefore = await Promise.all(
            fixture.projects.map((project) => readState(project.dir)),
        );
        await fixture.stageNext();
        await modifyData(fixture);
        const states = runtimeStates(fixture.projects, "running");
        const lock = await readFile(
            path.join(fixture.workspace, "crafleet-lock.yaml"),
        );
        const result = await applyGroupBackupRestore(
            fixture.batch,
            fixture.source,
            options,
            fixture.store,
        );
        expect(result).toMatchObject({
            applied: true,
            pendingDiscarded: true,
            startAfterApply: false,
            sharedLockUnchanged: true,
        });
        expect(fixture.engine.snapshots.size).toBe(2);
        expect(states.stop).toHaveBeenCalledTimes(2);
        expect(states.start).not.toHaveBeenCalled();
        expect([...states.states.values()]).toEqual(["stopped", "stopped"]);
        await assertOriginalData(fixture);
        for (const [index, project] of fixture.projects.entries()) {
            const current = await readState(project.dir);
            expect(current.pending).toBeUndefined();
            expect(current.active?.lock.server.source).toMatchObject({
                build: "1",
            });
            expect(current.active?.id).not.toBe(
                activeBefore[index]?.active?.id,
            );
            expect(current.active?.lock.server.sha256).not.toBe(
                activeBefore[index]?.active?.lock.server.sha256,
            );
        }
        expect(
            await readFile(path.join(fixture.workspace, "crafleet-lock.yaml")),
        ).toEqual(lock);
        expect(
            await exists(
                path.join(fixture.workspace, ".crafleet/group-restore.json"),
            ),
        ).toBe(false);
        expect(
            (await readdir(fixture.root)).some((file) =>
                file.startsWith(".crafleet-group-restore-"),
            ),
        ).toBe(false);
        expect(await fixture.batch.backup.show(saved.snapshotId)).toEqual(
            saved.metadata,
        );
    });

    it("keeps dry-run free of server, cache, repository and production writes", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        const states = runtimeStates(fixture.projects, "running");
        const ensure = vi.spyOn(fixture.store, "ensure");
        const before = await Promise.all(
            fixture.projects.map((project) => readState(project.dir)),
        );
        const result = await applyGroupBackupRestore(
            fixture.batch,
            fixture.source,
            { ...options, dryRun: true },
            fixture.store,
        );
        expect(result).toMatchObject({
            startAfterApply: false,
            projectionCopyBytesUpperBound: expect.any(Number),
            changes: expect.any(Array),
        });
        expect(states.stop).not.toHaveBeenCalled();
        expect(states.start).not.toHaveBeenCalled();
        expect(ensure).not.toHaveBeenCalled();
        expect(fixture.engine.snapshots.size).toBe(1);
        expect(
            await Promise.all(
                fixture.projects.map((project) => readState(project.dir)),
            ),
        ).toEqual(before);
        expect(
            await readFile(
                path.join(fixture.projects[0].dir, "runtime/world/players.dat"),
                "utf8",
            ),
        ).toBe("alpha modified");
        expect(
            (await readdir(fixture.root)).some((file) =>
                file.startsWith(".crafleet-group-restore-"),
            ),
        ).toBe(false);
    });

    it("preserves distinct ordered member policies when a shared file is selected only by the second member", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        fixture.projects[0].manifest.backup.files.push("!../../shared/**");
        fixture.batch.backup = await fixture.makeBackup();
        await modifyData(fixture);
        runtimeStates(fixture.projects);
        await applyGroupBackupRestore(
            fixture.batch,
            fixture.source,
            options,
            fixture.store,
        );
        await assertOriginalData(fixture);
        expect(fixture.engine.snapshots.size).toBe(2);
    });

    it("detects missing backup credentials or exact JARs before stopping a running group", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        const states = runtimeStates(fixture.projects, "running");
        vi.spyOn(fixture.store, "ensure").mockRejectedValueOnce(
            new Error("cache missing"),
        );
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                { ...options, offline: true },
                fixture.store,
            ),
        ).rejects.toThrow("cache missing");
        expect(states.stop).not.toHaveBeenCalled();
        vi.mocked(fixture.store.ensure).mockResolvedValueOnce(
            path.join(fixture.projects[0].dir, "runtime/world/players.dat"),
        );
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                options,
                fixture.store,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_HASH" });
        expect(states.stop).not.toHaveBeenCalled();
        const preflight = vi
            .spyOn(fixture.batch.backup, "preflight")
            .mockRejectedValue(new Error("secret unavailable"));
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                options,
                fixture.store,
            ),
        ).rejects.toThrow("secret unavailable");
        expect(states.stop).not.toHaveBeenCalled();
        expect(fixture.engine.snapshots.size).toBe(1);
        preflight.mockRestore();
    });

    it("leaves data unchanged and the whole group stopped when its pre-restore snapshot fails", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        const states = runtimeStates(fixture.projects, "running");
        vi.spyOn(fixture.batch.backup, "create").mockRejectedValue(
            new Error("repository full"),
        );
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                options,
                fixture.store,
            ),
        ).rejects.toThrow("repository full");
        expect([...states.states.values()]).toEqual(["stopped", "stopped"]);
        expect(states.start).not.toHaveBeenCalled();
        expect(
            await readFile(
                path.join(fixture.projects[0].dir, "runtime/world/players.dat"),
                "utf8",
            ),
        ).toBe("alpha modified");
        expect(
            await exists(
                path.join(fixture.workspace, ".crafleet/group-restore.json"),
            ),
        ).toBe(false);
    });

    it("requires explicit safe shared mappings and checks every group member's protected paths", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        const id = required(Object.keys(options.mappings)[0]);
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, {}),
        ).rejects.toMatchObject({ code: "RESTORE_MAPPING" });
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, {
                mappings: { [id]: "relative" },
            }),
        ).rejects.toMatchObject({ code: "RESTORE_MAPPING" });
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, {
                mappings: {
                    [id]: path.join(fixture.projects[1].dir, ".crafleet"),
                },
            }),
        ).rejects.toMatchObject({ code: "RESTORE_MAPPING" });
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, {
                mappings: {
                    [id]: path.join(fixture.projects[1].dir, "runtime"),
                },
            }),
        ).rejects.toMatchObject({ code: "RESTORE_COLLISION" });
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, {
                mappings: {
                    ...options.mappings,
                    [runtimeRootId(fixture.projects[0])]: fixture.source,
                },
            }),
        ).rejects.toMatchObject({ code: "RESTORE_MAPPING" });
        await expect(
            inspectGroupBackupRestore(
                fixture.batch,
                fixture.projects[0].dir,
                options,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_OVERLAP" });
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, {
                ...options,
                databases: ["unknown"],
            }),
        ).rejects.toMatchObject({ code: "RESTORE_DATABASE" });
    });

    it("refuses extra payloads and an incomplete extraction before creating any application journal", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await mkdir(path.join(fixture.source, "unexpected-empty-directory"));
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, options),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_VERIFY" });
        await rmdir(path.join(fixture.source, "unexpected-empty-directory"));
        await writeBackupTestFile(
            fixture.source,
            ".crafleet-restore-incomplete.json",
            "{}",
        );
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, options),
        ).rejects.toMatchObject({ code: "RESTORE_INCOMPLETE" });
        await rm(
            path.join(fixture.source, ".crafleet-restore-incomplete.json"),
        );
        const file = path.join(
            fixture.source,
            `data/external/${runtimeRootId(fixture.projects[0])}/world/players.dat`,
        );
        await writeFile(file, "tampered payload");
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, options),
        ).rejects.toMatchObject({ code: "RESTORE_HASH" });
    });

    it("validates group membership and active installations without trusting snapshot paths or unknown fields", async () => {
        const fixture = await extractedFixture();
        const { options, saved } = await fixture.extract();
        const writeMetadata = async (metadata: BackupMetadata) => {
            await writeJson(
                path.join(fixture.source, "metadata/backup.json"),
                metadata,
            );
            await writeJson(
                path.join(fixture.source, "metadata/active.json"),
                metadata.active,
            );
        };
        const check = async (
            modify: (
                metadata: BackupMetadata,
                active: GroupBackupActive,
            ) => void,
            code: string,
        ) => {
            const metadata = structuredClone(saved.metadata);
            modify(metadata, metadata.active as GroupBackupActive);
            await writeMetadata(metadata);
            await expect(
                inspectGroupBackupRestore(
                    fixture.batch,
                    fixture.source,
                    options,
                ),
            ).rejects.toMatchObject({ code });
        };
        await check((metadata) => {
            metadata.active.unexpected = true;
        }, "RESTORE_GROUP_MEMBERSHIP");
        await check((_metadata, active) => {
            required(active.group.members[1]).projectId = required(
                active.group.members[0],
            ).projectId;
        }, "RESTORE_GROUP_MEMBERSHIP");
        await check((_metadata, active) => {
            required(active.group.members[0]).installation = null;
        }, "RESTORE_NO_INSTALLATION");
        await check((_metadata, active) => {
            required(
                required(active.group.members[0]).installation,
            ).manifest.id = randomUUID();
        }, "RESTORE_PROJECT");
        await check((metadata, active) => {
            const old = required(active.group.members[0]).runtimeRootId;
            const replacement = `server-${randomUUID()}`;
            required(active.group.members[0]).runtimeRootId = replacement;
            required(metadata.roots.find((root) => root.id === old)).id =
                replacement;
            for (const file of metadata.files)
                file.destination = file.destination.replace(
                    `data/external/${old}/`,
                    `data/external/${replacement}/`,
                );
        }, "RESTORE_GROUP_MEMBERSHIP");
        await check((metadata) => {
            metadata.roots.push({
                id: "runtime",
                path: fixture.root,
                external: false,
                kind: "directory",
            });
        }, "RESTORE_GROUP_MEMBERSHIP");
        await writeMetadata(saved.metadata);
        await writeJson(path.join(fixture.source, "metadata/active.json"), {});
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, options),
        ).rejects.toMatchObject({ code: "RESTORE_METADATA" });
        await writeMetadata(saved.metadata);
        await expect(
            inspectGroupBackupRestore(
                { projects: fixture.projects, backup: fixture.batch.backup },
                fixture.source,
                options,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_GROUP" });
        await expect(
            inspectGroupBackupRestore(
                { group: "network", projects: fixture.projects },
                fixture.source,
                options,
            ),
        ).rejects.toMatchObject({ code: "BACKUP_REQUIRED" });
    });

    it("rejects malformed or oversized metadata before reading an unbounded file", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        const file = path.join(fixture.source, "metadata/backup.json");
        await writeFile(file, "{");
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, options),
        ).rejects.toMatchObject({ code: "RESTORE_METADATA" });
        const handle = await open(file, "w");
        try {
            await handle.truncate(64 * 1024 * 1024 + 1);
        } finally {
            await handle.close();
        }
        await expect(
            inspectGroupBackupRestore(fixture.batch, fixture.source, options),
        ).rejects.toMatchObject({ code: "RESTORE_METADATA" });
    });

    it("uses private real copies when hard links are unsupported and cleans failed projection creation", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        const inspection = await inspectGroupBackupRestore(
            fixture.batch,
            fixture.source,
            options,
        );
        const copied = await createGroupRestoreWorkspace(
            fixture.batch,
            inspection,
            options,
            {
                link: async () => {
                    throw Object.assign(new Error("unsupported"), {
                        code: "EXDEV",
                    });
                },
            },
        );
        const projected = path.join(
            required(copied.projections[0]).source,
            "data/runtime/world/players.dat",
        );
        expect(await readFile(projected, "utf8")).toBe("alpha original");
        const original = path.join(
            fixture.source,
            `data/external/${runtimeRootId(fixture.projects[0])}/world/players.dat`,
        );
        await writeFile(original, "different original bytes");
        expect(await readFile(projected, "utf8")).toBe("alpha original");
        await removeGroupRestoreWorkspace(inspection, copied);
        await writeFile(original, "alpha original");
        await expect(
            createGroupRestoreWorkspace(fixture.batch, inspection, options, {
                link: async () => {
                    throw Object.assign(new Error("unrecoverable link error"), {
                        code: "EIO",
                    });
                },
            }),
        ).rejects.toThrow("unrecoverable link error");
        const abort = new AbortController();
        abort.abort();
        await expect(
            createGroupRestoreWorkspace(fixture.batch, inspection, {
                ...options,
                signal: abort.signal,
            }),
        ).rejects.toThrow();
        expect(
            (await readdir(fixture.root)).some((file) =>
                file.startsWith(".crafleet-group-restore-"),
            ),
        ).toBe(false);
    });

    it("handles explicit single-file roots and empty shared roots without expanding the restore scope", async () => {
        const fixture = await extractedFixture();
        await writeBackupTestFile(
            fixture.workspace,
            "standalone.dat",
            "standalone original",
        );
        await mkdir(path.join(fixture.workspace, "empty"));
        for (const project of fixture.projects)
            project.manifest.backup.files.push(
                "../../standalone.dat",
                "../../empty/**",
            );
        fixture.batch.backup = await fixture.makeBackup();
        const { options, saved } = await fixture.extract();
        const single = required(
            saved.metadata.roots.find((root) => root.kind === "file"),
        );
        options.mappings[single.id] = path.join(
            fixture.workspace,
            "standalone.dat",
        );
        await writeBackupTestFile(
            fixture.workspace,
            "standalone.dat",
            "standalone changed",
        );
        runtimeStates(fixture.projects);
        await applyGroupBackupRestore(
            fixture.batch,
            fixture.source,
            options,
            fixture.store,
        );
        expect(
            await readFile(
                path.join(fixture.workspace, "standalone.dat"),
                "utf8",
            ),
        ).toBe("standalone original");
        expect(await readdir(path.join(fixture.workspace, "empty"))).toEqual(
            [],
        );
    });
});

describe("group restore interruption and recovery", () => {
    it.each(["group:prepared", "servers/alpha:complete", "group:applied"])(
        "recovers a durable interruption at %s without taking another backup",
        async (checkpoint) => {
            const fixture = await extractedFixture();
            const { options } = await fixture.extract();
            await modifyData(fixture);
            const states = runtimeStates(fixture.projects);
            await expect(
                applyGroupBackupRestore(
                    fixture.batch,
                    fixture.source,
                    {
                        ...options,
                        checkpoint: async (stage) => {
                            if (stage === checkpoint)
                                throw new Error("simulated interruption");
                        },
                    },
                    fixture.store,
                ),
            ).rejects.toMatchObject({ code: "GROUP_RESTORE_INTERRUPTED" });
            const journal = path.join(
                fixture.workspace,
                ".crafleet/group-restore.json",
            );
            expect(await exists(journal)).toBe(true);
            expect(
                await recoverGroupBackupRestore(fixture.batch, fixture.store, {
                    dryRun: true,
                }),
            ).toBe(true);
            expect(await exists(journal)).toBe(true);
            const stages: string[] = [];
            expect(
                await recoverGroupBackupRestore(fixture.batch, fixture.store, {
                    signal: new AbortController().signal,
                    checkpoint: async (stage) => {
                        stages.push(stage);
                    },
                }),
            ).toBe(true);
            expect(stages).toContain("group:applied");
            await assertOriginalData(fixture);
            expect(fixture.engine.snapshots.size).toBe(2);
            expect(states.start).not.toHaveBeenCalled();
            expect(await exists(journal)).toBe(false);
            expect(
                await recoverGroupBackupRestore(fixture.batch, fixture.store),
            ).toBe(false);
            expect(
                (await readdir(fixture.root)).some((file) =>
                    file.startsWith(".crafleet-group-restore-"),
                ),
            ).toBe(false);
        },
    );

    it("resumes a member's recorded partially applied file plan, then finishes untouched members", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        const states = runtimeStates(fixture.projects);
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                {
                    ...options,
                    checkpoint: async (stage) => {
                        if (
                            stage.startsWith(
                                `${fixture.projects[0].lockKey}:file:`,
                            ) &&
                            stage.endsWith("players.dat")
                        )
                            throw new Error("interrupted file");
                    },
                },
                fixture.store,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        expect(
            await exists(
                path.join(fixture.projects[0].dir, ".crafleet/restore.json"),
            ),
        ).toBe(true);
        expect(
            await recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).toBe(true);
        await assertOriginalData(fixture);
        expect(states.start).not.toHaveBeenCalled();
    });

    it("retains newly created or externally edited targets instead of recomputing a destructive plan during recovery", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        runtimeStates(fixture.projects);
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                {
                    ...options,
                    checkpoint: async (stage) => {
                        if (stage === "group:prepared")
                            throw new Error("pause");
                    },
                },
                fixture.store,
            ),
        ).rejects.toThrow();
        const fresh = await writeBackupTestFile(
            fixture.projects[1].dir,
            "runtime/world/unseen.dat",
            "do not delete",
        );
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
        expect(await readFile(fresh, "utf8")).toBe("do not delete");
        expect(
            await readFile(
                path.join(fixture.projects[0].dir, "runtime/world/players.dat"),
                "utf8",
            ),
        ).toBe("alpha modified");
        expect(
            await exists(
                path.join(fixture.workspace, ".crafleet/group-restore.json"),
            ),
        ).toBe(true);
    });

    it("will not replay a group after its backup policy, original extraction, or workspace ownership marker changes", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        runtimeStates(fixture.projects);
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                {
                    ...options,
                    checkpoint: async (stage) => {
                        if (stage === "group:prepared")
                            throw new Error("pause");
                    },
                },
                fixture.store,
            ),
        ).rejects.toThrow();
        const files = fixture.projects[0].manifest.backup.files;
        files.push("!runtime/world/**");
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_CHANGED" });
        files.pop();
        const journal = await readJson<{ directory: string }>(
            path.join(fixture.workspace, ".crafleet/group-restore.json"),
        );
        await writeJson(path.join(journal.directory, "owner.json"), {
            wrong: true,
        });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "GROUP_RESTORE_JOURNAL" });
    });

    it("rejects tampered member journals and completed installation drift without touching other members", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        runtimeStates(fixture.projects);
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                {
                    ...options,
                    checkpoint: async (stage) => {
                        if (stage.endsWith(":applied"))
                            throw new Error("pause after state save");
                    },
                },
                fixture.store,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        const file = path.join(
            fixture.projects[0].dir,
            ".crafleet/restore.json",
        );
        const original = await readJson<Record<string, unknown>>(file);
        await writeJson(file, { ...original, backupId: "b".repeat(64) });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "GROUP_RESTORE_JOURNAL" });
        await writeJson(file, original);
        await saveState(fixture.projects[0].dir, { schemaVersion: 1 });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
        expect(
            await readFile(
                path.join(fixture.projects[1].dir, "runtime/world/players.dat"),
                "utf8",
            ),
        ).toBe("beta modified");
    });

    it("records an aborted apply and resumes the same approved plan without starting the group", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        const states = runtimeStates(fixture.projects);
        const abort = new AbortController();
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                {
                    ...options,
                    signal: abort.signal,
                    checkpoint: async (stage) => {
                        if (stage === "group:prepared") abort.abort();
                    },
                },
                fixture.store,
            ),
        ).rejects.toThrow();
        expect(
            await exists(
                path.join(fixture.workspace, ".crafleet/group-restore.json"),
            ),
        ).toBe(true);
        expect(
            await recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).toBe(true);
        await assertOriginalData(fixture);
        expect(states.start).not.toHaveBeenCalled();
    });

    it("checks central journal targets, member views and working directory provenance before any recovery writes", async () => {
        const fixture = await extractedFixture();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        runtimeStates(fixture.projects);
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                {
                    ...options,
                    checkpoint: async (stage) => {
                        if (stage === "group:prepared")
                            throw new Error("pause");
                    },
                },
                fixture.store,
            ),
        ).rejects.toThrow();
        const file = path.join(
            fixture.workspace,
            ".crafleet/group-restore.json",
        );
        const original = await readJson<{
            directory: string;
            members: { source: string; changes: { target: string }[] }[];
        }>(file);
        await writeJson(file, { ...original, extra: true });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "GROUP_RESTORE_JOURNAL" });
        const collision = structuredClone(original);
        required(required(collision.members[1]).changes[0]).target = required(
            required(collision.members[0]).changes[0],
        ).target;
        await writeJson(file, collision);
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_COLLISION" });
        required(required(collision.members[1]).changes[0]).target = path.join(
            required(required(collision.members[0]).changes[0]).target,
            "nested",
        );
        await writeJson(file, collision);
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_COLLISION" });
        await writeJson(file, { ...original, directory: fixture.workspace });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "GROUP_RESTORE_JOURNAL" });
        const shifted = structuredClone(original);
        required(shifted.members[0]).source = path.join(
            fixture.root,
            "untrusted-source",
        );
        await writeJson(file, shifted);
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "GROUP_RESTORE_JOURNAL" });
        await writeJson(file, original);
        const extra = await writeBackupTestFile(
            original.directory,
            "unexpected",
            "preserve until reviewed",
        );
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "GROUP_RESTORE_JOURNAL" });
        await rm(extra);
        const projectionMetadata = path.join(
            required(original.members[0]).source,
            "metadata/backup.json",
        );
        const metadata = await readJson<BackupMetadata>(projectionMetadata);
        await writeJson(projectionMetadata, {
            ...metadata,
            createdAt: "2000-01-01T00:00:00.000Z",
        });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_CHANGED" });
        expect(
            await readFile(
                path.join(fixture.projects[0].dir, "runtime/world/players.dat"),
                "utf8",
            ),
        ).toBe("alpha modified");
    });

    it("refuses changed snapshot metadata and post-application data or state instead of silently clearing a journal", async () => {
        const fixture = await extractedFixture();
        const { options, saved } = await fixture.extract();
        await modifyData(fixture);
        runtimeStates(fixture.projects);
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                {
                    ...options,
                    checkpoint: async (stage) => {
                        if (stage === "group:applied") throw new Error("pause");
                    },
                },
                fixture.store,
            ),
        ).rejects.toThrow();
        const metadataFile = path.join(fixture.source, "metadata/backup.json");
        await writeJson(metadataFile, {
            ...saved.metadata,
            createdAt: "2000-01-01T00:00:00.000Z",
        });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_CHANGED" });
        await writeJson(metadataFile, saved.metadata);
        const player = path.join(
            fixture.projects[0].dir,
            "runtime/world/players.dat",
        );
        await writeFile(player, "user edited after application");
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
        await writeFile(player, "alpha original");
        const state = await readState(fixture.projects[0].dir);
        await saveState(fixture.projects[0].dir, {
            ...state,
            active: {
                ...required(state.active),
                createdAt: "2000-01-01T00:00:00.000Z",
            },
        });
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
        expect(
            await exists(
                path.join(fixture.workspace, ".crafleet/group-restore.json"),
            ),
        ).toBe(true);
    });
});

describe("group database consistency boundaries", () => {
    it("restores one shared SQLite dump and preserves its captured bytes while all members stay stopped", async () => {
        const fixture = await extractedFixture();
        const databaseFile = path.join(
            fixture.workspace,
            "shared/players.sqlite3",
        );
        const { DatabaseSync } = await import("node:sqlite");
        const original = new DatabaseSync(databaseFile);
        original.exec(
            "CREATE TABLE players(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO players VALUES(1,'before');",
        );
        original.close();
        for (const project of fixture.projects)
            project.manifest.backup.databases = [
                {
                    id: "players",
                    kind: "sqlite",
                    path: "../../shared/players.sqlite3",
                },
            ];
        fixture.batch.backup = await fixture.makeBackup();
        const { options } = await fixture.extract();
        const modified = new DatabaseSync(databaseFile);
        modified.exec("UPDATE players SET value='after';");
        modified.close();
        runtimeStates(fixture.projects);
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                options,
                fixture.store,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_DATABASE" });
        await applyGroupBackupRestore(
            fixture.batch,
            fixture.source,
            { ...options, databases: ["players"] },
            fixture.store,
        );
        const restored = new DatabaseSync(databaseFile, { readOnly: true });
        try {
            expect(
                restored.prepare("SELECT value FROM players").get()?.value,
            ).toBe("before");
        } finally {
            restored.close();
        }
        expect(await readFile(databaseFile)).toEqual(
            await readFile(
                path.join(fixture.source, "databases/players.sqlite3"),
            ),
        );
        expect(fixture.engine.snapshots.size).toBe(2);
    });

    it("never automatically retries a SQL import after the client may have partially applied it", async () => {
        const fixture = await extractedFixture();
        const database = {
            id: "players",
            kind: "mysql",
            host: "127.0.0.1",
            database: "fixture",
            user: "fixture",
            password: { env: "DISPOSABLE_FIXTURE_PASSWORD" },
        } as const;
        for (const project of fixture.projects)
            project.manifest.backup.databases = [database];
        vi.spyOn(
            NodeDatabaseBackupAdapter.prototype,
            "preflight",
        ).mockResolvedValue(undefined);
        vi.spyOn(
            NodeDatabaseBackupAdapter.prototype,
            "preflightRestore",
        ).mockResolvedValue(undefined);
        vi.spyOn(
            NodeDatabaseBackupAdapter.prototype,
            "dump",
        ).mockImplementation(async (config, directory) => {
            const bytes = Buffer.from("CREATE TABLE fixture(id INT);\n");
            await writeBackupTestFile(directory, `${config.id}.sql`, bytes);
            return {
                id: config.id,
                kind: config.kind,
                file: `databases/${config.id}.sql`,
                bytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
            };
        });
        fixture.batch.backup = await fixture.makeBackup();
        const { options } = await fixture.extract();
        await modifyData(fixture);
        const states = runtimeStates(fixture.projects);
        const restore = vi
            .spyOn(NodeDatabaseBackupAdapter.prototype, "restore")
            .mockRejectedValue(
                new Error("client failed after executing some statements"),
            );
        await expect(
            applyGroupBackupRestore(
                fixture.batch,
                fixture.source,
                { ...options, databases: ["players"] },
                fixture.store,
            ),
        ).rejects.toMatchObject({ code: "RESTORE_INTERRUPTED" });
        expect(restore).toHaveBeenCalledOnce();
        await expect(
            recoverGroupBackupRestore(fixture.batch, fixture.store),
        ).rejects.toMatchObject({ code: "RESTORE_DATABASE_RECOVERY" });
        expect(restore).toHaveBeenCalledOnce();
        expect(states.start).not.toHaveBeenCalled();
        expect(
            await exists(
                path.join(fixture.workspace, ".crafleet/group-restore.json"),
            ),
        ).toBe(true);
    });
});
