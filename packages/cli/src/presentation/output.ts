import { CrafletError } from "@craflet/core";

export function printResult(result: unknown, json: boolean): void {
    if (result === undefined) return;
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    else if (typeof result === "string") process.stdout.write(`${result}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 4)}\n`);
}
export function printError(error: unknown, json: boolean): void {
    const normalized =
        error instanceof Error && error.name === "AbortError"
            ? new CrafletError(
                  "CANCELLED",
                  "Operation cancelled at a safe boundary.",
                  130,
              )
            : error;
    const known = normalized instanceof CrafletError;
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
            `Error [${code}]: ${message}\n${hint ? `${hint}\n` : ""}`,
        );
    process.exitCode = known ? normalized.exitCode : 1;
}
