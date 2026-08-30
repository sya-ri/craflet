import net from "node:net";
import { CrafleetError } from "@crafleet/core";
import { type } from "arktype";

export const RunnerRecordSchema = type({
    "+": "reject",
    protocol: "1",
    projectDir: "string",
    token: "string.uuid",
    pid: "number.integer > 0",
    "javaPid?": "number.integer > 0",
    port: "number.integer >= 0 & number <= 65535",
    activeId: "string.uuid",
    phase: "'starting' | 'running' | 'stopping' | 'stopped'",
    clean: "boolean",
    startedAt: "string",
    "exitCode?": "number | null",
});
export type RunnerRecord = typeof RunnerRecordSchema.infer;
export const RunnerLaunchSchema = type({
    "+": "reject",
    protocol: "1",
    token: "string.uuid",
    activeId: "string.uuid",
    home: "string",
});
export const RunnerRequestSchema = type({
    "+": "reject",
    token: "string.uuid",
    command: "'status' | 'stop' | 'force-stop' | 'command'",
    "text?": "string",
});

export async function runnerRequest(
    record: RunnerRecord,
    command: "status" | "stop" | "force-stop" | "command",
    text?: string,
    timeout = 5000,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({
            host: "127.0.0.1",
            port: record.port,
        });
        let response: Buffer = Buffer.alloc(0);
        let done = false;
        const fail = () => {
            if (!done) {
                done = true;
                socket.destroy();
                reject(
                    new CrafleetError(
                        "RUNNER_UNREACHABLE",
                        "The authenticated runner is unreachable; process identity is unknown.",
                        3,
                    ),
                );
            }
        };
        socket.setTimeout(timeout, fail);
        socket.once("error", fail);
        socket.once("close", fail);
        socket.once("connect", () =>
            socket.write(
                `${JSON.stringify({ token: record.token, command, ...(text !== undefined ? { text } : {}) })}\n`,
            ),
        );
        socket.on("data", (chunk: Buffer) => {
            if (done) return;
            response = Buffer.concat([response, chunk]);
            if (response.length > 64 * 1024) return fail();
            const newline = response.indexOf("\n");
            if (newline < 0) return;
            done = true;
            socket.destroy();
            try {
                const envelope: unknown = JSON.parse(
                    response.subarray(0, newline).toString("utf8"),
                );
                if (
                    !envelope ||
                    typeof envelope !== "object" ||
                    !("ok" in envelope) ||
                    typeof envelope.ok !== "boolean"
                )
                    throw new Error("Invalid protocol");
                if (
                    !envelope.ok &&
                    "code" in envelope &&
                    envelope.code === "STOP_TIMEOUT"
                )
                    throw new CrafleetError(
                        "STOP_TIMEOUT",
                        "The server did not stop before its deadline; no force kill was attempted.",
                        3,
                        "Inspect status and logs, or explicitly request stop --force if data loss is acceptable.",
                    );
                if (!envelope.ok)
                    throw new CrafleetError(
                        "RUNNER_COMMAND",
                        "Runner rejected the operation or the server did not stop before the timeout.",
                        3,
                    );
                const result = RunnerRecordSchema(
                    "result" in envelope ? envelope.result : undefined,
                );
                if (
                    result instanceof type.errors ||
                    result.token !== record.token ||
                    result.pid !== record.pid ||
                    result.activeId !== record.activeId ||
                    result.projectDir !== record.projectDir
                )
                    throw new Error("Runner identity mismatch");
                resolve(result);
            } catch (error) {
                reject(
                    error instanceof CrafleetError
                        ? error
                        : new CrafleetError(
                              "RUNNER_PROTOCOL",
                              "Runner returned an invalid or unauthenticated response.",
                              3,
                          ),
                );
            }
        });
    });
}
