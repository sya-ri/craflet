import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ConsoleTerminal } from "./console-terminal.js";

function streams(columns = 120, rows = 40) {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const rawModes: boolean[] = [];
    Object.assign(input, {
        isRaw: false,
        setRawMode(value: boolean) {
            rawModes.push(value);
            this.isRaw = value;
            return this;
        },
    });
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(output, { columns, rows });
    const writes: string[] = [];
    output.on("data", (chunk) => writes.push(chunk.toString()));
    return { input, output, rawModes, writes };
}

describe("console terminal", () => {
    it("buffers terminal input, preserves paste boundaries, and restores raw mode", async () => {
        const { input, output, rawModes, writes } = streams();
        const terminal = new ConsoleTerminal(input, output, {});
        const received: string[] = [];
        const resized = vi.fn();

        terminal.start((data) => received.push(data), resized);
        input.write("\u001b[");
        input.write("5~");
        input.write("\u001b[200~say hello\u001b[201~");
        output.emit("resize");

        await vi.waitFor(() => {
            expect(received).toEqual([
                "\u001b[5~",
                "\u001b[200~say hello\u001b[201~",
            ]);
        });
        expect(resized).toHaveBeenCalledOnce();
        expect(terminal.columns).toBe(120);
        expect(terminal.rows).toBe(40);
        expect(terminal.kittyProtocolActive).toBe(false);

        await terminal.drainInput(1, 1);
        terminal.stop();
        expect(rawModes).toEqual([true, false]);
        expect(writes.join("")).toContain("\u001b[?2004h");
        expect(writes.join("")).toContain("\u001b[?2004l");
        expect(input.listenerCount("data")).toBe(0);
        expect(output.listenerCount("resize")).toBe(0);
    });

    it("writes the terminal operations used by the TUI", () => {
        const { input, output, writes } = streams();
        const terminal = new ConsoleTerminal(input, output);

        terminal.write("text");
        terminal.moveBy(2);
        terminal.moveBy(-1);
        terminal.moveBy(0);
        terminal.hideCursor();
        terminal.showCursor();
        terminal.clearLine();
        terminal.clearFromCursor();
        terminal.clearScreen();
        terminal.setTitle("safe\u001btitle");
        terminal.setProgress(true);
        terminal.setProgress(false);

        expect(writes.join("")).toBe(
            "text\u001b[2B\u001b[1A\u001b[?25l\u001b[?25h\u001b[K\u001b[J\u001b[2J\u001b[H" +
                "\u001b]0;safetitle\u0007\u001b]9;4;3\u0007\u001b]9;4;0\u0007",
        );
    });

    it("rejects a second start while active", () => {
        const { input, output } = streams();
        const terminal = new ConsoleTerminal(input, output);
        terminal.start(
            () => {},
            () => {},
        );
        expect(() =>
            terminal.start(
                () => {},
                () => {},
            ),
        ).toThrow("already running");
        terminal.stop();
        terminal.stop();
    });

    it("uses the supplied environment when stream dimensions are unavailable", () => {
        const { input, output } = streams(0, 0);
        const terminal = new ConsoleTerminal(input, output, {
            COLUMNS: "99",
            LINES: "31",
        });
        expect(terminal.columns).toBe(99);
        expect(terminal.rows).toBe(31);
    });
});
