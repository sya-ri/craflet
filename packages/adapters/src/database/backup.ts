import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
    type BackupSecretResolver,
    CrafletError,
    type DatabaseBackupArtifact,
    type DatabaseBackupConfig,
    type DatabaseBackupPort,
    type MysqlBackupConfig,
    validateBackupIdentifier,
} from "@craflet/core";
import {
    hashBackupFile,
    privateBackupDirectory,
    removePrivateBackupDirectory,
} from "../filesystem/backup-files.js";
import { assertNoSymlinks, atomicWrite, exists } from "../filesystem/io.js";
import { ensurePrivateDirectory } from "../filesystem/private.js";
import {
    type BackupProcessRunner,
    runBackupProcess,
    sanitizedBackupEnvironment,
} from "../restic/process.js";
import { backupSecretResolver } from "../restic/secrets.js";

const NON_INNODB_QUERY =
    "SELECT COALESCE(GROUP_CONCAT(DISTINCT ENGINE), '') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND ENGINE <> 'InnoDB'";

function mysqlOption(value: string): string {
    if (value.includes("\0"))
        throw new CrafletError(
            "DATABASE_CONFIG",
            "Database option values cannot contain NUL bytes.",
            2,
        );
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
}

export function databaseClientOptions(
    config: MysqlBackupConfig,
    password: string,
    caPath?: string,
): string {
    const values = [
        "[client]",
        `host=${mysqlOption(config.host)}`,
        `port=${config.port ?? 3306}`,
        `user=${mysqlOption(config.user)}`,
        `password=${mysqlOption(password)}`,
        "protocol=TCP",
        "default-character-set=utf8mb4",
    ];
    if (caPath) {
        values.push(`ssl-ca=${mysqlOption(caPath)}`);
        values.push(
            config.kind === "mysql"
                ? "ssl-mode=VERIFY_IDENTITY"
                : "ssl-verify-server-cert=true",
        );
    }
    return `${values.join("\n")}\n`;
}

function addDatabaseId(
    id: string,
    seen: Set<string>,
    operation: "backup" | "restore",
): void {
    validateBackupIdentifier(id, `Database ${operation} ID`);
    const key = id.toLowerCase();
    if (seen.has(key))
        throw new CrafletError(
            "DATABASE_DUPLICATE",
            `Each database ${operation} ID must be unique.`,
            2,
        );
    seen.add(key);
}

export class NodeDatabaseBackupAdapter implements DatabaseBackupPort {
    private readonly secrets: BackupSecretResolver;
    private readonly temporaryRoot: string;

    constructor(
        private readonly projectDir: string,
        home: string,
        secrets?: BackupSecretResolver,
        private readonly runner: BackupProcessRunner = runBackupProcess,
    ) {
        this.secrets = secrets ?? backupSecretResolver(projectDir);
        this.temporaryRoot = path.join(home, "tmp", "database");
    }

    async preflight(
        configs: readonly DatabaseBackupConfig[],
        signal?: AbortSignal,
    ): Promise<void> {
        const seen = new Set<string>();
        for (const config of configs) {
            signal?.throwIfAborted();
            addDatabaseId(config.id, seen, "backup");
            if (config.kind === "sqlite") {
                const source = this.sqlitePath(config.path);
                await assertNoSymlinks(source);
                if (!(await lstat(source)).isFile())
                    throw new CrafletError(
                        "DATABASE_SOURCE",
                        "SQLite backup sources must be regular files.",
                        3,
                    );
                continue;
            }
            await this.preflightMysql(config, "backup", signal);
        }
    }

    async preflightRestore(
        configs: readonly DatabaseBackupConfig[],
        signal?: AbortSignal,
    ): Promise<void> {
        const seen = new Set<string>();
        for (const config of configs) {
            signal?.throwIfAborted();
            addDatabaseId(config.id, seen, "restore");
            if (config.kind === "sqlite") {
                await assertNoSymlinks(this.sqlitePath(config.path));
                continue;
            }
            await this.preflightMysql(config, "restore", signal);
        }
    }

    async dump(
        config: DatabaseBackupConfig,
        directory: string,
        signal?: AbortSignal,
    ): Promise<DatabaseBackupArtifact> {
        validateBackupIdentifier(config.id, "Database backup ID");
        await ensurePrivateDirectory(directory);
        const name = `${config.id}.${config.kind === "sqlite" ? "sqlite3" : "sql"}`;
        const destination = path.join(directory, name);
        await assertNoSymlinks(destination);
        if (await exists(destination))
            throw new CrafletError(
                "DATABASE_DESTINATION",
                "A database dump destination already exists.",
                3,
            );
        try {
            await this.preflight([config], signal);
            if (config.kind === "sqlite") {
                await this.copySqlite(
                    this.sqlitePath(config.path),
                    destination,
                    signal,
                );
            } else {
                const reservation = await open(destination, "wx", 0o600);
                await reservation.close();
                await this.withCredentials(config, async (credentials, env) => {
                    const result = await this.runner({
                        executable: this.mysqlExecutable(config, "dump"),
                        args: [
                            credentials,
                            ...(config.kind === "mysql"
                                ? [
                                      "--no-login-paths",
                                      "--set-gtid-purged=OFF",
                                      "--column-statistics=0",
                                  ]
                                : []),
                            "--single-transaction",
                            "--quick",
                            "--routines",
                            "--events",
                            "--triggers",
                            "--hex-blob",
                            "--skip-dump-date",
                            "--no-tablespaces",
                            `--result-file=${destination}`,
                            "--",
                            config.database,
                        ],
                        env,
                        maxOutputBytes: 65536,
                        ...(signal ? { signal } : {}),
                    });
                    if (result.exitCode !== 0)
                        throw new CrafletError(
                            "DATABASE_DUMP",
                            "Database dump failed; client output is withheld to protect secrets.",
                            3,
                        );
                });
            }
            const integrity = await hashBackupFile(destination);
            if (integrity.bytes === 0)
                throw new CrafletError(
                    "DATABASE_DUMP",
                    "The database client produced an empty dump.",
                    3,
                );
            return {
                id: config.id,
                kind: config.kind,
                file: `databases/${name}`,
                ...integrity,
            };
        } catch (error) {
            await rm(destination, { force: true });
            throw error;
        }
    }

    async restore(
        config: DatabaseBackupConfig,
        file: string,
        options: { confirm: boolean; signal?: AbortSignal },
    ): Promise<void> {
        if (!options.confirm)
            throw new CrafletError(
                "DATABASE_RESTORE_CONFIRM",
                "Database restoration requires an explicit target and confirmation after a pre-restore backup.",
                3,
            );
        validateBackupIdentifier(config.id, "Database backup ID");
        await assertNoSymlinks(file);
        if (!(await lstat(file)).isFile())
            throw new CrafletError(
                "DATABASE_DUMP",
                "The database restore input must be a regular file.",
                3,
            );
        options.signal?.throwIfAborted();
        if (config.kind === "sqlite") {
            const target = this.sqlitePath(config.path);
            await assertNoSymlinks(target);
            if (path.resolve(file) === path.resolve(target))
                throw new CrafletError(
                    "DATABASE_RESTORE_SOURCE",
                    "The restore input and target must differ.",
                    3,
                );
            for (const suffix of ["-wal", "-shm", "-journal"]) {
                if (await exists(`${target}${suffix}`))
                    throw new CrafletError(
                        "DATABASE_SQLITE_BUSY",
                        "SQLite sidecar files are present. Verify the database is stopped and cleanly closed before restoration.",
                        3,
                    );
            }
            await mkdir(path.dirname(target), { recursive: true });
            const temporary = await privateBackupDirectory(
                path.dirname(target),
                ".craflet-sqlite-",
            );
            try {
                const staged = path.join(temporary, "restored.sqlite3");
                await this.copySqlite(file, staged, options.signal);
                options.signal?.throwIfAborted();
                await rename(staged, target);
            } finally {
                await removePrivateBackupDirectory(
                    path.dirname(target),
                    temporary,
                );
            }
            return;
        }
        this.validateMysql(config);
        await this.withCredentials(config, async (credentials, env) => {
            const result = await this.runner({
                executable: this.mysqlExecutable(config, "restore"),
                args: [
                    credentials,
                    ...(config.kind === "mysql" ? ["--no-login-paths"] : []),
                    "--binary-mode",
                    "--batch",
                    `--database=${config.database}`,
                ],
                inputFile: file,
                env,
                maxOutputBytes: 65536,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            if (result.exitCode !== 0)
                throw new CrafletError(
                    "DATABASE_RESTORE_PARTIAL",
                    "Database restoration failed and may have applied some statements. Keep all writers stopped and recover explicitly.",
                    3,
                );
        });
    }

    sqlitePath(source: string): string {
        return path.resolve(this.projectDir, source);
    }

    private mysqlExecutable(
        config: MysqlBackupConfig,
        operation: "dump" | "restore",
    ): string {
        const configured =
            operation === "restore" ? config.restoreCommand : config.command;
        if (configured)
            return /[\\/]/u.test(configured)
                ? path.resolve(this.projectDir, configured)
                : configured;
        if (operation === "restore")
            return config.kind === "mysql" ? "mysql" : "mariadb";
        return config.kind === "mysql" ? "mysqldump" : "mariadb-dump";
    }

    private async validateMysqlClient(
        config: MysqlBackupConfig,
        operation: "dump" | "restore",
        signal?: AbortSignal,
    ): Promise<string> {
        const executable = this.mysqlExecutable(config, operation);
        const result = await this.runner({
            executable,
            args: ["--no-defaults", "--version"],
            env: sanitizedBackupEnvironment(),
            timeoutMs: 10000,
            maxOutputBytes: 8192,
            ...(signal ? { signal } : {}),
        });
        const identifiesMaria = /mariadb/iu.test(result.stdout);
        const expectedClient =
            operation === "restore" ? /mysql/iu : /mysqldump/iu;
        const matchesKind =
            config.kind === "mariadb"
                ? identifiesMaria
                : !identifiesMaria && expectedClient.test(result.stdout);
        if (result.exitCode !== 0 || !matchesKind)
            throw new CrafletError(
                "DATABASE_CLIENT",
                `The configured ${operation} client does not match the selected database kind.`,
                3,
            );
        return executable;
    }

    private async preflightMysql(
        config: MysqlBackupConfig,
        purpose: "backup" | "restore",
        signal?: AbortSignal,
    ): Promise<void> {
        this.validateMysql(config);
        const backup = purpose === "backup";
        const validatedClient = await this.validateMysqlClient(
            config,
            backup ? "dump" : "restore",
            signal,
        );
        const queryClient = backup
            ? this.mysqlExecutable(config, "restore")
            : validatedClient;
        await this.withCredentials(config, async (credentials, env) => {
            const result = await this.runner({
                executable: queryClient,
                args: [
                    credentials,
                    ...(config.kind === "mysql" ? ["--no-login-paths"] : []),
                    "--batch",
                    ...(backup ? ["--raw"] : []),
                    "--skip-column-names",
                    `--database=${config.database}`,
                    `--execute=${backup ? NON_INNODB_QUERY : "SELECT 1"}`,
                ],
                env,
                timeoutMs: 30000,
                maxOutputBytes: backup ? 65536 : 8192,
                ...(signal ? { signal } : {}),
            });
            if (
                result.exitCode !== 0 ||
                (!backup && result.stdout.trim() !== "1")
            )
                throw new CrafletError(
                    "DATABASE_PREFLIGHT",
                    backup
                        ? "Database authentication or access preflight failed; client output is withheld to protect secrets."
                        : "Database restore authentication or target access failed; client output is withheld.",
                    3,
                );
            if (backup && result.stdout.trim())
                throw new CrafletError(
                    "DATABASE_ENGINE",
                    "Consistent SQL dumps currently require all base tables to use InnoDB. Other table engines require a separate locking strategy.",
                    3,
                );
        });
    }

    private validateMysql(config: MysqlBackupConfig): void {
        if (
            !config.host ||
            !config.user ||
            /[\0\r\n]/u.test(config.host) ||
            !/^[\p{L}\p{N}_][\p{L}\p{N}_$-]{0,63}$/u.test(config.database)
        ) {
            throw new CrafletError(
                "DATABASE_CONFIG",
                "The database host, user, or database name is invalid.",
                2,
            );
        }
        if (
            config.port !== undefined &&
            (!Number.isSafeInteger(config.port) ||
                config.port < 1 ||
                config.port > 65535)
        ) {
            throw new CrafletError(
                "DATABASE_CONFIG",
                "The database port must be between 1 and 65535.",
                2,
            );
        }
        if (
            !["localhost", "127.0.0.1", "::1"].includes(config.host) &&
            !config.sslCa
        ) {
            throw new CrafletError(
                "DATABASE_TLS",
                "A non-loopback database requires sslCa for verified TLS.",
                3,
            );
        }
    }

    private async withCredentials<T>(
        config: MysqlBackupConfig,
        action: (argument: string, env: NodeJS.ProcessEnv) => Promise<T>,
    ): Promise<T> {
        const password = await this.secrets(config.password);
        if (!password || password.includes("\0") || password.length > 65536)
            throw new CrafletError(
                "BACKUP_SECRET",
                "A required database secret is missing or invalid.",
                3,
            );
        const caPath = config.sslCa
            ? path.resolve(this.projectDir, config.sslCa)
            : undefined;
        if (caPath) {
            await assertNoSymlinks(caPath);
            if (!(await lstat(caPath)).isFile())
                throw new CrafletError(
                    "DATABASE_TLS",
                    "sslCa must identify a regular CA certificate file.",
                    3,
                );
        }
        const temporary = await privateBackupDirectory(
            this.temporaryRoot,
            "credentials-",
        );
        try {
            const file = path.join(temporary, "client.cnf");
            await atomicWrite(
                file,
                databaseClientOptions(config, password, caPath),
            );
            const env = sanitizedBackupEnvironment();
            if ("env" in config.password) delete env[config.password.env];
            return await action(`--defaults-file=${file}`, env);
        } finally {
            await removePrivateBackupDirectory(this.temporaryRoot, temporary);
        }
    }

    private async copySqlite(
        source: string,
        destination: string,
        signal?: AbortSignal,
    ): Promise<void> {
        await assertNoSymlinks(source);
        await assertNoSymlinks(destination);
        const reservation = await open(destination, "wx", 0o600);
        await reservation.close();
        const { backup, DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(source, {
            readOnly: true,
            allowExtension: false,
            timeout: 5000,
        });
        try {
            await backup(database, destination, {
                rate: 128,
                progress: () => signal?.throwIfAborted(),
            });
        } finally {
            database.close();
        }
        signal?.throwIfAborted();
        await chmod(destination, 0o600);
        const verification = new DatabaseSync(destination, {
            readOnly: true,
            allowExtension: false,
        });
        try {
            const result = verification.prepare("PRAGMA quick_check").all();
            if (
                result.length !== 1 ||
                Object.values(result[0] ?? {})[0] !== "ok"
            ) {
                throw new CrafletError(
                    "DATABASE_SQLITE_CHECK",
                    "The SQLite backup failed its integrity check.",
                    3,
                );
            }
        } finally {
            verification.close();
        }
    }
}
