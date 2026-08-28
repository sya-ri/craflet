import { createHash } from "node:crypto";
import path from "node:path";
import {
    type BackupMetadata,
    CrafletError,
    validateBackupIdentifier,
} from "@craflet/core";

export const MAX_ACTIVE_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_BACKUP_METADATA_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_FILES = 250000;

export function backupRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function backupJson(value: unknown): Buffer {
    return Buffer.from(`${JSON.stringify(value, null, 4)}\n`, "utf8");
}

export function backupPathKey(value: string): string {
    // Keep snapshots portable to case-insensitive and Unicode-normalizing volumes.
    return value.normalize("NFC").toLowerCase();
}

export function validateBackupRelativePath(value: string): string {
    if (
        !value ||
        value.length > 4096 ||
        value.startsWith("/") ||
        value.includes("\\") ||
        value.includes("\0") ||
        value
            .split("/")
            .some((segment) => !segment || segment === "." || segment === "..")
    ) {
        throw new CrafletError(
            "BACKUP_RESTORE_PATH",
            "The snapshot contains an unsafe relative path.",
            3,
        );
    }
    if (
        process.platform === "win32" &&
        value
            .split("/")
            .some(
                (segment) =>
                    /[<>:"|?*]/u.test(segment) ||
                    [...segment].some(
                        (character) => character.charCodeAt(0) < 32,
                    ) ||
                    /[. ]$/u.test(segment) ||
                    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(
                        segment,
                    ),
            )
    ) {
        throw new CrafletError(
            "BACKUP_RESTORE_PATH",
            "The snapshot contains a filename that cannot be safely restored on Windows.",
            3,
        );
    }
    return value;
}

export function validateBackupMetadata(
    value: unknown,
    projectId: string,
): BackupMetadata {
    if (
        !backupRecord(value) ||
        value.format !== 1 ||
        value.projectId !== projectId ||
        typeof value.createdAt !== "string" ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        !backupRecord(value.active) ||
        !Array.isArray(value.roots) ||
        !Array.isArray(value.files) ||
        !Array.isArray(value.databases)
    ) {
        throw new CrafletError(
            "BACKUP_METADATA",
            "The snapshot has invalid Craflet metadata or belongs to a different project.",
            3,
        );
    }
    if (
        value.files.length + value.databases.length > MAX_BACKUP_FILES ||
        value.roots.length > 513 ||
        backupJson(value).length > MAX_BACKUP_METADATA_BYTES ||
        backupJson(value.active).length > MAX_ACTIVE_METADATA_BYTES
    ) {
        throw new CrafletError(
            "BACKUP_METADATA",
            "The snapshot manifest exceeds the supported metadata limits.",
            3,
        );
    }
    const rootIds = new Set<string>();
    let runtimeRoot = false;
    for (const root of value.roots) {
        if (
            !backupRecord(root) ||
            typeof root.id !== "string" ||
            typeof root.path !== "string" ||
            root.path.includes("\0") ||
            !(
                path.posix.isAbsolute(root.path) ||
                path.win32.isAbsolute(root.path)
            ) ||
            typeof root.external !== "boolean" ||
            !["directory", "file"].includes(String(root.kind))
        ) {
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot source mapping is invalid.",
                3,
            );
        }
        validateBackupIdentifier(root.id);
        if (rootIds.has(backupPathKey(root.id)))
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot repeats a source root ID.",
                3,
            );
        if (!root.external) {
            if (root.id !== "runtime" || root.kind !== "directory")
                throw new CrafletError(
                    "BACKUP_METADATA",
                    "The snapshot has an invalid runtime root.",
                    3,
                );
            runtimeRoot = true;
        } else if (backupPathKey(root.id) === "runtime") {
            throw new CrafletError(
                "BACKUP_METADATA",
                "An additional root cannot use the runtime ID.",
                3,
            );
        }
        rootIds.add(backupPathKey(root.id));
    }
    if (value.roots.length === 0)
        throw new CrafletError(
            "BACKUP_METADATA",
            "The snapshot has no declared data roots.",
            3,
        );
    const destinations = new Set<string>();
    for (const file of value.files) {
        if (
            !backupRecord(file) ||
            typeof file.destination !== "string" ||
            typeof file.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(file.sha256) ||
            !Number.isSafeInteger(file.size) ||
            Number(file.size) < 0 ||
            !Number.isSafeInteger(file.mode) ||
            Number(file.mode) < 0 ||
            Number(file.mode) > 0o777
        ) {
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot file manifest is invalid.",
                3,
            );
        }
        validateBackupRelativePath(file.destination);
        const components = file.destination.split("/");
        if (file.destination.startsWith("data/runtime/") && !runtimeRoot)
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot has runtime data without a runtime root.",
                3,
            );
        if (
            !(
                file.destination.startsWith("data/runtime/") ||
                (file.destination.startsWith("data/external/") &&
                    components.length >= 4 &&
                    value.roots.some(
                        (root) =>
                            backupRecord(root) &&
                            root.external === true &&
                            root.id === components[2],
                    ))
            )
        ) {
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot file is outside its declared data roots.",
                3,
            );
        }
        const key = backupPathKey(file.destination);
        if (destinations.has(key))
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot contains colliding file destinations.",
                3,
            );
        destinations.add(key);
    }
    const databases = new Set<string>();
    for (const database of value.databases) {
        if (
            !backupRecord(database) ||
            typeof database.id !== "string" ||
            !["sqlite", "mysql", "mariadb"].includes(String(database.kind)) ||
            typeof database.file !== "string" ||
            typeof database.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(database.sha256) ||
            !Number.isSafeInteger(database.bytes) ||
            Number(database.bytes) < 1
        ) {
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot database manifest is invalid.",
                3,
            );
        }
        validateBackupIdentifier(database.id);
        validateBackupRelativePath(database.file);
        if (
            database.file !==
            `databases/${database.id}.${database.kind === "sqlite" ? "sqlite3" : "sql"}`
        )
            throw new CrafletError(
                "BACKUP_METADATA",
                "A database artifact does not match its declared identifier and kind.",
                3,
            );
        const key = backupPathKey(database.file);
        const idKey = backupPathKey(database.id);
        if (databases.has(idKey) || destinations.has(key))
            throw new CrafletError(
                "BACKUP_METADATA",
                "The snapshot contains duplicate database entries.",
                3,
            );
        databases.add(idKey);
        destinations.add(key);
    }
    for (const destination of destinations) {
        const components = destination.split("/");
        for (let index = 1; index < components.length; index++) {
            if (destinations.has(components.slice(0, index).join("/")))
                throw new CrafletError(
                    "BACKUP_METADATA",
                    "The snapshot has a file and directory path collision.",
                    3,
                );
        }
    }
    return value as unknown as BackupMetadata;
}

export interface BackupArchiveFile {
    size: number;
    sha256: string;
}

export function backupArchiveFiles(
    metadata: BackupMetadata,
): Map<string, BackupArchiveFile> {
    const files = new Map<string, BackupArchiveFile>();
    for (const file of metadata.files)
        files.set(file.destination, { size: file.size, sha256: file.sha256 });
    for (const database of metadata.databases)
        files.set(database.file, {
            size: database.bytes,
            sha256: database.sha256,
        });
    for (const [name, value] of [
        ["metadata/backup.json", metadata],
        ["metadata/active.json", metadata.active],
    ] as const) {
        const bytes = backupJson(value);
        files.set(name, {
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    }
    return files;
}

export function backupArchiveDirectories(
    files: ReadonlyMap<string, BackupArchiveFile>,
): Set<string> {
    const directories = new Set<string>();
    for (const name of files.keys()) {
        const components = name.split("/");
        for (let index = 1; index < components.length; index++)
            directories.add(components.slice(0, index).join("/"));
    }
    return directories;
}
