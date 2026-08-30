import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
    type BackupSecretReference,
    type BackupSecretResolver,
    CrafleetError,
} from "@crafleet/core";
import { assertNoSymlinks } from "../filesystem/io.js";

export function backupSecretResolver(projectDir: string): BackupSecretResolver {
    return async (reference: BackupSecretReference) => {
        let value: string | undefined;
        if ("env" in reference && !("file" in reference)) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(reference.env)) {
                throw new CrafleetError(
                    "BACKUP_SECRET",
                    "A backup secret environment reference is invalid.",
                    2,
                );
            }
            value = process.env[reference.env];
        } else if ("file" in reference && !("env" in reference)) {
            const file = path.resolve(projectDir, reference.file);
            await assertNoSymlinks(file);
            const details = await lstat(file);
            if (!details.isFile() || details.size > 64 * 1024) {
                throw new CrafleetError(
                    "BACKUP_SECRET",
                    "Backup secret files must be regular files smaller than 64 KiB.",
                    3,
                );
            }
            if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
                throw new CrafleetError(
                    "BACKUP_SECRET_PERMISSIONS",
                    "Backup secret files must not be readable by other users; set mode 0600.",
                    3,
                );
            }
            value = (await readFile(file, "utf8")).replace(/\r?\n$/u, "");
        } else {
            throw new CrafleetError(
                "BACKUP_SECRET",
                "Choose exactly one env or file reference for each backup secret.",
                2,
            );
        }
        if (!value || value.includes("\0")) {
            throw new CrafleetError(
                "BACKUP_SECRET",
                "A required backup secret is missing or invalid.",
                3,
            );
        }
        return value;
    };
}
