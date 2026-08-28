import { createHash } from "node:crypto";
import { mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { CrafletError } from "@craflet/core";
import { openPromise } from "yauzl";
import { assertNoSymlinks, containedPath } from "../filesystem/io.js";
import {
    type BackupArchiveFile,
    backupArchiveDirectories,
    backupPathKey,
    validateBackupRelativePath,
} from "./metadata.js";

/** Materialize bytes only: never replay archive ownership, ACLs, links or xattrs. */
export async function extractBackupArchive(
    archive: string,
    target: string,
    files: ReadonlyMap<string, BackupArchiveFile>,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    await assertNoSymlinks(archive);
    await assertNoSymlinks(target);
    const directories = backupArchiveDirectories(files);
    const seen = new Set<string>();
    const extracted = new Set<string>();
    const zip = await openPromise(archive, {
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
    }).catch(() => {
        throw new CrafletError(
            "BACKUP_RESTORE_ARCHIVE",
            "The snapshot archive is not a readable ZIP file.",
            3,
        );
    });
    try {
        if (zip.entryCount > files.size + directories.size)
            throw new CrafletError(
                "BACKUP_RESTORE_ARCHIVE",
                "The archive has more entries than its declared payload.",
                3,
            );
        for await (const entry of zip.eachEntry()) {
            signal?.throwIfAborted();
            const directory = entry.fileName.endsWith("/");
            const relative = validateBackupRelativePath(
                directory ? entry.fileName.slice(0, -1) : entry.fileName,
            );
            const key = backupPathKey(relative);
            const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (
                seen.has(key) ||
                (entry.generalPurposeBitFlag & 0x41) !== 0 ||
                ![0, 8].includes(entry.compressionMethod) ||
                (unixType !== 0 &&
                    unixType !== (directory ? 0x4000 : 0x8000)) ||
                (!directory && (entry.externalFileAttributes & 0x10) !== 0)
            ) {
                throw new CrafletError(
                    "BACKUP_RESTORE_ARCHIVE",
                    "The archive contains duplicate, encrypted, linked or unsupported entries.",
                    3,
                );
            }
            seen.add(key);
            if (directory) {
                if (!directories.has(relative) || entry.uncompressedSize !== 0)
                    throw new CrafletError(
                        "BACKUP_RESTORE_ARCHIVE",
                        "The archive contains an undeclared directory.",
                        3,
                    );
                continue;
            }
            const expected = files.get(relative);
            if (!expected || entry.uncompressedSize !== expected.size)
                throw new CrafletError(
                    "BACKUP_RESTORE_ARCHIVE",
                    "The archive contains an undeclared file or an unexpected file size.",
                    3,
                );
            const destination = containedPath(target, relative);
            await assertNoSymlinks(target, relative);
            await mkdir(path.dirname(destination), {
                recursive: true,
                mode: 0o700,
            });
            const output = await open(destination, "wx", 0o600);
            try {
                const stream = await zip.openReadStreamPromise(entry);
                const onAbort = () =>
                    stream.destroy(
                        new CrafletError(
                            "BACKUP_ABORTED",
                            "Restore was interrupted.",
                            130,
                        ),
                    );
                signal?.addEventListener("abort", onAbort, { once: true });
                let bytes = 0;
                const hash = createHash("sha256");
                try {
                    for await (const chunk of stream) {
                        signal?.throwIfAborted();
                        bytes += chunk.length;
                        if (bytes > expected.size)
                            throw new CrafletError(
                                "BACKUP_RESTORE_ARCHIVE",
                                "An archive file exceeds its declared size.",
                                3,
                            );
                        hash.update(chunk);
                        let offset = 0;
                        while (offset < chunk.length) {
                            const written = await output.write(
                                chunk,
                                offset,
                                chunk.length - offset,
                                null,
                            );
                            if (written.bytesWritten === 0)
                                throw new CrafletError(
                                    "BACKUP_RESTORE_ARCHIVE",
                                    "Could not write restored data.",
                                    3,
                                );
                            offset += written.bytesWritten;
                        }
                    }
                } finally {
                    signal?.removeEventListener("abort", onAbort);
                    stream.destroy();
                }
                if (
                    bytes !== expected.size ||
                    hash.digest("hex") !== expected.sha256
                )
                    throw new CrafletError(
                        "BACKUP_RESTORE_VERIFY",
                        "Restored data does not match its declared size and SHA256.",
                        3,
                    );
                await output.sync();
                extracted.add(relative);
            } finally {
                await output.close();
            }
        }
        if (extracted.size !== files.size)
            throw new CrafletError(
                "BACKUP_RESTORE_ARCHIVE",
                "The archive is missing files declared by its snapshot metadata.",
                3,
            );
    } catch (error) {
        if (error instanceof CrafletError) throw error;
        if (signal?.aborted)
            throw new CrafletError(
                "BACKUP_ABORTED",
                "Restore was interrupted.",
                130,
            );
        throw new CrafletError(
            "BACKUP_RESTORE_ARCHIVE",
            "Could not safely extract the snapshot archive; partial data was retained for inspection.",
            3,
        );
    } finally {
        zip.close();
    }
}

export async function verifyBackupRestoreLayout(
    target: string,
    files: ReadonlyMap<string, BackupArchiveFile>,
    extraFile?: string,
): Promise<void> {
    const allowedFiles = new Set([
        ...files.keys(),
        ...(extraFile ? [extraFile] : []),
    ]);
    const directories = backupArchiveDirectories(files);
    const seen = new Set<string>();
    await assertNoSymlinks(target);
    async function visit(directory: string, prefix: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory() && directories.has(relative))
                await visit(path.join(directory, entry.name), relative);
            else if (entry.isFile() && allowedFiles.has(relative))
                seen.add(relative);
            else
                throw new CrafletError(
                    "BACKUP_RESTORE_VERIFY",
                    "The restore destination contains an undeclared directory, link, special file or payload.",
                    3,
                );
        }
    }
    await visit(target, "");
    if (seen.size !== allowedFiles.size)
        throw new CrafletError(
            "BACKUP_RESTORE_VERIFY",
            "The restored layout is missing declared files.",
            3,
        );
}
