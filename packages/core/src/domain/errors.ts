export type ExitCode = 1 | 2 | 3 | 4 | 130;

export class CrafletError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly exitCode: ExitCode = 1,
        readonly hint?: string,
    ) {
        super(message);
        this.name = "CrafletError";
    }
}

export function invariant(
    condition: unknown,
    code: string,
    message: string,
    exitCode: ExitCode = 3,
): asserts condition {
    if (!condition) throw new CrafletError(code, message, exitCode);
}
