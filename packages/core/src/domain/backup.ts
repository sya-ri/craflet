import picomatch from "picomatch";
import { CrafletError } from "./errors.js";

export type BackupSecretReference = { env: string } | { file: string };

export interface BackupRepository {
    path: string;
    password: BackupSecretReference;
    id?: string;
}

export interface SqliteBackupConfig {
    id: string;
    kind: "sqlite";
    path: string;
}

export interface MysqlBackupConfig {
    id: string;
    kind: "mysql" | "mariadb";
    host: string;
    port?: number;
    database: string;
    user: string;
    password: BackupSecretReference;
    command?: string;
    restoreCommand?: string;
    sslCa?: string;
}

export type DatabaseBackupConfig = SqliteBackupConfig | MysqlBackupConfig;

export interface BackupRetention {
    keepLast?: number;
    keepDaily?: number;
    keepWeekly?: number;
    keepMonthly?: number;
    keepYearly?: number;
}

export interface BackupConfig {
    repository?: string;
    repositories?: Record<string, BackupRepository>;
    files: string[];
    databases?: DatabaseBackupConfig[];
    retention?: BackupRetention;
    group?: string;
    projectId?: string;
}

export const DEFAULT_BACKUP_PATTERNS = ["**", "!**/*.[jJ][aA][rR]"] as const;

export interface BackupRoot {
    id: string;
    path: string;
    external: boolean;
    kind: "directory" | "file";
}

export interface BackupFile {
    source: string;
    destination: string;
    rootId: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    device: number;
    inode: number;
    mode: number;
    matchedRule: number;
}

export interface BackupPlan {
    roots: BackupRoot[];
    files: BackupFile[];
    bytes: number;
    stagingBytes: number;
    databaseIds: string[];
    warnings: string[];
}

export interface BackupSnapshot {
    id: string;
    shortId: string;
    time: string;
    hostname?: string;
    tags: string[];
    paths: string[];
}

export interface DatabaseBackupArtifact {
    id: string;
    kind: DatabaseBackupConfig["kind"];
    file: string;
    sha256: string;
    bytes: number;
}

export interface BackupMetadata {
    format: 1;
    projectId: string;
    createdAt: string;
    active: Record<string, unknown>;
    roots: BackupRoot[];
    files: {
        destination: string;
        sha256: string;
        size: number;
        mode: number;
    }[];
    databases: DatabaseBackupArtifact[];
}

export interface BackupCreateResult {
    snapshotId: string;
    repository: string;
    fileCount: number;
    bytes: number;
    metadata: BackupMetadata;
}

export interface BackupRestoreResult {
    snapshotId: string;
    target: string;
    metadata: BackupMetadata;
}

export interface BackupRestorePlan {
    snapshotId: string;
    target: string;
    dataBytes: number;
    archiveBytes: number;
    requiredBytes: number;
    metadata: BackupMetadata;
}

export interface BackupSelection {
    included: boolean;
    matchedRule: number;
}

export interface BackupRule {
    pattern: string;
    include: boolean;
    absolute: boolean;
    external: boolean;
    staticPrefix: string;
}

function isAbsolutePattern(pattern: string): boolean {
    return pattern.startsWith("/") || /^[a-zA-Z]:\//u.test(pattern);
}

export function parseBackupRules(patterns: readonly string[]): BackupRule[] {
    if (patterns.length > 512) {
        throw new CrafletError(
            "BACKUP_PATTERNS",
            "At most 512 backup file rules are supported.",
            2,
        );
    }
    return patterns.map((value) => {
        if (
            !value ||
            value.length > 4096 ||
            /[\0\r\n]/u.test(value) ||
            value.startsWith("!!")
        ) {
            throw new CrafletError(
                "BACKUP_PATTERNS",
                "Backup rules must be nonempty patterns; !! force-ignore is not supported.",
                2,
            );
        }
        const include = !value.startsWith("!");
        const pattern = (include ? value : value.slice(1))
            .replaceAll("\\", "/")
            .replace(/^\.\//u, "");
        if (!pattern || /[{}]/u.test(pattern) || /[?*+@!]\(/u.test(pattern)) {
            throw new CrafletError(
                "BACKUP_PATTERNS",
                "Backup rules support *, **, ?, and character classes; braces and extglobs are not supported.",
                2,
            );
        }
        const segments = pattern.split("/");
        const magic = segments.findIndex((segment) => /[*?[]/u.test(segment));
        const staticPrefix =
            magic === -1 ? pattern : segments.slice(0, magic).join("/");
        if (magic !== -1 && segments.slice(magic).includes("..")) {
            throw new CrafletError(
                "BACKUP_PATTERNS",
                "Parent traversal after a wildcard is not supported.",
                2,
            );
        }
        const absolute = isAbsolutePattern(pattern);
        const external = absolute || segments.includes("..");
        return { pattern, include, absolute, external, staticPrefix };
    });
}

export function createBackupSelector(
    patterns: readonly string[],
): (relative: string, absolute?: string) => BackupSelection {
    const rules = parseBackupRules(patterns).map((rule) => ({
        ...rule,
        match: picomatch(rule.pattern.replace(/\/$/u, "/**"), {
            dot: true,
            nocase: false,
            nonegate: true,
            noextglob: true,
            nobrace: true,
            strictBrackets: true,
            maxLength: 4096,
        }),
    }));
    return (relative, absolute) => {
        let included = false;
        let matchedRule = -1;
        rules.forEach((rule, index) => {
            const candidate = rule.absolute
                ? absolute
                : rule.external
                  ? relative
                  : relative.replace(/^(?:\.\.\/)+/u, "");
            const normalized = candidate?.replaceAll("\\", "/");
            const ancestors = normalized
                ?.split("/")
                .map((_, part, segments) =>
                    segments.slice(0, part + 1).join("/"),
                );
            if (ancestors?.some((ancestor) => rule.match(ancestor))) {
                included = rule.include;
                matchedRule = index;
            }
        });
        return { included, matchedRule };
    };
}

export function validateBackupIdentifier(
    value: string,
    label = "Backup identifier",
): string {
    if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(value) ||
        ["__proto__", "constructor", "prototype"].includes(value.toLowerCase())
    ) {
        throw new CrafletError(
            "BACKUP_IDENTIFIER",
            `${label} must contain only letters, numbers, dots, underscores, or hyphens.`,
            2,
        );
    }
    return value;
}

export function validateSnapshotId(value: string): string {
    if (!/^[a-f0-9]{8,64}$/u.test(value)) {
        throw new CrafletError(
            "BACKUP_SNAPSHOT",
            "Use an explicit snapshot ID of 8 to 64 lowercase hexadecimal characters.",
            2,
        );
    }
    return value;
}

export function retentionArguments(retention: BackupRetention): string[] {
    const args: string[] = [];
    const fields = [
        ["keepLast", "--keep-last"],
        ["keepDaily", "--keep-daily"],
        ["keepWeekly", "--keep-weekly"],
        ["keepMonthly", "--keep-monthly"],
        ["keepYearly", "--keep-yearly"],
    ] as const;
    for (const [field, flag] of fields) {
        const value = retention[field];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new CrafletError(
                "BACKUP_RETENTION",
                "Retention counts must be positive integers.",
                2,
            );
        }
        args.push(flag, String(value));
    }
    if (args.length === 0) {
        throw new CrafletError(
            "BACKUP_RETENTION",
            "Configure at least one positive retention count before planning pruning.",
            2,
        );
    }
    return args;
}

export function assertCompleteBackup(exitCode: number): void {
    if (exitCode === 3) {
        throw new CrafletError(
            "BACKUP_INCOMPLETE",
            "Restic could not read all selected data. Any partial snapshot is not a successful backup.",
            3,
        );
    }
    if (exitCode !== 0) {
        throw new CrafletError(
            "BACKUP_FAILED",
            `Restic backup failed with exit code ${exitCode}.`,
            3,
        );
    }
}
