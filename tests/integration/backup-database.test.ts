import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    databaseClientOptions,
    NodeDatabaseBackupAdapter,
} from "../../packages/adapters/src/database/backup.js";
import type {
    BackupProcessRequest,
    BackupProcessRunner,
} from "../../packages/adapters/src/restic/process.js";
import type { MysqlBackupConfig } from "../../packages/core/src/domain/backup.js";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile,
} from "./backup-fixtures.js";

afterEach(cleanupBackupTestDirectories);

describe("SQLite backup using the actual Node SQLite engine", () => {
    it("captures a standalone database including WAL contents and restores only on explicit request", async () => {
        const root = await backupTestDirectory();
        const project = path.join(root, "project");
        const home = path.join(root, "home");
        const runtime = path.join(project, "runtime");
        await mkdir(runtime, { recursive: true });
        const { DatabaseSync } = await import("node:sqlite");
        const original = new DatabaseSync(path.join(runtime, "players.db"));
        original.exec(
            "PRAGMA journal_mode=WAL; CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO players VALUES (1, 'before');",
        );
        const adapter = new NodeDatabaseBackupAdapter(project, home);
        const config = {
            id: "players",
            kind: "sqlite",
            path: "runtime/players.db",
        } as const;
        let artifact: Awaited<ReturnType<typeof adapter.dump>>;
        try {
            artifact = await adapter.dump(config, path.join(root, "dumps"));
            original.exec("UPDATE players SET name = 'after' WHERE id=1;");
        } finally {
            original.close();
        }
        expect(artifact.kind).toBe("sqlite");
        expect(artifact.bytes).toBeGreaterThan(0);
        const dump = path.join(root, "dumps", "players.sqlite3");
        const verify = new DatabaseSync(dump, { readOnly: true });
        try {
            expect(verify.prepare("SELECT name FROM players").get()?.name).toBe(
                "before",
            );
        } finally {
            verify.close();
        }
        await expect(
            adapter.restore(config, dump, { confirm: false }),
        ).rejects.toMatchObject({ code: "DATABASE_RESTORE_CONFIRM" });
        await adapter.restore(config, dump, { confirm: true });
        const restored = new DatabaseSync(path.join(runtime, "players.db"), {
            readOnly: true,
        });
        try {
            expect(
                restored.prepare("SELECT name FROM players").get()?.name,
            ).toBe("before");
        } finally {
            restored.close();
        }
    });

    it("rejects duplicate IDs, invalid files, existing dump destinations and busy SQLite sidecars", async () => {
        const root = await backupTestDirectory();
        const source = await writeBackupTestFile(
            root,
            "runtime/players.db",
            "not a database",
        );
        const adapter = new NodeDatabaseBackupAdapter(
            root,
            path.join(root, "home"),
        );
        const config = {
            id: "players",
            kind: "sqlite",
            path: "runtime/players.db",
        } as const;
        await expect(adapter.preflight([config, config])).rejects.toMatchObject(
            { code: "DATABASE_DUPLICATE" },
        );
        await expect(
            adapter.dump(config, path.join(root, "bad-dump")),
        ).rejects.toThrow();
        expect(await readdir(path.join(root, "bad-dump"))).toEqual([]);
        await writeBackupTestFile(root, "dumps/players.sqlite3", "existing");
        await expect(
            adapter.dump(config, path.join(root, "dumps")),
        ).rejects.toMatchObject({ code: "DATABASE_DESTINATION" });
        await writeBackupTestFile(root, "runtime/players.db-wal", "busy");
        await expect(
            adapter.restore(config, path.join(root, "dumps/players.sqlite3"), {
                confirm: true,
            }),
        ).rejects.toMatchObject({ code: "DATABASE_SQLITE_BUSY" });
        await expect(
            adapter.restore(config, source, { confirm: true }),
        ).rejects.toMatchObject({ code: "DATABASE_RESTORE_SOURCE" });
        await expect(
            adapter.preflight([{ id: "bad", kind: "sqlite", path: "." }]),
        ).rejects.toMatchObject({ code: "DATABASE_SOURCE" });
    });
});

describe("SQL dump/restore command boundaries", () => {
    async function fixture(kind: "mysql" | "mariadb" = "mysql") {
        const root = await backupTestDirectory();
        const calls: BackupProcessRequest[] = [];
        const credentialContents: string[] = [];
        let failure = false;
        let engine = "";
        const runner: BackupProcessRunner = async (request) => {
            calls.push(request);
            const credentials = request.args.find((arg) =>
                arg.startsWith("--defaults-file="),
            );
            if (credentials)
                credentialContents.push(
                    await readFile(
                        credentials.slice("--defaults-file=".length),
                        "utf8",
                    ),
                );
            if (request.args.includes("--version"))
                return {
                    exitCode: 0,
                    stdout:
                        kind === "mysql"
                            ? "mysqldump Ver 8.4"
                            : "mariadb-dump Ver 11.8",
                    stderr: "",
                };
            const resultFile = request.args.find((argument) =>
                argument.startsWith("--result-file="),
            );
            if (resultFile)
                await writeFile(
                    resultFile.slice("--result-file=".length),
                    "CREATE TABLE fixture(id INT);\n",
                );
            return {
                exitCode: failure ? 1 : 0,
                stdout: request.args.includes("--execute=SELECT 1")
                    ? "1\n"
                    : request.args.some((arg) => arg.startsWith("--execute="))
                      ? engine
                      : "",
                stderr: failure ? "fixture-password-should-never-leak" : "",
            };
        };
        const config: MysqlBackupConfig = {
            id: "players",
            kind,
            host: "127.0.0.1",
            database: "craflet_fixture",
            user: "fixture",
            password: { env: "TEST_DB_PASSWORD" },
        };
        const adapter = new NodeDatabaseBackupAdapter(
            root,
            path.join(root, "home"),
            async () => "fixture-password-should-never-leak",
            runner,
        );
        return {
            root,
            config,
            adapter,
            calls,
            credentialContents,
            fail: () => {
                failure = true;
            },
            unsupportedEngine: () => {
                engine = "MyISAM\n";
            },
        };
    }

    it.each(["mysql", "mariadb"] as const)(
        "uses private option files and literal argv for %s",
        async (kind) => {
            const { root, config, adapter, calls, credentialContents } =
                await fixture(kind);
            const artifact = await adapter.dump(
                config,
                path.join(root, "dumps"),
            );
            expect(artifact.file).toBe("databases/players.sql");
            const dump = calls.find((call) =>
                call.args.some((argument) =>
                    argument.startsWith("--result-file="),
                ),
            );
            expect(dump?.args[0]).toMatch(/^--defaults-file=/u);
            expect(dump?.args).toContain("--single-transaction");
            expect(dump?.args).toContain("--routines");
            expect(dump?.args).toContain("--events");
            expect(dump?.args).toContain("--triggers");
            expect(dump?.args.includes("--no-login-paths")).toBe(
                kind === "mysql",
            );
            expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(
                "fixture-password-should-never-leak",
            );
            expect(
                credentialContents.every((contents) =>
                    contents.includes(
                        'password="fixture-password-should-never-leak"',
                    ),
                ),
            ).toBe(true);
            expect(await readdir(path.join(root, "home/tmp/database"))).toEqual(
                [],
            );
            await adapter.restore(
                config,
                path.join(root, "dumps/players.sql"),
                { confirm: true },
            );
            expect(calls.at(-1)?.inputFile).toBe(
                path.join(root, "dumps/players.sql"),
            );
            expect(calls.at(-1)?.args).toContain("--binary-mode");
            expect(await readdir(path.join(root, "home/tmp/database"))).toEqual(
                [],
            );
        },
    );

    it("does not claim consistent dumps for unsupported storage engines", async () => {
        const { config, adapter, unsupportedEngine } = await fixture();
        unsupportedEngine();
        await expect(adapter.preflight([config])).rejects.toMatchObject({
            code: "DATABASE_ENGINE",
        });
    });

    it("checks the restore client and target before stopping writers, without requiring the dump executable", async () => {
        const { root, config, adapter, calls, credentialContents } =
            await fixture();
        const selected = {
            ...config,
            command: "./missing-dump",
            restoreCommand: "./tools/mysql",
        };
        await adapter.preflightRestore([selected]);
        expect(calls.map((call) => call.executable)).toEqual([
            path.join(root, "tools/mysql"),
            path.join(root, "tools/mysql"),
        ]);
        expect(calls[0]?.args).toEqual(["--no-defaults", "--version"]);
        expect(
            calls[1]?.args.some((arg) => arg.startsWith("--execute=SELECT 1")),
        ).toBe(true);
        expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(
            "fixture-password-should-never-leak",
        );
        expect(credentialContents).toHaveLength(1);
        expect(await readdir(path.join(root, "home/tmp/database"))).toEqual([]);
        await expect(
            adapter.preflightRestore([
                selected,
                { ...selected, id: "PLAYERS" },
            ]),
        ).rejects.toMatchObject({ code: "DATABASE_DUPLICATE" });
    });

    it("rejects a mismatched restore client kind and sanitizes authentication failures", async () => {
        const { root, config, adapter, fail } = await fixture("mysql");
        await expect(
            adapter.preflightRestore([{ ...config, kind: "mariadb" }]),
        ).rejects.toMatchObject({ code: "DATABASE_CLIENT" });
        fail();
        await expect(adapter.preflightRestore([config])).rejects.not.toThrow(
            /fixture-password-should-never-leak/u,
        );
        expect(await readdir(path.join(root, "home/tmp/database"))).toEqual([]);
    });

    it("fails without exposing client stderr and cleans credential files", async () => {
        const { root, config, adapter, fail } = await fixture();
        fail();
        await expect(
            adapter.dump(config, path.join(root, "dumps")),
        ).rejects.toMatchObject({ code: "DATABASE_PREFLIGHT" });
        expect(await readdir(path.join(root, "dumps"))).toEqual([]);
        expect(await readdir(path.join(root, "home/tmp/database"))).toEqual([]);
        const file = await writeBackupTestFile(
            root,
            "restore.sql",
            "CREATE TABLE fixture(id INT);",
        );
        await expect(
            adapter.restore(config, file, { confirm: true }),
        ).rejects.toMatchObject({ code: "DATABASE_RESTORE_PARTIAL" });
        await expect(
            adapter.restore(config, file, { confirm: true }),
        ).rejects.not.toThrow(/fixture-password-should-never-leak/u);
        expect(await readdir(path.join(root, "home/tmp/database"))).toEqual([]);
    });

    it("validates database identifiers, ports and TLS before invoking clients", async () => {
        const { root, config, adapter } = await fixture();
        await expect(
            adapter.preflight([{ ...config, database: "--all-databases" }]),
        ).rejects.toMatchObject({ code: "DATABASE_CONFIG" });
        await expect(
            adapter.preflight([{ ...config, port: 0 }]),
        ).rejects.toMatchObject({ code: "DATABASE_CONFIG" });
        await expect(
            adapter.preflight([{ ...config, host: "database.example.test" }]),
        ).rejects.toMatchObject({ code: "DATABASE_TLS" });
        await writeBackupTestFile(root, "ca.pem", "fixture certificate");
        await expect(
            adapter.preflight([
                { ...config, host: "database.example.test", sslCa: "ca.pem" },
            ]),
        ).resolves.toBeUndefined();
    });

    it("escapes option-file contents and selects verification flags per database kind", async () => {
        const { config } = await fixture();
        const contents = databaseClientOptions(
            config,
            'line1\n"[client]\\password',
            "ca.pem",
        );
        expect(contents).toContain(
            'password="line1\\n\\"[client]\\\\password"',
        );
        expect(contents).toContain("ssl-mode=VERIFY_IDENTITY");
        expect(
            databaseClientOptions(
                { ...config, kind: "mariadb" },
                "secret",
                "ca.pem",
            ),
        ).toContain("ssl-verify-server-cert=true");
        expect(() => databaseClientOptions(config, "bad\0secret")).toThrow();
    });
});
