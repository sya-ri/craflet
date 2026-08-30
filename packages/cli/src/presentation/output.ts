import { CrafleetError } from "@crafleet/core";
import { type HumanResultContext, renderHumanResult } from "./human.js";
import { sanitizeTerminalOutput } from "./terminal.js";

export function printResult(
    result: unknown,
    json: boolean,
    context: HumanResultContext,
): void {
    if (result === undefined) return;
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    else if (typeof result === "string")
        process.stdout.write(`${sanitizeTerminalOutput(result)}\n`);
    else {
        try {
            process.stdout.write(`${renderHumanResult(result, context)}\n`);
        } catch {
            process.stdout.write(
                "The operation may have completed in whole or in part, but its result could not be displayed safely. Verify with a read-only command such as crafleet status, crafleet plugins, or crafleet deploy plan before retrying.\n",
            );
        }
    }
}
export function printError(error: unknown, json: boolean): void {
    const normalized =
        error instanceof Error && error.name === "AbortError"
            ? new CrafleetError(
                  "CANCELLED",
                  "Operation cancelled at a safe boundary.",
                  130,
              )
            : error;
    const known = normalized instanceof CrafleetError;
    const code = known ? normalized.code : "UNEXPECTED";
    const message = known
        ? normalized.message
        : "An unexpected error occurred; no automatic retry or rollback was attempted.";
    const hint = known ? normalized.hint : undefined;
    if (json)
        process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } })}\n`,
        );
    else
        process.stderr.write(
            sanitizeTerminalOutput(
                `Error [${code}]: ${message}\n${hint ? `${hint}\n` : ""}`,
            ),
        );
    process.exitCode = known ? normalized.exitCode : 1;
}
