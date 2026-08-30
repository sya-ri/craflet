import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    CRAFLET_VERSION,
    CrafletError,
    type ServerController,
    type ServerStatus,
} from "@craflet/core";
import { type } from "arktype";
import {
    assertNoSymlinks,
    atomicWrite,
    exists,
    writeJson,
} from "../filesystem/io.js";
import { ensurePrivateDirectory } from "../filesystem/private.js";
import { readState } from "../filesystem/state.js";
import {
    type RunnerRecord,
    RunnerRecordSchema,
    runnerRequest,
} from "./protocol.js";

export class NodeServerController implements ServerController {
    constructor(
        readonly projectDir: string,
        readonly home: string,
        readonly runnerEntry?: string,
        readonly signal?: AbortSignal,
    ) {}

    async record(): Promise<RunnerRecord | undefined> {
        const file = path.join(this.projectDir, ".craflet/runner.json");
        if (!(await exists(file))) return undefined;
        await assertNoSymlinks(this.projectDir, ".craflet/runner.json");
        try {
            if ((await stat(file)).size > 32768) return undefined;
            const parsed = RunnerRecordSchema(
                JSON.parse(await readFile(file, "utf8")),
            );
            if (
                parsed instanceof type.errors ||
                path.resolve(parsed.projectDir) !==
                    path.resolve(this.projectDir)
            )
                return undefined;
            return parsed;
        } catch {
            return undefined;
        }
    }

    async status(): Promise<ServerStatus> {
        const record = await this.record();
        if (!record)
            return {
                status:
                    (await exists(
                        path.join(this.projectDir, ".craflet/runner.json"),
                    )) ||
                    (await exists(
                        path.join(this.projectDir, ".craflet/process.lock"),
                    ))
                        ? "unknown"
                        : "stopped",
            };
        if (record.phase === "stopped") return this.stoppedStatus(record);
        try {
            const result = RunnerRecordSchema(
                await runnerRequest(record, "status"),
            );
            if (
                result instanceof type.errors ||
                result.token !== record.token ||
                result.pid !== record.pid ||
                result.activeId !== record.activeId
            )
                return { status: "unknown" };
            if (result.phase === "stopped") return this.stoppedStatus(result);
            return {
                status: result.phase,
                pid: result.pid,
                ...(result.javaPid ? { javaPid: result.javaPid } : {}),
                activeId: result.activeId,
                clean: result.clean,
            };
        } catch {
            return { status: "unknown" };
        }
    }

    private async stoppedStatus(record: RunnerRecord): Promise<ServerStatus> {
        if (await exists(path.join(this.projectDir, ".craflet/process.lock")))
            return { status: "unknown" };
        return {
            status: "stopped",
            clean: record.clean,
            ...(record.exitCode !== undefined
                ? { exitCode: record.exitCode }
                : {}),
        };
    }

    async start(activeId: string): Promise<ServerStatus> {
        this.signal?.throwIfAborted();
        const before = await this.status();
        if (before.status === "running") {
            if (before.activeId !== activeId)
                throw new CrafletError(
                    "ACTIVE_MISMATCH",
                    "A different active installation is already running.",
                    3,
                );
            return before;
        }
        if (before.status !== "stopped")
            throw new CrafletError(
                "UNKNOWN_PROCESS",
                "Only a confirmed stopped server can be started.",
                3,
            );
        if (!this.runnerEntry)
            throw new CrafletError(
                "RUNNER_MISSING",
                "The bundled runner entry is unavailable.",
            );
        const state = await readState(this.projectDir);
        if (!state.active || state.active.id !== activeId)
            throw new CrafletError(
                "ACTIVE_MISSING",
                "No matching active installation exists.",
                3,
            );
        const source = await readFile(this.runnerEntry);
        const hash = createHash("sha256").update(source).digest("hex");
        const runner = path.join(
            this.home,
            "runners",
            CRAFLET_VERSION,
            hash,
            "runner.mjs",
        );
        await assertNoSymlinks(this.home, path.relative(this.home, runner));
        if (!(await exists(runner))) await atomicWrite(runner, source);
        else if (
            createHash("sha256")
                .update(await readFile(runner))
                .digest("hex") !== hash
        )
            throw new CrafletError(
                "RUNNER_HASH",
                "Managed runner cache is corrupted.",
                3,
            );
        const token = randomUUID();
        await ensurePrivateDirectory(
            await assertNoSymlinks(this.projectDir, ".craflet"),
        );
        await writeJson(
            path.join(this.projectDir, ".craflet/runner-launch.json"),
            { protocol: 1, token, activeId, home: this.home },
        );
        const processHandle = spawn(
            process.execPath,
            [runner, this.projectDir],
            { detached: true, stdio: "ignore", windowsHide: true },
        );
        let spawnError: Error | undefined;
        let runnerExited = false;
        processHandle.once("error", (error) => {
            spawnError = error;
        });
        processHandle.once("exit", () => {
            runnerExited = true;
        });
        processHandle.unref();
        const deadline =
            Date.now() +
            (state.active.manifest.java?.startupTimeout ?? 180) * 1000;
        while (Date.now() < deadline) {
            this.signal?.throwIfAborted();
            if (spawnError)
                throw new CrafletError(
                    "RUNNER_SPAWN",
                    "Could not start the server runner.",
                );
            if (runnerExited)
                throw new CrafletError(
                    "RUNNER_EXITED",
                    "Runner exited before the server became ready. Inspect doctor and logs.",
                    1,
                );
            const current = await this.record();
            if (current?.token === token) {
                if (current.phase === "stopped")
                    throw new CrafletError(
                        "SERVER_EXITED",
                        "Server exited before becoming ready. Inspect craflet logs.",
                        1,
                    );
                if (current.phase === "running") return this.status();
            }
            await delay(150);
        }
        throw new CrafletError(
            "START_TIMEOUT",
            "Server did not become ready before the deadline. It was not killed; inspect status and logs.",
            3,
        );
    }

    async stop(force = false): Promise<ServerStatus> {
        // Graceful stop is also cancellation cleanup for foreground run; finish
        // confirming process exit even when the caller's start was interrupted.
        const before = await this.status();
        if (before.status === "stopped") return before;
        if (before.status === "unknown")
            throw new CrafletError(
                "UNKNOWN_PROCESS",
                "Refusing to signal an unidentified process.",
                3,
            );
        const record = await this.record();
        if (!record)
            throw new CrafletError(
                "UNKNOWN_PROCESS",
                "Runner identity is unavailable.",
                3,
            );
        const state = await readState(this.projectDir).catch(() => undefined);
        const timeout =
            (state?.active?.manifest.java?.stopTimeout ?? 120) * 1000 + 5000;
        await runnerRequest(
            record,
            force ? "force-stop" : "stop",
            undefined,
            timeout,
        );
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const current = await this.status();
            if (current.status === "stopped") return current;
            await delay(50);
        }
        throw new CrafletError(
            "STOP_UNCONFIRMED",
            "The server process exit could not be confirmed.",
            3,
        );
    }

    async command(text: string): Promise<void> {
        if (!text || /[\r\n\0]/.test(text) || text.length > 8192)
            throw new CrafletError(
                "COMMAND_INVALID",
                "Provide one console command without line breaks.",
                2,
            );
        const record = await this.record();
        if (!record || record.phase === "stopped")
            throw new CrafletError("NOT_RUNNING", "Server is not running.", 3);
        await runnerRequest(record, "command", text);
    }
}
