import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeBackupService } from "../../packages/adapters/src/restic/backup-service.js";
import { runBackupProcess } from "../../packages/adapters/src/restic/process.js";
import type { BackupConfig } from "../../packages/core/src/domain/backup.js";
import {
    addForeignBackupTestAcl,
    backupTestDirectory,
    cleanupBackupTestDirectories,
    FOREIGN_BACKUP_TEST_SID,
    readWindowsBackupTestAcl,
    writeBackupTestFile,
} from "./backup-fixtures.js";

afterEach(cleanupBackupTestDirectories);

describe.runIf(process.env.CRAFLEET_TEST_RESTIC === "1")(
    "official restic binary integration",
    () => {
        it("downloads and verifies restic, initializes explicitly, creates real snapshots and restores old data", async () => {
            const root = await backupTestDirectory();
            const project = path.join(root, "project");
            const home = path.join(root, "home");
            const repository = path.join(root, "repository");
            await mkdir(repository);
            await writeBackupTestFile(
                project,
                "runtime/world/level.dat",
                "original stopped world",
            );
            await writeBackupTestFile(
                project,
                "runtime/plugins/self.jar",
                "not backed up",
            );
            await writeBackupTestFile(
                project,
                "runtime/.secret",
                "fixture private data",
            );
            const config: BackupConfig = {
                projectId: "official-restic-test",
                repository: "local",
                repositories: {
                    local: { path: repository, password: { env: "TEST_ONLY" } },
                },
                files: ["runtime/**", "!**/*.jar"],
                retention: { keepLast: 1 },
            };
            const service = new NodeBackupService(
                project,
                home,
                config,
                async () => "crafleet-disposable-test-password",
                {
                    runner: async (request) => {
                        if (
                            process.platform === "win32" &&
                            request.args.includes("backup") &&
                            request.cwd
                        ) {
                            const file = path.join(
                                request.cwd,
                                "data/runtime/world/level.dat",
                            );
                            await addForeignBackupTestAcl(file);
                            expect(
                                (await readWindowsBackupTestAcl(file))
                                    .allowSids,
                            ).toContain(FOREIGN_BACKUP_TEST_SID);
                        }
                        return runBackupProcess(request);
                    },
                },
            );
            expect((await service.prepare()).version).toBe("0.19.1");
            expect((await service.prepare({ offline: true })).version).toBe(
                "0.19.1",
            );
            await expect(service.setup("local")).rejects.toMatchObject({
                code: "BACKUP_REPOSITORY_UNINITIALIZED",
            });
            const setup = await service.setup("local", {
                initialize: true,
                confirm: true,
            });
            const local = config.repositories?.local;
            if (!local) throw new Error("fixture repository missing");
            local.id = setup.id;
            await service.preflight();
            const first = await service.create({
                generation: "g1",
                lockSlice: { server: "fixed-v1" },
            });
            await writeBackupTestFile(
                project,
                "runtime/world/level.dat",
                "updated stopped world",
            );
            const second = await service.create({
                generation: "g2",
                lockSlice: { server: "fixed-v2" },
            });
            expect(
                (await service.list()).map((snapshot) => snapshot.id),
            ).toContain(first.snapshotId);
            expect(await service.list()).toHaveLength(2);
            expect(
                (await service.show(first.snapshotId)).active.generation,
            ).toBe("g1");
            expect(
                await service.diff(first.snapshotId, second.snapshotId),
            ).not.toEqual([]);
            expect(await service.check({ readData: true })).toEqual({
                checked: true,
            });
            const target = path.join(root, "restored");
            const restorePlan = await service.planRestore(first.snapshotId, {
                target,
            });
            expect(restorePlan.requiredBytes).toBeGreaterThan(
                restorePlan.dataBytes * 2,
            );
            await service.restore(first.snapshotId, { target });
            expect(
                await readFile(
                    path.join(target, "data/runtime/world/level.dat"),
                    "utf8",
                ),
            ).toBe("original stopped world");
            expect(
                await readFile(
                    path.join(project, "runtime/world/level.dat"),
                    "utf8",
                ),
            ).toBe("updated stopped world");
            expect(
                await readdir(path.join(target, "data/runtime")),
            ).not.toContain("plugins");
            if (process.platform === "win32") {
                const acl = await readWindowsBackupTestAcl(
                    path.join(target, "data/runtime/world/level.dat"),
                );
                expect(acl.allowSids).toEqual([acl.currentSid]);
                expect(acl.denySids).toEqual([]);
                const rootAcl = await readWindowsBackupTestAcl(target);
                expect(rootAcl.ownerSid).toBe(rootAcl.currentSid);
                expect(rootAcl.protected).toBe(true);
            }
            expect((await service.prune()).applied).toBe(false);
            expect(await service.list()).toHaveLength(2);
            await service.prune({ apply: true, confirm: true });
            expect(await service.list()).toHaveLength(1);
        }, 120000);
    },
);
