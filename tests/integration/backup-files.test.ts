import {
    lstat,
    mkdir,
    readdir,
    readFile,
    symlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    checkBackupSpace,
    hashBackupFile,
    pathsOverlap,
    planBackupFiles,
    privateBackupDirectory,
    removePrivateBackupDirectory,
    stageBackupPlan,
} from "../../packages/adapters/src/filesystem/backup-files.js";
import { ensurePrivateDirectory } from "../../packages/adapters/src/filesystem/private.js";
import { DEFAULT_BACKUP_PATTERNS } from "../../packages/core/src/domain/backup.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    readWindowsBackupTestAcl,
    restrictBackupTestAclToModify,
    writeBackupTestFile,
} from "./backup-fixtures.js";

afterEach(cleanupBackupTestDirectories);

describe("backup file planning on the real filesystem", () => {
    it("uses the same selected files for preview and staging, independently of gitignore", async () => {
        const root = await backupTestDirectory();
        const runtime = path.join(root, "runtime");
        await writeBackupTestFile(runtime, "world/level.dat", "world-data");
        await writeBackupTestFile(runtime, "plugins/player.yml", "player");
        await writeBackupTestFile(runtime, ".secret", "hidden");
        await writeBackupTestFile(runtime, ".gitignore", "world\n.secret\n");
        await writeBackupTestFile(runtime, "plugins/own.JAR", "jar");
        await writeBackupTestFile(runtime, "plugins/cache/discard", "discard");
        await writeBackupTestFile(runtime, "plugins/cache/keep/a", "keep");
        const plan = await planBackupFiles(runtime, [
            ...DEFAULT_BACKUP_PATTERNS,
            "!plugins/cache",
            "plugins/cache/keep/**",
        ]);
        expect(plan.files.map((file) => file.destination)).toEqual([
            "data/runtime/.gitignore",
            "data/runtime/.secret",
            "data/runtime/plugins/cache/keep/a",
            "data/runtime/plugins/player.yml",
            "data/runtime/world/level.dat",
        ]);
        const stage = await privateBackupDirectory(root, "stage-");
        const manifest = await stageBackupPlan(plan, stage);
        expect(manifest.map((file) => file.destination)).toEqual(
            plan.files.map((file) => file.destination),
        );
        expect(manifest.reduce((total, file) => total + file.size, 0)).toBe(
            plan.bytes,
        );
        for (const file of manifest)
            expect(
                (await hashBackupFile(path.join(stage, file.destination)))
                    .sha256,
            ).toBe(file.sha256);
        expect(
            await readFile(path.join(stage, "data/runtime/.secret"), "utf8"),
        ).toBe("hidden");
        await removePrivateBackupDirectory(root, stage);
    });

    it("shows explicit external roots and applies later exclusions to them", async () => {
        const root = await backupTestDirectory();
        const runtime = path.join(root, "runtime");
        await writeBackupTestFile(runtime, "world/level.dat", "world");
        await writeBackupTestFile(root, "shared/player.json", "player");
        await writeBackupTestFile(root, "shared/plugin.jar", "jar");
        const isolated = await planBackupFiles(runtime, ["**"]);
        expect(isolated.files).toHaveLength(1);
        const plan = await planBackupFiles(runtime, [
            "**",
            "../shared/**",
            "!**/*.jar",
        ]);
        expect(plan.roots.filter((item) => item.external)).toHaveLength(1);
        expect(
            plan.files.map((file) => path.basename(file.source)).sort(),
        ).toEqual(["level.dat", "player.json"]);
        expect(plan.warnings.join("\n")).toContain(path.join(root, "shared"));
        expect(
            plan.files.some((file) =>
                file.destination.startsWith("data/external/"),
            ),
        ).toBe(true);
    });

    it("supports explicit absolute directories and single files without scanning their parent", async () => {
        const root = await backupTestDirectory();
        const runtime = path.join(root, "runtime");
        await mkdir(runtime);
        const single = await writeBackupTestFile(
            root,
            "single.db",
            "sqlite fixture",
        );
        await writeBackupTestFile(root, "unrelated.txt", "not selected");
        const plan = await planBackupFiles(runtime, ["../single.db"]);
        expect(plan.files.map((file) => file.source)).toEqual([single]);
        const absolute = await planBackupFiles(runtime, [
            single.split(path.sep).join("/"),
        ]);
        expect(absolute.files).toHaveLength(1);
        expect(absolute.roots.find((item) => item.external)?.kind).toBe("file");
    });

    it("deduplicates overlapping explicit roots and rejects unsafe ones", async () => {
        const root = await backupTestDirectory();
        const runtime = path.join(root, "runtime");
        await mkdir(runtime);
        await writeBackupTestFile(root, "shared/sub/a", "a");
        const plan = await planBackupFiles(runtime, [
            "../shared/**",
            "../shared/sub/**",
            "../shared/**",
        ]);
        expect(plan.files).toHaveLength(1);
        await expect(
            planBackupFiles(runtime, ["../missing/**"]),
        ).rejects.toMatchObject({ code: "BACKUP_SOURCE_MISSING" });
        await expect(planBackupFiles(runtime, ["../**"])).rejects.toMatchObject(
            { code: "BACKUP_SOURCE_OVERLAP" },
        );
        await expect(
            planBackupFiles(
                runtime,
                ["**"],
                [path.join(runtime, "backup-repo")],
            ),
        ).rejects.toMatchObject({ code: "BACKUP_SELF_INCLUSION" });
        if (process.platform !== "win32")
            await expect(
                planBackupFiles(runtime, ["C:/outside/**"]),
            ).rejects.toMatchObject({ code: "BACKUP_SOURCE" });
    });

    it("does not follow symbolic links or Windows junctions", async () => {
        const root = await backupTestDirectory();
        const runtime = path.join(root, "runtime");
        const external = path.join(root, "external");
        await mkdir(runtime);
        await mkdir(external);
        await symlink(
            external,
            path.join(runtime, "linked"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(planBackupFiles(runtime, ["**"])).rejects.toMatchObject({
            code: "BACKUP_SYMLINK",
        });
    });

    it("fails closed when a selected file changes after planning", async () => {
        const root = await backupTestDirectory();
        const runtime = path.join(root, "runtime");
        const file = await writeBackupTestFile(runtime, "data", "before");
        const plan = await planBackupFiles(runtime, ["**"]);
        await writeFile(file, "changed after preview");
        const stage = await privateBackupDirectory(root, "stage-");
        await expect(stageBackupPlan(plan, stage)).rejects.toMatchObject({
            code: "BACKUP_SOURCE_CHANGED",
        });
        expect(await readdir(stage)).toEqual([]);
    });

    it("honors cancellation and refuses escaping cleanup paths", async () => {
        const root = await backupTestDirectory();
        const runtime = path.join(root, "runtime");
        await writeBackupTestFile(runtime, "data", "a");
        const plan = await planBackupFiles(runtime, ["**"]);
        await expect(
            stageBackupPlan(plan, root, AbortSignal.abort()),
        ).rejects.toThrow();
        await expect(
            removePrivateBackupDirectory(root, root),
        ).rejects.toMatchObject({ code: "BACKUP_CLEANUP" });
        await expect(
            removePrivateBackupDirectory(root, path.dirname(root)),
        ).rejects.toMatchObject({ code: "BACKUP_CLEANUP" });
        await expect(hashBackupFile(runtime)).rejects.toMatchObject({
            code: "BACKUP_FILE",
        });
        await expect(
            planBackupFiles(path.join(runtime, "data"), ["**"]),
        ).rejects.toMatchObject({ code: "BACKUP_SOURCE" });
    });

    it("checks available staging space before stopping data writers", async () => {
        const root = await backupTestDirectory();
        await expect(
            checkBackupSpace(path.join(root, "not-created", "yet"), 1),
        ).resolves.toBeUndefined();
        await expect(
            checkBackupSpace(root, Number.MAX_SAFE_INTEGER),
        ).rejects.toMatchObject({ code: "BACKUP_SPACE" });
        expect(pathsOverlap(root, path.join(root, "child"))).toBe(true);
        expect(pathsOverlap(root, `${root}-other`)).toBe(false);
    });

    it("secures private directories including literal special characters", async () => {
        const root = await backupTestDirectory();
        const directory = path.join(root, "private #'[日本語]");
        await ensurePrivateDirectory(directory);
        await writeBackupTestFile(directory, "secret", "private");
        await ensurePrivateDirectory(directory);
        expect(await readFile(path.join(directory, "secret"), "utf8")).toBe(
            "private",
        );
        if (process.platform !== "win32")
            expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        else {
            const acl = await readWindowsBackupTestAcl(directory);
            expect(acl.ownerSid).toBe(acl.currentSid);
            expect(acl.allowSids).toEqual([acl.currentSid]);
            expect(acl.protected).toBe(true);
        }
    });

    it.runIf(process.platform === "win32")(
        "restricts an already owned directory without requiring WRITE_OWNER",
        async () => {
            const root = await backupTestDirectory();
            const directory = path.join(root, "owned-modify-only");
            await mkdir(directory);
            await restrictBackupTestAclToModify(directory);
            const before = await readWindowsBackupTestAcl(directory);
            expect(before.ownerSid).toBe(before.currentSid);
            await ensurePrivateDirectory(directory);
            const after = await readWindowsBackupTestAcl(directory);
            expect(after.allowSids).toEqual([after.currentSid]);
            expect(after.protected).toBe(true);
            await writeBackupTestFile(directory, "secret", "still writable");
            expect(await readFile(path.join(directory, "secret"), "utf8")).toBe(
                "still writable",
            );
        },
    );
});
