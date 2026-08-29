import { CrafletError } from "@craflet/core";
import { sanitizeInlineTerminalOutput } from "../presentation/terminal.js";

type PartialFailureUnit = { project: string } | { group: string };

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
    return (
        signal.aborted ||
        (error instanceof CrafletError && error.code === "CANCELLED") ||
        (error instanceof Error && error.name === "AbortError")
    );
}

export function partialFailure(
    error: unknown,
    unit: PartialFailureUnit,
    fallback: string,
) {
    const known = error instanceof CrafletError;
    return {
        ...("project" in unit
            ? { project: sanitizeInlineTerminalOutput(unit.project) }
            : { group: sanitizeInlineTerminalOutput(unit.group) }),
        ok: false as const,
        code: sanitizeInlineTerminalOutput(
            known ? error.code : "OPERATION_FAILED",
        ),
        message: sanitizeInlineTerminalOutput(known ? error.message : fallback),
    };
}
