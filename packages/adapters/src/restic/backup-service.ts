import { createHash } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    realpath,
    unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    assertCompleteBackup,
    type BackupConfig,
    type BackupCreateResult,
    type BackupMetadata,
    type BackupOperationOptions,
    type BackupPlan,
    type BackupPrepareOptions,
    type BackupPruneOptions,
    type BackupRepository,
    type BackupRestoreOptions,
    type BackupRestorePlan,
    type BackupRestoreResult,
    type BackupSecretResolver,
    type BackupService,
    type BackupSetupOptions,
    type BackupSnapshot,
    CrafletError,
    type DatabaseBackupPort,
    type PreparedBackupTool,
    retentionArguments,
    validateBackupIdentifier,
    validateSnapshotId,
} from "@craflet/core";
import { NodeDatabaseBackupAdapter } from "../database/backup.js";
import {
    checkBackupSpace,
    hashBackupFile,
    pathsOverlap,
    planBackupFiles,
    privateBackupDirectory,
    removePrivateBackupDirectory,
    stageBackupPlan,
} from "../filesystem/backup-files.js";
import {
    assertNoSymlinks,
    atomicWrite,
    containedPath,
    exists,
} from "../filesystem/io.js";
import { ensurePrivateDirectory } from "../filesystem/private.js";
import { ResticBootstrap } from "./bootstrap.js";
import {
    backupArchiveDirectories,
    backupArchiveFiles,
    backupJson,
    MAX_ACTIVE_METADATA_BYTES,
    MAX_BACKUP_METADATA_BYTES,
    backupRecord as record,
    validateBackupMetadata,
    validateBackupRelativePath,
} from "./metadata.js";
import {
    type BackupProcessResult,
    type BackupProcessRunner,
    backupJsonLines,
    runBackupProcess,
    sanitizedBackupEnvironment,
} from "./process.js";
import {
    extractBackupArchive,
    verifyBackupRestoreLayout,
} from "./restore-archive.js";
import { backupSecretResolver } from "./secrets.js";

export {
    validateBackupMetadata,
    validateBackupRelativePath,
} from "./metadata.js";

export interface NodeBackupDependencies {
    runner?: BackupProcessRunner;
    bootstrap?: {
        prepare(options?: BackupPrepareOptions): Promise<PreparedBackupTool>;
    };
    databases?: DatabaseBackupPort;
    now?: () => Date;
    planFiles?: () => Promise<BackupPlan>;
    filePolicies?: NonNullable<BackupService["filePolicies"]>;
}

interface RepositoryContext {
    alias: string;
    repository: BackupRepository;
    env: NodeJS.ProcessEnv;
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new CrafletError(
            "BACKUP_JSON",
            "The backup repository returned malformed JSON.",
            3,
        );
    }
}

function successful(result: BackupProcessResult, operation: string): void {
    if (result.exitCode !== 0) {
        throw new CrafletError(
            "BACKUP_REPOSITORY",
            `Restic ${operation} failed with exit code ${result.exitCode}; diagnostic output is withheld to protect secrets.`,
            3,
        );
    }
}

export class NodeBackupService implements BackupService {
    readonly config: BackupConfig;
    readonly filePolicies?: NonNullable<BackupService["filePolicies"]>;
    private readonly runtime: string;
    private readonly temporaryRoot: string;
    private readonly runner: BackupProcessRunner;
    private readonly bootstrap: NonNullable<
        NodeBackupDependencies["bootstrap"]
    >;
    private readonly secrets: BackupSecretResolver;
    private readonly databases: DatabaseBackupPort;
    private readonly now: () => Date;
    private readonly customPlanFiles: NodeBackupDependencies["planFiles"];
    private prepared: PreparedBackupTool | undefined;
    private readonly projectId: string;

    constructor(
        private readonly projectDir: string,
        private readonly home: string,
        config: BackupConfig,
        secrets?: BackupSecretResolver,
        dependencies: NodeBackupDependencies = {},
    ) {
        this.config = config;
        if (dependencies.filePolicies)
            this.filePolicies = structuredClone(dependencies.filePolicies);
        this.runtime = path.resolve(projectDir, "runtime");
        this.temporaryRoot = path.join(home, "tmp", "backup");
        this.runner = dependencies.runner ?? runBackupProcess;
        this.bootstrap =
            dependencies.bootstrap ??
            new ResticBootstrap(home, { runner: this.runner });
        this.secrets = secrets ?? backupSecretResolver(projectDir);
        this.databases =
            dependencies.databases ??
            new NodeDatabaseBackupAdapter(
                projectDir,
                home,
                this.secrets,
                this.runner,
            );
        this.now = dependencies.now ?? (() => new Date());
        this.customPlanFiles = dependencies.planFiles;
        this.projectId =
            config.projectId ??
            createHash("sha256")
                .update(path.resolve(projectDir))
                .digest("hex")
                .slice(0, 32);
        validateBackupIdentifier(this.projectId, "Project backup ID");
    }

    async prepare(
        options: BackupPrepareOptions = {},
    ): Promise<PreparedBackupTool> {
        this.prepared = await this.bootstrap.prepare(options);
        return this.prepared;
    }

    async setup(
        alias: string,
        options: BackupSetupOptions = {},
    ): Promise<{ alias: string; path: string; id: string }> {
        const context = await this.context(alias, false);
        let result = await this.execute(context, ["cat", "config"], options);
        if (result.exitCode === 10) {
            if (!options.initialize || !options.confirm) {
                throw new CrafletError(
                    "BACKUP_REPOSITORY_UNINITIALIZED",
                    "This repository is not initialized. Use explicit --init and confirmation during backup setup.",
                    3,
                );
            }
            const parent = path.dirname(context.repository.path);
            if (!(await exists(parent)) || !(await lstat(parent)).isDirectory())
                throw new CrafletError(
                    "BACKUP_REPOSITORY_PARENT",
                    "The repository parent directory must already exist; verify that the NAS or local destination is mounted.",
                    3,
                );
            if (await exists(context.repository.path)) {
                if (
                    !(await lstat(context.repository.path)).isDirectory() ||
                    (await readdir(context.repository.path)).length > 0
                ) {
                    throw new CrafletError(
                        "BACKUP_REPOSITORY_NONEMPTY",
                        "Refusing to initialize a repository in a nonempty directory.",
                        3,
                    );
                }
            }
            successful(
                await this.execute(
                    context,
                    ["init", "--repository-version", "2"],
                    options,
                ),
                "init",
            );
            result = await this.execute(context, ["cat", "config"], options);
        }
        successful(result, "repository inspection");
        const id = this.repositoryId(result.stdout);
        const expected = options.expectedId ?? context.repository.id;
        if (expected && expected !== id)
            throw new CrafletError(
                "BACKUP_REPOSITORY_ID",
                "The repository ID does not match the explicitly expected repository.",
                3,
            );
        return { alias, path: await realpath(context.repository.path), id };
    }

    async plan(): Promise<BackupPlan> {
        const forbidden = [
            this.home,
            path.join(this.projectDir, ".craflet"),
            path.join(this.projectDir, ".git"),
            ...Object.values(this.config.repositories ?? {}).map(
                (repository) => repository.path,
            ),
        ];
        const plan = this.customPlanFiles
            ? await this.customPlanFiles()
            : await planBackupFiles(
                  this.runtime,
                  this.config.files,
                  forbidden,
                  this.projectDir,
              );
        for (const root of plan.roots) {
            if (forbidden.some((location) => pathsOverlap(root.path, location)))
                throw new CrafletError(
                    "BACKUP_SELF_INCLUSION",
                    "A selected root overlaps a repository or Craflet working directory.",
                    3,
                );
        }
        const managedSqlite = new Set<string>();
        for (const database of this.config.databases ?? []) {
            if (database.kind !== "sqlite") continue;
            const source = path.resolve(this.projectDir, database.path);
            for (const suffix of ["", "-wal", "-shm", "-journal"])
                managedSqlite.add(`${source}${suffix}`);
        }
        const originalFileCount = plan.files.length;
        plan.files = plan.files.filter(
            (file) => !managedSqlite.has(file.source),
        );
        plan.bytes = plan.files.reduce((sum, file) => sum + file.size, 0);
        plan.stagingBytes = plan.bytes;
        plan.databaseIds = (this.config.databases ?? []).map(
            (database) => database.id,
        );
        if (plan.files.length !== originalFileCount)
            plan.warnings.push(
                "Configured SQLite databases and sidecars are captured by the database adapter, not copied as ordinary runtime files.",
            );
        if (plan.databaseIds.length)
            plan.warnings.push(
                "Database dump sizes are additional to the file staging estimate. All writers in the declared consistency group must be stopped.",
            );
        return plan;
    }

    async preflight(options: BackupOperationOptions = {}): Promise<BackupPlan> {
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        const plan = await this.plan();
        await checkBackupSpace(this.temporaryRoot, plan.stagingBytes);
        await this.databases.preflight(
            this.config.databases ?? [],
            options.signal,
        );
        return plan;
    }

    async create(
        active: Record<string, unknown>,
        options: BackupOperationOptions = {},
    ): Promise<BackupCreateResult> {
        if (!record(active))
            throw new CrafletError(
                "BACKUP_ACTIVE_METADATA",
                "Active metadata must be a JSON object smaller than 4 MiB.",
                2,
            );
        const activeJson = backupJson(active);
        if (activeJson.length > MAX_ACTIVE_METADATA_BYTES)
            throw new CrafletError(
                "BACKUP_ACTIVE_METADATA",
                "Active metadata must be a JSON object smaller than 4 MiB.",
                2,
            );
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        const plan = await this.plan();
        await checkBackupSpace(this.temporaryRoot, plan.stagingBytes);
        const temporary = await privateBackupDirectory(
            this.temporaryRoot,
            "create-",
        );
        try {
            const payload = path.join(temporary, "payload");
            await mkdir(payload, { mode: 0o700 });
            const files = await stageBackupPlan(plan, payload, options.signal);
            const databases: BackupMetadata["databases"] = [];
            for (const database of this.config.databases ?? []) {
                options.signal?.throwIfAborted();
                databases.push(
                    await this.databases.dump(
                        database,
                        path.join(payload, "databases"),
                        options.signal,
                    ),
                );
            }
            const metadata: BackupMetadata = {
                format: 1,
                projectId: this.projectId,
                createdAt: this.now().toISOString(),
                active: parseJson(activeJson.toString("utf8")) as Record<
                    string,
                    unknown
                >,
                roots: plan.roots,
                files,
                databases,
            };
            validateBackupMetadata(metadata, this.projectId);
            await atomicWrite(
                path.join(payload, "metadata", "backup.json"),
                backupJson(metadata),
            );
            await atomicWrite(
                path.join(payload, "metadata", "active.json"),
                activeJson,
            );
            const sources = [
                ...files.map((file) => file.destination),
                ...databases.map((database) => database.file),
                "metadata/backup.json",
                "metadata/active.json",
            ].sort();
            const input = Buffer.from(`${sources.join("\0")}\0`, "utf8");
            const result = await this.execute(
                context,
                [
                    "backup",
                    "--tag",
                    "craflet",
                    "--tag",
                    this.projectTag(),
                    "--group-by",
                    "tags",
                    "--files-from-raw",
                    "-",
                ],
                options,
                { cwd: payload, input },
            );
            assertCompleteBackup(result.exitCode);
            const summary = backupJsonLines(result.stdout).find(
                (item) => record(item) && item.message_type === "summary",
            );
            if (!record(summary) || typeof summary.snapshot_id !== "string")
                throw new CrafletError(
                    "BACKUP_SNAPSHOT",
                    "Restic reported success without a snapshot ID.",
                    3,
                );
            validateSnapshotId(summary.snapshot_id);
            await this.requireRepository(context, options);
            return {
                snapshotId: summary.snapshot_id,
                repository: context.alias,
                fileCount: files.length,
                bytes: plan.bytes,
                metadata,
            };
        } finally {
            await removePrivateBackupDirectory(this.temporaryRoot, temporary);
        }
    }

    async list(
        options: BackupOperationOptions = {},
    ): Promise<BackupSnapshot[]> {
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        const result = await this.execute(
            context,
            ["snapshots", "--tag", this.projectTag()],
            options,
        );
        successful(result, "snapshot listing");
        const parsed = parseJson(result.stdout);
        if (parsed === null) return [];
        if (!Array.isArray(parsed))
            throw new CrafletError(
                "BACKUP_JSON",
                "Restic returned an invalid snapshot list.",
                3,
            );
        return parsed.map((snapshot) => {
            if (
                !record(snapshot) ||
                typeof snapshot.id !== "string" ||
                typeof snapshot.time !== "string" ||
                !Array.isArray(snapshot.tags) ||
                !snapshot.tags.includes(this.projectTag())
            ) {
                throw new CrafletError(
                    "BACKUP_JSON",
                    "Restic returned invalid or unrelated snapshot metadata.",
                    3,
                );
            }
            validateSnapshotId(snapshot.id);
            return {
                id: snapshot.id,
                shortId:
                    typeof snapshot.short_id === "string"
                        ? snapshot.short_id
                        : snapshot.id.slice(0, 8),
                time: snapshot.time,
                tags: snapshot.tags.filter(
                    (tag): tag is string => typeof tag === "string",
                ),
                paths: Array.isArray(snapshot.paths)
                    ? snapshot.paths.filter(
                          (item): item is string => typeof item === "string",
                      )
                    : [],
                ...(typeof snapshot.hostname === "string"
                    ? { hostname: snapshot.hostname }
                    : {}),
            };
        });
    }

    async show(
        snapshotId: string,
        options: BackupOperationOptions = {},
    ): Promise<BackupMetadata> {
        validateSnapshotId(snapshotId);
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        return this.readMetadata(context, snapshotId, options);
    }

    async diff(
        before: string,
        after: string,
        options: BackupOperationOptions = {},
    ): Promise<unknown[]> {
        validateSnapshotId(before);
        validateSnapshotId(after);
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        await this.readMetadata(context, before, options);
        await this.readMetadata(context, after, options);
        const result = await this.execute(
            context,
            ["diff", before, after],
            options,
        );
        successful(result, "snapshot comparison");
        return backupJsonLines(result.stdout);
    }

    async check(
        options: BackupOperationOptions & { readData?: boolean } = {},
    ): Promise<{ checked: true }> {
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        successful(
            await this.execute(
                context,
                ["check", ...(options.readData ? ["--read-data"] : [])],
                options,
            ),
            "repository check",
        );
        return { checked: true };
    }

    async planRestore(
        snapshotId: string,
        options: BackupRestoreOptions,
    ): Promise<BackupRestorePlan> {
        return (await this.prepareRestore(snapshotId, options)).plan;
    }

    async restore(
        snapshotId: string,
        options: BackupRestoreOptions,
    ): Promise<BackupRestoreResult> {
        const { context, plan } = await this.prepareRestore(
            snapshotId,
            options,
        );
        const { target, metadata } = plan;
        await this.validateRestoreTarget(target);
        await ensurePrivateDirectory(target);
        await this.validateRestoreTarget(target);
        const marker = path.join(target, ".craflet-restore-incomplete.json");
        const markerFile = await open(marker, "wx", 0o600);
        try {
            await markerFile.writeFile(
                backupJson({
                    snapshotId,
                    status: "restoring",
                    note: "Do not apply partial restored data.",
                }),
            );
            await markerFile.sync();
        } finally {
            await markerFile.close();
        }
        const temporary = await privateBackupDirectory(
            target,
            ".craflet-restore-work-",
        );
        const expected = backupArchiveFiles(metadata);
        try {
            const archive = path.join(temporary, "snapshot.zip");
            successful(
                await this.execute(
                    context,
                    ["dump", snapshotId, "/", "--archive", "zip"],
                    options,
                    {
                        outputFile: archive,
                        maxFileOutputBytes: plan.archiveBytes,
                    },
                ),
                "snapshot archive extraction",
            );
            await extractBackupArchive(
                archive,
                target,
                expected,
                options.signal,
            );
        } finally {
            await removePrivateBackupDirectory(target, temporary);
        }
        await verifyBackupRestoreLayout(
            target,
            expected,
            path.basename(marker),
        );
        for (const file of metadata.files) {
            const restored = containedPath(target, file.destination);
            const integrity = await hashBackupFile(restored);
            if (
                integrity.sha256 !== file.sha256 ||
                integrity.bytes !== file.size
            )
                throw new CrafletError(
                    "BACKUP_RESTORE_VERIFY",
                    "A restored file does not match its recorded digest.",
                    3,
                );
            await chmod(restored, file.mode);
        }
        for (const database of metadata.databases) {
            const integrity = await hashBackupFile(
                containedPath(target, database.file),
            );
            if (
                integrity.sha256 !== database.sha256 ||
                integrity.bytes !== database.bytes
            )
                throw new CrafletError(
                    "BACKUP_RESTORE_VERIFY",
                    "A restored database dump does not match its recorded digest.",
                    3,
                );
        }
        const restoredMetadata = validateBackupMetadata(
            parseJson(
                await readFile(
                    path.join(target, "metadata", "backup.json"),
                    "utf8",
                ),
            ),
            this.projectId,
        );
        const restoredActive = parseJson(
            await readFile(
                path.join(target, "metadata", "active.json"),
                "utf8",
            ),
        );
        if (
            !isDeepStrictEqual(restoredMetadata, metadata) ||
            !isDeepStrictEqual(restoredActive, metadata.active)
        ) {
            throw new CrafletError(
                "BACKUP_RESTORE_VERIFY",
                "Restored active metadata does not match the selected snapshot.",
                3,
            );
        }
        await unlink(marker);
        return { snapshotId, target, metadata };
    }

    private async validateRestoreTarget(target: string): Promise<void> {
        await assertNoSymlinks(target);
        if (
            pathsOverlap(target, this.projectDir) ||
            pathsOverlap(target, this.home) ||
            Object.values(this.config.repositories ?? {}).some((repository) =>
                pathsOverlap(target, repository.path),
            )
        ) {
            throw new CrafletError(
                "BACKUP_RESTORE_TARGET",
                "Restore into a separate empty directory outside the project, Craflet home, and repositories.",
                3,
            );
        }
        if (
            (await exists(target)) &&
            (!(await lstat(target)).isDirectory() ||
                (await readdir(target)).length > 0)
        ) {
            throw new CrafletError(
                "BACKUP_RESTORE_TARGET",
                "The restore destination must be an empty directory.",
                3,
            );
        }
    }

    private async prepareRestore(
        snapshotId: string,
        options: BackupRestoreOptions,
    ): Promise<{ context: RepositoryContext; plan: BackupRestorePlan }> {
        validateSnapshotId(snapshotId);
        const target = path.resolve(options.target);
        await this.validateRestoreTarget(target);
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        const metadata = await this.readMetadata(context, snapshotId, options);
        await this.verifySnapshotTree(context, snapshotId, metadata, options);
        const files = backupArchiveFiles(metadata);
        const directories = backupArchiveDirectories(files);
        const dataBytes = [...files.values()].reduce(
            (total, file) => total + file.size,
            0,
        );
        const names = [...files.keys(), ...directories];
        // Pinned restic uses ZIP deflate. Reserve generous framing and expansion
        // overhead, then enforce this budget while streaming the archive to disk.
        const archiveBytes =
            dataBytes +
            Math.ceil(dataBytes / 20) +
            names.reduce(
                (total, name) =>
                    total + 512 + Buffer.byteLength(name, "utf8") * 4,
                1024 * 1024,
            );
        const requiredBytes = dataBytes + archiveBytes + 16 * 1024 * 1024;
        if (!Number.isSafeInteger(requiredBytes))
            throw new CrafletError(
                "BACKUP_SPACE",
                "The snapshot exceeds the supported exact size range.",
                3,
            );
        await checkBackupSpace(target, dataBytes + archiveBytes);
        return {
            context,
            plan: {
                snapshotId,
                target,
                dataBytes,
                archiveBytes,
                requiredBytes,
                metadata,
            },
        };
    }

    async prune(
        options: BackupPruneOptions = {},
    ): Promise<{ applied: boolean; plan: unknown[] }> {
        const retention = retentionArguments(this.config.retention ?? {});
        if (options.apply && !options.confirm)
            throw new CrafletError(
                "BACKUP_PRUNE_CONFIRM",
                "Deleting snapshots requires explicit apply and confirmation.",
                3,
            );
        const context = await this.context(options.repository);
        await this.requireRepository(context, options);
        const args = [
            "forget",
            "--tag",
            this.projectTag(),
            "--group-by",
            "tags",
            ...retention,
        ];
        const preview = await this.execute(
            context,
            [...args, "--dry-run"],
            options,
        );
        successful(preview, "retention preview");
        const parsed = parseJson(preview.stdout);
        if (!Array.isArray(parsed))
            throw new CrafletError(
                "BACKUP_JSON",
                "Restic returned an invalid retention preview.",
                3,
            );
        if (options.apply)
            successful(
                await this.execute(context, [...args, "--prune"], options),
                "snapshot removal and pruning",
            );
        return { applied: options.apply === true, plan: parsed };
    }

    private projectTag(): string {
        return `craflet-project:${this.projectId}`;
    }

    private async context(
        alias = this.config.repository,
        requireId = true,
    ): Promise<RepositoryContext> {
        if (!alias)
            throw new CrafletError(
                "BACKUP_REPOSITORY",
                "Select a named backup repository with backup setup before creating backups.",
                2,
            );
        validateBackupIdentifier(alias, "Repository alias");
        const repository = this.config.repositories?.[alias];
        if (!repository)
            throw new CrafletError(
                "BACKUP_REPOSITORY",
                `Unknown backup repository alias: ${alias}`,
                2,
            );
        await this.validateRepositoryPath(repository.path);
        if (
            requireId &&
            (!repository.id || !/^[a-f0-9]{64}$/u.test(repository.id))
        )
            throw new CrafletError(
                "BACKUP_REPOSITORY_ID",
                "The repository alias must have an ID pinned by backup setup.",
                3,
            );
        const password = await this.secrets(repository.password);
        if (!password || password.includes("\0") || password.length > 65536)
            throw new CrafletError(
                "BACKUP_SECRET",
                "A required repository secret is missing or invalid.",
                3,
            );
        const env = sanitizedBackupEnvironment();
        if ("env" in repository.password) delete env[repository.password.env];
        env.RESTIC_PASSWORD = password;
        env.RESTIC_CACHE_DIR = path.join(this.home, "cache", "restic");
        return { alias, repository, env };
    }

    private async validateRepositoryPath(repository: string): Promise<void> {
        if (
            !path.isAbsolute(repository) ||
            repository === path.parse(repository).root ||
            repository.includes("\0")
        )
            throw new CrafletError(
                "BACKUP_REPOSITORY_PATH",
                "Choose an explicit absolute local or mounted NAS directory, not a filesystem root or remote backend URL.",
                2,
            );
        await assertNoSymlinks(repository);
        if (
            pathsOverlap(repository, this.runtime) ||
            pathsOverlap(repository, this.temporaryRoot)
        )
            throw new CrafletError(
                "BACKUP_SELF_INCLUSION",
                "The backup repository must not overlap runtime data or staging directories.",
                3,
            );
    }

    private repositoryId(stdout: string): string {
        const parsed = parseJson(stdout);
        if (
            !record(parsed) ||
            typeof parsed.id !== "string" ||
            !/^[a-f0-9]{64}$/u.test(parsed.id)
        )
            throw new CrafletError(
                "BACKUP_REPOSITORY_ID",
                "Restic returned an invalid repository ID.",
                3,
            );
        return parsed.id;
    }

    private async requireRepository(
        context: RepositoryContext,
        options: BackupOperationOptions,
    ): Promise<void> {
        const result = await this.execute(context, ["cat", "config"], options);
        successful(result, "repository inspection");
        if (this.repositoryId(result.stdout) !== context.repository.id)
            throw new CrafletError(
                "BACKUP_REPOSITORY_ID",
                "The repository ID changed. Verify the destination or NAS mount before continuing.",
                3,
            );
    }

    private async execute(
        context: RepositoryContext,
        args: string[],
        options: BackupOperationOptions,
        io: {
            cwd?: string;
            input?: Uint8Array;
            outputFile?: string;
            maxFileOutputBytes?: number;
            maxOutputBytes?: number;
        } = {},
    ): Promise<BackupProcessResult> {
        options.signal?.throwIfAborted();
        this.prepared ??= await this.prepare({
            offline: true,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        return this.runner({
            executable: this.prepared.path,
            args: ["--repo", context.repository.path, "--json", ...args],
            env: context.env,
            ...io,
            ...(options.signal ? { signal: options.signal } : {}),
        });
    }

    private async readMetadata(
        context: RepositoryContext,
        snapshotId: string,
        options: BackupOperationOptions,
    ): Promise<BackupMetadata> {
        const result = await this.execute(
            context,
            ["dump", snapshotId, "/metadata/backup.json"],
            options,
            { maxOutputBytes: MAX_BACKUP_METADATA_BYTES },
        );
        successful(result, "snapshot metadata read");
        return validateBackupMetadata(parseJson(result.stdout), this.projectId);
    }

    private async verifySnapshotTree(
        context: RepositoryContext,
        snapshotId: string,
        metadata: BackupMetadata,
        options: BackupOperationOptions,
    ): Promise<void> {
        const result = await this.execute(
            context,
            ["ls", snapshotId],
            options,
            { maxOutputBytes: MAX_BACKUP_METADATA_BYTES * 4 },
        );
        successful(result, "snapshot tree inspection");
        const allowed = backupArchiveFiles(metadata);
        const directories = backupArchiveDirectories(allowed);
        const found = new Set<string>();
        const seenDirectories = new Set<string>();
        for (const node of backupJsonLines(result.stdout)) {
            if (record(node) && node.struct_type === "snapshot") continue;
            if (
                !record(node) ||
                typeof node.path !== "string" ||
                !node.path.startsWith("/") ||
                !["file", "dir"].includes(String(node.type))
            )
                throw new CrafletError(
                    "BACKUP_RESTORE_TREE",
                    "The snapshot contains unsupported or linked filesystem entries.",
                    3,
                );
            const relative = validateBackupRelativePath(node.path.slice(1));
            if (node.type === "dir") {
                if (!directories.has(relative) || seenDirectories.has(relative))
                    throw new CrafletError(
                        "BACKUP_RESTORE_TREE",
                        "The snapshot contains undeclared or duplicate directories.",
                        3,
                    );
                seenDirectories.add(relative);
                continue;
            }
            const expected = allowed.get(relative);
            if (!expected || found.has(relative) || node.size !== expected.size)
                throw new CrafletError(
                    "BACKUP_RESTORE_TREE",
                    "The snapshot contains undeclared, duplicate or incorrectly sized files.",
                    3,
                );
            found.add(relative);
        }
        if (found.size !== allowed.size)
            throw new CrafletError(
                "BACKUP_RESTORE_TREE",
                "The snapshot is missing files declared in its manifest.",
                3,
            );
    }
}
