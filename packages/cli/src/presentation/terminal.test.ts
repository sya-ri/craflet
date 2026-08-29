import { describe, expect, it } from "vitest";
import { formatRuntimeLogChunk, sanitizeTerminalOutput } from "./terminal.js";

describe("terminal output sanitization", () => {
    it("preserves readable layout while neutralizing terminal and bidi controls", () => {
        const value = [
            "first\tcolumn\n",
            "escape\u001b]52;c;payload\u0007",
            "\rbackspace\bnull\0delete\u007f",
            "c1\u0085",
            "bidi\u061c\u200e\u200f\u202a\u202e\u2066\u2069",
        ].join("");

        const output = sanitizeTerminalOutput(value);

        expect(output).toBe(
            "first\tcolumn\nescape?]52;c;payload??backspace?null?delete?c1?bidi???????",
        );
        expect(
            [...output].some((character) => {
                const point = character.codePointAt(0) ?? 0;
                return (
                    (point <= 0x1f && point !== 0x09 && point !== 0x0a) ||
                    (point >= 0x7f && point <= 0x9f)
                );
            }),
        ).toBe(false);
    });

    it("keeps JSON log framing exact and sanitizes only human log chunks", () => {
        const value = "line\tvalue\n\u001b]52;c;payload\u0007\r";

        expect(formatRuntimeLogChunk(value, true)).toBe(
            `${JSON.stringify({ event: "log", text: value })}\n`,
        );
        expect(formatRuntimeLogChunk(value, false)).toBe(
            "line\tvalue\n?]52;c;payload??\n",
        );
    });
});
