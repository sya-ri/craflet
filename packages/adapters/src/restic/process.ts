import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CrafletError } from "@craflet/core";

export interface BackupProcessRequest {
    executable: string;
    args: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutputBytes?: number;
    input?: Uint8Array;
    inputFile?: string;
    outputFile?: string;
    maxFileOutputBytes?: number;
}

export interface BackupProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type BackupProcessRunner = (
    request: BackupProcessRequest,
) => Promise<BackupProcessResult>;

export const runBackupProcess: BackupProcessRunner = async (request) => {
    request.signal?.throwIfAborted();
    if (request.input && request.inputFile)
        throw new CrafletError(
            "BACKUP_PROCESS_INPUT",
            "Only one process input is supported.",
            2,
        );
    const output = request.outputFile
        ? await open(request.outputFile, "wx", 0o600)
        : undefined;
    try {
        return await new Promise<BackupProcessResult>((resolve, reject) => {
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(request.executable, [...request.args], {
                    ...(request.cwd ? { cwd: request.cwd } : {}),
                    env: request.env ?? process.env,
                    shell: false,
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                });
            } catch {
                reject(
                    new CrafletError(
                        "BACKUP_PROCESS_START",
                        "Could not start the configured backup executable.",
                        3,
                    ),
                );
                return;
            }
            const maximum = request.maxOutputBytes ?? 16 * 1024 * 1024;
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputSize = 0;
            let failure: CrafletError | undefined;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            let inputTask: Promise<void> | undefined;
            let outputTask: Promise<void> | undefined;
            const stop = (error: CrafletError) => {
                failure ??= error;
                child.kill("SIGTERM");
                killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
                killTimer.unref();
            };
            const onAbort = () =>
                stop(
                    new CrafletError(
                        "BACKUP_ABORTED",
                        "Backup command was interrupted.",
                        130,
                    ),
                );
            request.signal?.addEventListener("abort", onAbort, { once: true });
            const timeout = setTimeout(
                () =>
                    stop(
                        new CrafletError(
                            "BACKUP_PROCESS_TIMEOUT",
                            "Backup command exceeded its time limit.",
                            3,
                        ),
                    ),
                request.timeoutMs ?? 30 * 60 * 1000,
            );
            timeout.unref();
            const collect = (target: Buffer[], chunk: Buffer) => {
                outputSize += chunk.length;
                if (outputSize > maximum) {
                    stop(
                        new CrafletError(
                            "BACKUP_PROCESS_OUTPUT",
                            "Backup command output exceeded its configured limit.",
                            3,
                        ),
                    );
                    return;
                }
                target.push(Buffer.from(chunk));
            };
            if (output && child.stdout) {
                let fileBytes = 0;
                const destination = new Writable({
                    write(chunk: Buffer, _encoding, callback) {
                        void (async () => {
                            fileBytes += chunk.length;
                            if (
                                fileBytes >
                                (request.maxFileOutputBytes ??
                                    Number.MAX_SAFE_INTEGER)
                            ) {
                                throw new CrafletError(
                                    "BACKUP_PROCESS_OUTPUT",
                                    "Backup archive output exceeded its configured limit.",
                                    3,
                                );
                            }
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
                                        "BACKUP_PROCESS_OUTPUT",
                                        "Could not write backup command output.",
                                        3,
                                    );
                                offset += written.bytesWritten;
                            }
                        })().then(
                            () => callback(),
                            () =>
                                callback(
                                    new CrafletError(
                                        "BACKUP_PROCESS_OUTPUT",
                                        "Could not write backup archive within its output limit.",
                                        3,
                                    ),
                                ),
                        );
                    },
                });
                outputTask = pipeline(child.stdout, destination).catch(() => {
                    stop(
                        new CrafletError(
                            "BACKUP_PROCESS_OUTPUT",
                            "Could not write backup archive within its output limit.",
                            3,
                        ),
                    );
                });
            } else {
                child.stdout?.on("data", (chunk: Buffer) =>
                    collect(stdout, chunk),
                );
            }
            child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
            child.on("error", () => {
                failure ??= new CrafletError(
                    "BACKUP_PROCESS_START",
                    "Could not start the configured backup executable.",
                    3,
                );
            });
            child.stdin?.on("error", () => {
                failure ??= new CrafletError(
                    "BACKUP_PROCESS_INPUT",
                    "Backup command could not consume its input.",
                    3,
                );
            });
            if (child.stdin) {
                if (request.inputFile) {
                    inputTask = pipeline(
                        createReadStream(request.inputFile),
                        child.stdin,
                    ).catch(() => {
                        stop(
                            new CrafletError(
                                "BACKUP_PROCESS_INPUT",
                                "Backup command could not consume its input file.",
                                3,
                            ),
                        );
                    });
                } else {
                    child.stdin.end(request.input);
                }
            }
            child.on("close", (exitCode) => {
                clearTimeout(timeout);
                if (killTimer) clearTimeout(killTimer);
                request.signal?.removeEventListener("abort", onAbort);
                void (async () => {
                    await inputTask;
                    await outputTask;
                    if (failure) reject(failure);
                    else {
                        await output?.sync();
                        resolve({
                            exitCode: exitCode ?? 1,
                            stdout: Buffer.concat(stdout).toString("utf8"),
                            stderr: Buffer.concat(stderr).toString("utf8"),
                        });
                    }
                })().catch(() =>
                    reject(
                        new CrafletError(
                            "BACKUP_PROCESS_OUTPUT",
                            "Could not finalize backup command output.",
                            3,
                        ),
                    ),
                );
            });
            if (request.signal?.aborted) onAbort();
        });
    } finally {
        await output?.close();
    }
};

export function sanitizedBackupEnvironment(): NodeJS.ProcessEnv {
    const result = { ...process.env };
    for (const key of Object.keys(result)) {
        if (
            /^(RESTIC_|MYSQL_PWD$|MYSQL_TEST_LOGIN_FILE$|MYSQL_HOME$|MARIADB_HOME$)/iu.test(
                key,
            )
        )
            delete result[key];
    }
    return result;
}

export function backupJsonLines(value: string): unknown[] {
    try {
        return value
            .split(/\r?\n/u)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as unknown);
    } catch {
        throw new CrafletError(
            "BACKUP_PROCESS_JSON",
            "Backup executable returned invalid JSON.",
            3,
        );
    }
}
