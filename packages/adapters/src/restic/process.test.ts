import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile,
} from "../../../../tests/integration/backup-fixtures.js";
import {
    backupJsonLines,
    runBackupProcess,
    sanitizedBackupEnvironment,
} from "./process.js";

afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupBackupTestDirectories();
});

describe("backup process adapter", () => {
    it("passes argv literally without a shell and captures status", async () => {
        const argument = "space & 'quote' ; $(not-a-command)";
        const result = await runBackupProcess({
            executable: process.execPath,
            args: [
                "-e",
                "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic');",
                argument,
            ],
        });
        expect(result).toEqual({
            exitCode: 0,
            stdout: argument,
            stderr: "diagnostic",
        });
        const failed = await runBackupProcess({
            executable: process.execPath,
            args: ["-e", "process.exit(3)"],
        });
        expect(failed.exitCode).toBe(3);
    });

    it("streams input and output through actual files", async () => {
        const directory = await backupTestDirectory();
        const inputFile = await writeBackupTestFile(
            directory,
            "input",
            "a".repeat(1024 * 1024),
        );
        const outputFile = path.join(directory, "output");
        const result = await runBackupProcess({
            executable: process.execPath,
            args: ["-e", "process.stdin.pipe(process.stdout)"],
            inputFile,
            outputFile,
        });
        expect(result.exitCode).toBe(0);
        expect((await readFile(outputFile)).length).toBe(1024 * 1024);
        expect(result.stdout).toBe("");
        const memory = await runBackupProcess({
            executable: process.execPath,
            args: ["-e", "process.stdin.pipe(process.stdout)"],
            input: Buffer.from("memory input"),
        });
        expect(memory.stdout).toBe("memory input");
    });

    it("rejects spawn failures without exposing executable arguments", async () => {
        const directory = await backupTestDirectory();
        await expect(
            runBackupProcess({
                executable: path.join(directory, "missing.exe"),
                args: ["fixture-secret"],
            }),
        ).rejects.toMatchObject({ code: "BACKUP_PROCESS_START" });
    });

    it("enforces output limits, timeout and cancellation", async () => {
        await expect(
            runBackupProcess({
                executable: process.execPath,
                args: [
                    "-e",
                    "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000)",
                ],
                maxOutputBytes: 100,
            }),
        ).rejects.toMatchObject({ code: "BACKUP_PROCESS_OUTPUT" });
        await expect(
            runBackupProcess({
                executable: process.execPath,
                args: ["-e", "setInterval(()=>{},1000)"],
                timeoutMs: 100,
            }),
        ).rejects.toMatchObject({ code: "BACKUP_PROCESS_TIMEOUT" });
        const abort = new AbortController();
        const task = runBackupProcess({
            executable: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            signal: abort.signal,
        });
        abort.abort();
        await expect(task).rejects.toMatchObject({ code: "BACKUP_ABORTED" });
        await expect(
            runBackupProcess({
                executable: process.execPath,
                args: [],
                signal: AbortSignal.abort(),
            }),
        ).rejects.toThrow();
        await expect(
            runBackupProcess({
                executable: process.execPath,
                args: [],
                input: Buffer.from("a"),
                inputFile: "file",
            }),
        ).rejects.toMatchObject({ code: "BACKUP_PROCESS_INPUT" });
    });

    it("bounds binary archive writes and refuses existing output files", async () => {
        const directory = await backupTestDirectory();
        const outputFile = path.join(directory, "limited.zip");
        await expect(
            runBackupProcess({
                executable: process.execPath,
                args: [
                    "-e",
                    "process.stdout.write(Buffer.alloc(1024 * 1024));",
                ],
                outputFile,
                maxFileOutputBytes: 100,
            }),
        ).rejects.toMatchObject({ code: "BACKUP_PROCESS_OUTPUT" });
        expect((await readFile(outputFile)).length).toBeLessThanOrEqual(100);
        await writeBackupTestFile(directory, "keep.zip", "existing bytes");
        await expect(
            runBackupProcess({
                executable: process.execPath,
                args: ["-e", "process.stdout.write('replacement')"],
                outputFile: path.join(directory, "keep.zip"),
            }),
        ).rejects.toMatchObject({ code: "EEXIST" });
        expect(await readFile(path.join(directory, "keep.zip"), "utf8")).toBe(
            "existing bytes",
        );
    });

    it("removes ambient restic password commands and MySQL overrides", () => {
        vi.stubEnv("RESTIC_PASSWORD_COMMAND", "unsafe command");
        vi.stubEnv("RESTIC_REPOSITORY", "other repo");
        vi.stubEnv("MYSQL_PWD", "secret");
        vi.stubEnv("MYSQL_TEST_LOGIN_FILE", "other login");
        const env = sanitizedBackupEnvironment();
        expect(env.RESTIC_PASSWORD_COMMAND).toBeUndefined();
        expect(env.RESTIC_REPOSITORY).toBeUndefined();
        expect(env.MYSQL_PWD).toBeUndefined();
        expect(env.MYSQL_TEST_LOGIN_FILE).toBeUndefined();
        expect(env.PATH ?? env.Path).toBeTruthy();
    });

    it("parses JSON lines without swallowing protocol errors", () => {
        expect(
            backupJsonLines('{"type":"first"}\r\n\n{"type":"second"}\n'),
        ).toEqual([{ type: "first" }, { type: "second" }]);
        expect(backupJsonLines("")).toEqual([]);
        expect(() => backupJsonLines("invalid")).toThrow(/invalid JSON/u);
    });
});
