import { chmod, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import type { BackupSecretReference } from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile,
} from "../../../../tests/integration/backup-fixtures.js";
import { backupSecretResolver } from "./secrets.js";

afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupBackupTestDirectories();
});

describe("backup secret references", () => {
    it("resolves exactly one env reference without literal-secret config", async () => {
        vi.stubEnv("CRAFLEET_SECRET_FIXTURE", "test password");
        const resolve = backupSecretResolver(".");
        expect(await resolve({ env: "CRAFLEET_SECRET_FIXTURE" })).toBe(
            "test password",
        );
        await expect(resolve({ env: "invalid-name" })).rejects.toMatchObject({
            code: "BACKUP_SECRET",
        });
        await expect(
            resolve({ env: "CRAFLEET_NONEXISTENT_SECRET_TEST_99" }),
        ).rejects.toMatchObject({ code: "BACKUP_SECRET" });
        await expect(
            resolve({
                env: "CRAFLEET_SECRET_FIXTURE",
                file: "file",
            } as BackupSecretReference),
        ).rejects.toMatchObject({ code: "BACKUP_SECRET" });
        await expect(
            resolve({} as BackupSecretReference),
        ).rejects.toMatchObject({ code: "BACKUP_SECRET" });
    });

    it("reads bounded regular secret files and preserves intentional spaces", async () => {
        const root = await backupTestDirectory();
        await writeBackupTestFile(root, "password", " pass word \r\n");
        const resolve = backupSecretResolver(root);
        expect(await resolve({ file: "password" })).toBe(" pass word ");
        await writeBackupTestFile(root, "empty", "\n");
        await expect(resolve({ file: "empty" })).rejects.toMatchObject({
            code: "BACKUP_SECRET",
        });
        await writeBackupTestFile(root, "large", "a".repeat(65537));
        await expect(resolve({ file: "large" })).rejects.toMatchObject({
            code: "BACKUP_SECRET",
        });
        await mkdir(path.join(root, "folder"));
        await expect(resolve({ file: "folder" })).rejects.toMatchObject({
            code: "BACKUP_SECRET",
        });
        if (process.platform !== "win32") {
            await chmod(path.join(root, "password"), 0o644);
            await expect(resolve({ file: "password" })).rejects.toMatchObject({
                code: "BACKUP_SECRET_PERMISSIONS",
            });
            await symlink(path.join(root, "large"), path.join(root, "link"));
            await expect(resolve({ file: "link" })).rejects.toMatchObject({
                code: "SYMLINK_UNSAFE",
            });
        }
    });
});
