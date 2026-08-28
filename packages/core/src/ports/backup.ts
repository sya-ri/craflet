import type {
    BackupConfig,
    BackupCreateResult,
    BackupMetadata,
    BackupPlan,
    BackupRestorePlan,
    BackupRestoreResult,
    BackupSecretReference,
    BackupSnapshot,
    DatabaseBackupArtifact,
    DatabaseBackupConfig,
} from "../domain/backup.js";

export type BackupSecretResolver = (
    reference: BackupSecretReference,
) => Promise<string>;

export interface BackupOperationOptions {
    repository?: string;
    signal?: AbortSignal;
}

export interface BackupPrepareOptions {
    offline?: boolean;
    signal?: AbortSignal;
    binaryPath?: string;
}

export interface PreparedBackupTool {
    path: string;
    version: string;
}

export interface BackupSetupOptions extends BackupOperationOptions {
    initialize?: boolean;
    confirm?: boolean;
    expectedId?: string;
}

export interface BackupRestoreOptions extends BackupOperationOptions {
    target: string;
}

export interface BackupPruneOptions extends BackupOperationOptions {
    apply?: boolean;
    confirm?: boolean;
}

export interface BackupService {
    readonly config: BackupConfig;
    /** Group coordinators retain each project's ordered rules and select their union. */
    readonly filePolicies?: readonly {
        baseDirectory: string;
        files: readonly string[];
    }[];
    prepare(options?: BackupPrepareOptions): Promise<PreparedBackupTool>;
    setup(
        alias: string,
        options?: BackupSetupOptions,
    ): Promise<{ alias: string; path: string; id: string }>;
    preflight(options?: BackupOperationOptions): Promise<BackupPlan>;
    plan(): Promise<BackupPlan>;
    create(
        active: Record<string, unknown>,
        options?: BackupOperationOptions,
    ): Promise<BackupCreateResult>;
    list(options?: BackupOperationOptions): Promise<BackupSnapshot[]>;
    show(
        snapshotId: string,
        options?: BackupOperationOptions,
    ): Promise<BackupMetadata>;
    diff(
        before: string,
        after: string,
        options?: BackupOperationOptions,
    ): Promise<unknown[]>;
    check(
        options?: BackupOperationOptions & { readData?: boolean },
    ): Promise<{ checked: true }>;
    planRestore(
        snapshotId: string,
        options: BackupRestoreOptions,
    ): Promise<BackupRestorePlan>;
    restore(
        snapshotId: string,
        options: BackupRestoreOptions,
    ): Promise<BackupRestoreResult>;
    prune(
        options?: BackupPruneOptions,
    ): Promise<{ applied: boolean; plan: unknown[] }>;
}

export interface DatabaseBackupPort {
    preflight(
        configs: readonly DatabaseBackupConfig[],
        signal?: AbortSignal,
    ): Promise<void>;
    dump(
        config: DatabaseBackupConfig,
        directory: string,
        signal?: AbortSignal,
    ): Promise<DatabaseBackupArtifact>;
    restore(
        config: DatabaseBackupConfig,
        file: string,
        options: { confirm: boolean; signal?: AbortSignal },
    ): Promise<void>;
}
