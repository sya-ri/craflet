import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    databaseClientOptions,
    NodeDatabaseBackupAdapter,
} from "../../packages/adapters/src/database/backup.js";
import {
    privateBackupDirectory,
    removePrivateBackupDirectory,
} from "../../packages/adapters/src/filesystem/backup-files.js";
import { atomicWrite } from "../../packages/adapters/src/filesystem/io.js";
import {
    type BackupProcessRunner,
    runBackupProcess,
    sanitizedBackupEnvironment,
} from "../../packages/adapters/src/restic/process.js";
import type { MysqlBackupConfig } from "../../packages/core/src/domain/backup.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
} from "./backup-fixtures.js";

afterEach(cleanupBackupTestDirectories);

describe.runIf(Boolean(process.env.CRAFLEET_TEST_DATABASE_KIND))(
    "disposable SQL database service integration",
    () => {
        it("round-trips actual SQL data with matching MySQL or MariaDB clients", async () => {
            const kind = process.env.CRAFLEET_TEST_DATABASE_KIND;
            const database = process.env.CRAFLEET_TEST_DATABASE_NAME;
            const password = process.env.CRAFLEET_TEST_DATABASE_PASSWORD;
            if (
                (kind !== "mysql" && kind !== "mariadb") ||
                !database ||
                !/^crafleet_test_[a-z0-9_]+$/u.test(database) ||
                !password
            ) {
                throw new Error(
                    "SQL integration requires an explicit mysql/mariadb kind, a disposable crafleet_test_* database name, and a test password.",
                );
            }
            const root = await backupTestDirectory();
            const config: MysqlBackupConfig = {
                id: "sql-fixture",
                kind,
                host: "127.0.0.1",
                port: Number(process.env.CRAFLEET_TEST_DATABASE_PORT ?? "3306"),
                database,
                user: process.env.CRAFLEET_TEST_DATABASE_USER ?? "root",
                password: { env: "CRAFLEET_TEST_DATABASE_PASSWORD" },
                ...(process.env.CRAFLEET_TEST_DATABASE_DUMP_COMMAND
                    ? {
                          command:
                              process.env.CRAFLEET_TEST_DATABASE_DUMP_COMMAND,
                      }
                    : {}),
                ...(process.env.CRAFLEET_TEST_DATABASE_CLIENT_COMMAND
                    ? {
                          restoreCommand:
                              process.env.CRAFLEET_TEST_DATABASE_CLIENT_COMMAND,
                      }
                    : {}),
            };
            const wrappers = ["database-dump.mjs", "database-client.mjs"].map(
                (file) => path.resolve("tests/support", file),
            );
            // Invoke only the repository's known transport scripts through Node.
            // This keeps native DB clients and the production adapter unchanged
            // while allowing the same service test to run on Windows.
            const runClient: BackupProcessRunner = (request) =>
                wrappers.includes(path.resolve(request.executable))
                    ? runBackupProcess({
                          ...request,
                          executable: process.execPath,
                          args: [request.executable, ...request.args],
                      })
                    : runBackupProcess(request);
            const adapter = new NodeDatabaseBackupAdapter(
                root,
                path.join(root, "home"),
                undefined,
                runClient,
            );
            async function query(sql: string): Promise<string> {
                const directory = await privateBackupDirectory(
                    root,
                    "sql-query-",
                );
                try {
                    const credentials = path.join(directory, "client.cnf");
                    await atomicWrite(
                        credentials,
                        databaseClientOptions(config, password as string),
                    );
                    const env = sanitizedBackupEnvironment();
                    delete env.CRAFLEET_TEST_DATABASE_PASSWORD;
                    const result = await runClient({
                        executable:
                            config.restoreCommand ??
                            (kind === "mysql" ? "mysql" : "mariadb"),
                        args: [
                            `--defaults-file=${credentials}`,
                            ...(kind === "mysql" ? ["--no-login-paths"] : []),
                            "--batch",
                            "--raw",
                            "--skip-column-names",
                            `--database=${database}`,
                            `--execute=${sql}`,
                        ],
                        env,
                        timeoutMs: 30000,
                    });
                    if (result.exitCode !== 0)
                        throw new Error(
                            "Disposable SQL fixture command failed; diagnostic output is withheld.",
                        );
                    return result.stdout;
                } finally {
                    await removePrivateBackupDirectory(root, directory);
                }
            }
            await query(
                "CREATE TABLE IF NOT EXISTS crafleet_backup_probe (id INTEGER PRIMARY KEY, payload VARBINARY(255), note TEXT) ENGINE=InnoDB; REPLACE INTO crafleet_backup_probe VALUES (1, UNHEX('006265666f72650a6c696e65ff'), '日本語 fixture');",
            );
            try {
                await adapter.preflight([config]);
                const before = await query(
                    "SELECT HEX(payload), note FROM crafleet_backup_probe WHERE id=1",
                );
                expect(before).toContain("006265666F72650A6C696E65FF");
                const artifact = await adapter.dump(
                    config,
                    path.join(root, "dumps"),
                );
                const dump = path.join(root, "dumps", "sql-fixture.sql");
                expect((await readFile(dump)).length).toBe(artifact.bytes);
                await query(
                    "UPDATE crafleet_backup_probe SET payload=UNHEX('6166746572'), note='after' WHERE id=1",
                );
                expect(
                    await query(
                        "SELECT HEX(payload), note FROM crafleet_backup_probe WHERE id=1",
                    ),
                ).not.toBe(before);
                await adapter.preflightRestore([config]);
                await adapter.restore(config, dump, { confirm: true });
                expect(
                    await query(
                        "SELECT HEX(payload), note FROM crafleet_backup_probe WHERE id=1",
                    ),
                ).toBe(before);
            } finally {
                await query("DROP TABLE IF EXISTS crafleet_backup_probe");
            }
        }, 120000);
    },
);
