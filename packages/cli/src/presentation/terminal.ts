const REPLACEMENT = "?";

/** Preserve layout while preventing untrusted text from controlling a terminal. */
export function sanitizeTerminalOutput(value: string): string {
    return [...value]
        .map((character) => {
            const point = character.codePointAt(0) ?? 0;
            if (point === 0x0a || point === 0x09) return character;
            if (
                point <= 0x1f ||
                (point >= 0x7f && point <= 0x9f) ||
                point === 0x061c ||
                point === 0x200e ||
                point === 0x200f ||
                (point >= 0x202a && point <= 0x202e) ||
                (point >= 0x2066 && point <= 0x2069)
            )
                return REPLACEMENT;
            return character;
        })
        .join("");
}

export function formatRuntimeLogChunk(value: string, json: boolean): string {
    if (json) return `${JSON.stringify({ event: "log", text: value })}\n`;
    const sanitized = sanitizeTerminalOutput(value);
    return sanitized.endsWith("\n") ? sanitized : `${sanitized}\n`;
}
