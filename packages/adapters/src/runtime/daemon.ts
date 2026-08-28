import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CrafletError } from "@craflet/core";
import { type } from "arktype";
import { assertNoSymlinks, exists, writeJson } from "../filesystem/io.js";
import { ensurePrivateDirectory } from "../filesystem/private.js";
import { loadConfigSecrets } from "../filesystem/secrets.js";
import { readState } from "../filesystem/state.js";
import { parseConfigDocument } from "../formats/config.js";
import { javaExecutable } from "./java.js";
import { consumeLogLines } from "./output.js";
import {
    RunnerLaunchSchema,
    type RunnerRecord,
    RunnerRequestSchema,
} from "./protocol.js";
import { pingServer } from "./status-ping.js";

export async function runtimeEndpoint(
    projectDir: string,
    kind: "paper" | "velocity",
): Promise<{ host: string; port: number }> {
    const relative = kind === "paper" ? "server.properties" : "velocity.toml";
    const file = path.join(projectDir, "runtime", relative);
    await assertNoSymlinks(projectDir, `runtime/${relative}`);
    if (!(await exists(file))) return { host: "127.0.0.1", port: 25565 };
    const data = parseConfigDocument(relative, await readFile(file, "utf8"))
        .value as Record<string, unknown>;
    if (kind === "paper") {
        const host = String(data["server-ip"] || "127.0.0.1");
        const port = Number(data["server-port"] ?? 25565);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new CrafletError("SERVER_PORT", "Invalid server-port.", 2);
        return {
            host: ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host,
            port,
        };
    }
    const bind = String(data.bind ?? "0.0.0.0:25565");
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(bind);
    if (!match)
        throw new CrafletError(
            "SERVER_BIND",
            "Invalid Velocity bind address.",
            2,
        );
    const host = match[1] ?? match[2] ?? "127.0.0.1";
    const port = Number(match[3]);
    if (port < 1 || port > 65535)
        throw new CrafletError("SERVER_PORT", "Invalid Velocity port.", 2);
    return {
        host: ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host,
        port,
    };
}

export async function runServerDaemon(projectDir: string): Promise<void> {
    const privateDir = await assertNoSymlinks(projectDir, ".craflet");
    await ensurePrivateDirectory(privateDir);
    const launchFile = path.join(privateDir, "runner-launch.json");
    const launch = RunnerLaunchSchema(
        JSON.parse(await readFile(launchFile, "utf8")),
    );
    if (launch instanceof type.errors)
        throw new CrafletError(
            "RUNNER_LAUNCH",
            "Invalid runner launch request.",
            4,
        );
    const launchToken = launch.token;
    const state = await readState(projectDir);
    if (!state.active || state.active.id !== launch.activeId)
        throw new CrafletError(
            "RUNNER_ACTIVE",
            "Runner active installation mismatch.",
            4,
        );
    const active = state.active;
    const secrets = await loadConfigSecrets(
        projectDir,
        active.manifest.secrets,
    );
    const executable = await javaExecutable(active.manifest.java?.command);
    await assertNoSymlinks(projectDir, "runtime/server.jar");
    await assertNoSymlinks(projectDir, ".craflet/server.log");
    const guard = path.join(privateDir, "process.lock");
    try {
        await mkdir(guard);
    } catch {
        throw new CrafletError(
            "RUNNER_GUARD",
            "A server lifetime guard already exists. Inspect status before recovery.",
            4,
        );
    }
    await writeJson(path.join(guard, "owner.json"), {
        token: launch.token,
        pid: process.pid,
    });
    await rm(launchFile);
    const recordFile = path.join(privateDir, "runner.json");
    let record: RunnerRecord = {
        protocol: 1,
        projectDir: path.resolve(projectDir),
        token: launch.token,
        pid: process.pid,
        port: 0,
        activeId: active.id,
        phase: "starting",
        clean: true,
        startedAt: new Date().toISOString(),
    };
    // Snapshot and serialize writes so a late starting/running write cannot overwrite stopped.
    let recordWrites = Promise.resolve();
    const persistRecord = () => {
        const snapshot = { ...record };
        const writing = recordWrites.then(() =>
            writeJson(recordFile, snapshot),
        );
        recordWrites = writing.catch(() => {});
        return writing;
    };
    const output = createWriteStream(path.join(privateDir, "server.log"), {
        flags: "a",
        mode: 0o600,
    });
    let logFailed = false;
    output.on("error", () => {
        logFailed = true;
    });
    const log = (line: string) => {
        if (!logFailed)
            output.write(`${secrets.redact(line).slice(0, 65536)}\n`);
    };
    let stopRequested = false;
    let forced = false;
    let exited = false;
    let announcedReady = false;
    let resolveExit: () => void = () => {};
    const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
    });
    const control = net.createServer();
    control.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
        control.once("error", reject);
        control.listen(0, "127.0.0.1", () => {
            control.off("error", reject);
            resolve();
        });
    });
    const address = control.address();
    if (!address || typeof address === "string")
        throw new Error("Missing control address");
    record.port = address.port;
    try {
        await persistRecord();
    } catch {
        control.close();
        output.end();
        await assertNoSymlinks(projectDir, ".craflet/process.lock");
        await rm(guard, { recursive: true });
        throw new CrafletError(
            "RUNNER_STATE",
            "Runner state could not be persisted; Java was not started.",
            4,
        );
    }
    const args = [
        ...(active.manifest.java?.args ?? ["-Xms512M", "-Xmx2G"]),
        "-jar",
        "server.jar",
        ...(active.manifest.server.type === "paper" ? ["--nogui"] : []),
    ];
    const child = spawn(executable, args, {
        cwd: path.join(projectDir, "runtime"),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    if (child.pid) record.javaPid = child.pid;
    for (const stream of [child.stdout, child.stderr]) {
        consumeLogLines(stream, (line) => {
            log(line);
            if (/\bDone \([\d.,]+s\)!/.test(line)) announcedReady = true;
        });
    }
    async function finalized(code: number | null) {
        if (exited) return;
        exited = true;
        record = {
            ...record,
            phase: "stopped",
            clean: !forced && code === 0,
            exitCode: code,
        };
        try {
            await persistRecord();
            await assertNoSymlinks(projectDir, ".craflet/process.lock");
            const owner: unknown = JSON.parse(
                await readFile(path.join(guard, "owner.json"), "utf8"),
            );
            if (
                owner &&
                typeof owner === "object" &&
                "token" in owner &&
                owner.token === launchToken
            )
                await rm(guard, { recursive: true });
        } catch {
            log(
                "[craflet] Process ended, but durable state or lifetime-guard cleanup failed; run doctor and recover.",
            );
        } finally {
            await new Promise<void>((resolve) => output.end(() => resolve()));
            resolveExit();
            control.close();
        }
    }
    child.once("error", () => {
        log("[craflet] Java could not be spawned.");
        void finalized(1);
    });
    child.once("close", (code) => {
        void finalized(code);
    });
    child.stdin.on("error", () => {
        log("[craflet] Server input is no longer writable.");
    });
    if (!exited)
        await persistRecord().catch(() =>
            log(
                "[craflet] Runner process metadata could not be persisted; inspect doctor before any further operation.",
            ),
        );
    async function stop(force: boolean): Promise<void> {
        if (exited) return;
        stopRequested = true;
        forced ||= force;
        record.phase = "stopping";
        await persistRecord();
        if (exited) return;
        if (force) child.kill("SIGKILL");
        else
            child.stdin.write(
                active.manifest.server.type === "paper" ? "stop\n" : "end\n",
            );
        const timeout = (active.manifest.java?.stopTimeout ?? 120) * 1000;
        const timeoutAbort = new AbortController();
        try {
            await Promise.race([
                exitPromise,
                delay(timeout, undefined, { signal: timeoutAbort.signal }).then(
                    () => {
                        if (!exited)
                            throw new CrafletError(
                                "STOP_TIMEOUT",
                                "The server did not stop; it was not killed.",
                                3,
                            );
                    },
                ),
            ]);
        } finally {
            timeoutAbort.abort();
        }
    }
    control.on("connection", (socket) => {
        let body: Buffer = Buffer.alloc(0);
        let handled = false;
        socket.setTimeout(5000, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.on("data", (data: Buffer) => {
            if (handled) return;
            body = Buffer.concat([body, data]);
            if (body.length > 16384) {
                socket.destroy();
                return;
            }
            const newline = body.indexOf("\n");
            if (newline < 0) return;
            handled = true;
            void (async () => {
                try {
                    const request = RunnerRequestSchema(
                        JSON.parse(body.subarray(0, newline).toString("utf8")),
                    );
                    if (
                        request instanceof type.errors ||
                        !timingSafeEqual(
                            Buffer.from(request.token),
                            Buffer.from(launch.token),
                        )
                    )
                        throw new Error("Unauthorized");
                    socket.setTimeout(
                        (active.manifest.java?.stopTimeout ?? 120) * 1000 +
                            5000,
                    );
                    if (
                        request.command === "stop" ||
                        request.command === "force-stop"
                    )
                        await stop(request.command === "force-stop");
                    else if (request.command === "command") {
                        if (
                            !request.text ||
                            /[\r\n\0]/.test(request.text) ||
                            request.text.length > 8192 ||
                            exited ||
                            stopRequested
                        )
                            throw new Error("Invalid command");
                        child.stdin.write(`${request.text}\n`);
                    }
                    socket.end(
                        `${JSON.stringify({ ok: true, result: record })}\n`,
                    );
                } catch (error) {
                    const code =
                        error instanceof CrafletError &&
                        error.code === "STOP_TIMEOUT"
                            ? "STOP_TIMEOUT"
                            : undefined;
                    socket.end(
                        `${JSON.stringify({ ok: false, ...(code ? { code } : {}) })}\n`,
                    );
                }
            })();
        });
    });
    const interrupt = () => {
        void stop(false).catch(() => {
            log("[craflet] Graceful stop timed out; no automatic force kill.");
        });
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    while (!exited && !stopRequested) {
        if (announcedReady && record.phase === "starting") {
            try {
                const endpoint = await runtimeEndpoint(
                    projectDir,
                    active.manifest.server.type,
                );
                await pingServer(endpoint.host, endpoint.port);
                if (exited || stopRequested) break;
                record.phase = "running";
                await persistRecord();
            } catch {
                /* A ready log must be corroborated by a real server response. */
            }
        }
        await Promise.race([delay(150), exitPromise]);
    }
    await exitPromise;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
}
