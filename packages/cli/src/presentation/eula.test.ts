import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    confirmEula,
    type EulaDocument,
    type EulaPagerState,
    handleEulaKey,
    renderEulaFrame,
    sanitizeEulaTerminalText,
} from "./eula.js";

class TtyInput extends PassThrough {
    readonly fd = 0;
    isTTY = true;
    isRaw = false;
    readonly setRawMode = vi.fn((value: boolean) => {
        this.isRaw = value;
        return this;
    });
}

class TtyOutput extends Writable {
    readonly fd = 2;
    isTTY = true;
    columns = 80;
    rows = 14;
    text = "";
    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        this.text += chunk.toString("utf8");
        callback();
    }
}

const document: EulaDocument = {
    path: "runtime/eula.txt",
    text: "# Review the agreement before changing eula=false.\n".repeat(8),
    url: "https://www.minecraft.net/eula",
};
const oldCi = process.env.CI;
let input: TtyInput;
let output: TtyOutput;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    Reflect.deleteProperty(process.env, "CI");
    input = new TtyInput();
    output = new TtyOutput();
    input.pause();
    vi.spyOn(process, "stdin", "get").mockReturnValue(
        input as unknown as typeof process.stdin,
    );
    vi.spyOn(process, "stderr", "get").mockReturnValue(
        output as unknown as typeof process.stderr,
    );
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
    if (oldCi === undefined) Reflect.deleteProperty(process.env, "CI");
    else process.env.CI = oldCi;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function key(value: string): void {
    input.emit("data", Buffer.from(value));
}

describe("EULA terminal presentation", () => {
    it("sanitizes terminal controls while preserving readable text", () => {
        expect(
            sanitizeEulaTerminalText(
                "before\u001b[2Jafter\rnext\titem\u202ereordered\u0007",
            ),
        ).toBe("beforeafter\nnext    itemreordered");
    });

    it("sanitizes the path, URL and document before rendering a bounded page", () => {
        const unsafeDocument = {
            path: "unsafe\npath\u001b[2J",
            text: "visible\u001b]8;;https://bad.example\u0007text\u001b]8;;\u0007",
            url: "https://example.com/terms\nforged heading",
        };
        const firstFrame = renderEulaFrame(
            unsafeDocument,
            { stage: "document", offset: 0, agree: false },
            { columns: 80, rows: 24 },
        );
        expect(firstFrame.text).toContain("File: unsafe path");
        expect(firstFrame.text).toContain(
            "Full agreement: https://example.com/terms forged heading",
        );
        expect(firstFrame.text).not.toContain("unsafe\npath");

        const frame = renderEulaFrame(
            unsafeDocument,
            { stage: "document", offset: 100, agree: false },
            { columns: 42, rows: 10 },
        );
        expect(frame.text).not.toContain("\u001b");
        expect(frame.text).toContain("text");
        expect(frame.maxOffset).toBeGreaterThan(0);
        expect(frame.offset).toBe(frame.maxOffset);
        expect(frame.text.split("\n").length).toBeLessThanOrEqual(9);
    });

    it("rejects terminals too small to display the consent choices", () => {
        expect(() =>
            renderEulaFrame(
                document,
                { stage: "document", offset: 0, agree: false },
                { columns: 39, rows: 10 },
            ),
        ).toThrow(expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }));
        expect(() =>
            renderEulaFrame(
                document,
                { stage: "document", offset: 0, agree: false },
                { columns: 40, rows: 9 },
            ),
        ).toThrow(expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }));
    });

    it("implements bounded scrolling and requires an explicit Agree selection", () => {
        const state: EulaPagerState = {
            stage: "document",
            offset: 5,
            agree: false,
        };
        const page = { pageSize: 3, maxOffset: 8 };
        expect(handleEulaKey(state, { name: "up" }, page).state.offset).toBe(4);
        expect(handleEulaKey(state, { name: "down" }, page).state.offset).toBe(
            6,
        );
        expect(
            handleEulaKey(state, { name: "pageup" }, page).state.offset,
        ).toBe(2);
        expect(
            handleEulaKey(state, { name: "pagedown" }, page).state.offset,
        ).toBe(8);
        expect(handleEulaKey(state, { name: "home" }, page).state.offset).toBe(
            0,
        );
        expect(handleEulaKey(state, { name: "end" }, page).state.offset).toBe(
            8,
        );
        const prompt = handleEulaKey(state, { name: "return" }, page).state;
        expect(prompt).toEqual({ stage: "confirm", offset: 5, agree: false });
        expect(handleEulaKey(prompt, { name: "return" }, page).result).toBe(
            "cancel",
        );
        const agreed = handleEulaKey(prompt, { name: "down" }, page).state;
        expect(handleEulaKey(agreed, { name: "return" }, page).result).toBe(
            "accept",
        );
        expect(
            handleEulaKey(state, { name: "c", ctrl: true }, page).result,
        ).toBe("cancel");
        expect(handleEulaKey(state, { name: "escape" }, page).result).toBe(
            "cancel",
        );
    });
});

describe("interactive EULA confirmation", () => {
    it("accepts only after paging forward and explicitly selecting Agree", async () => {
        const beforeSigint = process.listenerCount("SIGINT");
        const confirmation = confirmEula(document);
        key("\u001b[6~");
        key("\u001b[F");
        key("\r");
        expect(output.text).toContain("Scope: this OS user and host.");
        key("\u001b[B");
        key("\r");
        await expect(confirmation).resolves.toBeUndefined();
        expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
        expect(input.isRaw).toBe(false);
        expect(input.isPaused()).toBe(true);
        expect(input.listenerCount("data")).toBe(0);
        expect(output.listenerCount("resize")).toBe(0);
        expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
        expect(output.text).toContain("\u001b[?1049h");
        expect(output.text).toContain("\u001b[?1049l");
        expect(output.text).not.toContain("\u001b[?25");
        expect(stdout).not.toHaveBeenCalled();
    });

    it("keeps Decline as the default and cleans up after cancellation", async () => {
        const confirmation = confirmEula(document);
        key("\r");
        key("\r");
        await expect(confirmation).rejects.toMatchObject({
            code: "CANCELLED",
            exitCode: 130,
        });
        expect(input.isRaw).toBe(false);
        expect(input.listenerCount("data")).toBe(0);
        expect(output.text).toContain("\u001b[?1049l");
    });

    it.each(["q", "\u0003"])(
        "cancels with %j and never exits the process",
        async (sequence) => {
            const exit = vi.spyOn(process, "exit");
            const confirmation = confirmEula(document);
            key(sequence);
            await expect(confirmation).rejects.toMatchObject({
                code: "CANCELLED",
                exitCode: 130,
            });
            expect(exit).not.toHaveBeenCalled();
            expect(input.isRaw).toBe(false);
        },
    );

    it("cancels with Escape and restores the terminal", async () => {
        vi.useFakeTimers();
        const confirmation = confirmEula(document);
        key("\u001b");
        await vi.advanceTimersByTimeAsync(600);
        await expect(confirmation).rejects.toMatchObject({ code: "CANCELLED" });
        expect(input.isRaw).toBe(false);
        expect(output.text).toContain("\u001b[?1049l");
    });

    it("cancels from the shared signal and preserves pre-existing listeners and flow", async () => {
        const controller = new AbortController();
        const data = vi.fn();
        const resize = vi.fn();
        input.on("data", data);
        output.on("resize", resize);
        input.resume();
        const confirmation = confirmEula(document, {
            signal: controller.signal,
        });
        controller.abort();
        await expect(confirmation).rejects.toMatchObject({ code: "CANCELLED" });
        expect(input.listeners("data")).toEqual([data]);
        expect(output.listeners("resize")).toEqual([resize]);
        expect(input.readableFlowing).toBe(true);
    });

    it("does not alter a terminal that was already in raw mode", async () => {
        input.isRaw = true;
        const confirmation = confirmEula(document);
        key("q");
        await expect(confirmation).rejects.toMatchObject({ code: "CANCELLED" });
        expect(input.setRawMode).not.toHaveBeenCalled();
        expect(input.isRaw).toBe(true);
    });

    it("fails closed and restores listeners when raw mode cannot be enabled", async () => {
        input.setRawMode.mockImplementationOnce(() => {
            throw new Error("private terminal failure");
        });
        await expect(confirmEula(document)).rejects.toMatchObject({
            code: "EULA_TERMINAL",
        });
        expect(input.listenerCount("data")).toBe(0);
        expect(output.listenerCount("resize")).toBe(0);
        expect(output.text).not.toContain("private terminal failure");
    });

    it("accepts explicit --yes without reading or writing either terminal", async () => {
        process.env.CI = "true";
        input.isTTY = false;
        output.isTTY = false;
        await expect(
            confirmEula(document, { yes: true, json: true }),
        ).resolves.toBeUndefined();
        expect(input.setRawMode).not.toHaveBeenCalled();
        expect(output.text).toBe("");
        expect(stdout).not.toHaveBeenCalled();
    });

    it.each(["ci", "json", "input", "output"] as const)(
        "refuses %s headless interaction before changing terminal state",
        async (boundary) => {
            if (boundary === "ci") process.env.CI = "true";
            if (boundary === "json") {
                await expect(
                    confirmEula(document, { json: true }),
                ).rejects.toMatchObject({
                    code: "CONFIRMATION_REQUIRED",
                    exitCode: 3,
                });
            } else {
                if (boundary === "input") input.isTTY = false;
                if (boundary === "output") output.isTTY = false;
                await expect(confirmEula(document)).rejects.toMatchObject({
                    code: "CONFIRMATION_REQUIRED",
                    exitCode: 3,
                });
            }
            expect(input.setRawMode).not.toHaveBeenCalled();
            expect(output.text).toBe("");
        },
    );

    it("does not treat an explicit CI=false value as CI", async () => {
        process.env.CI = "false";
        const confirmation = confirmEula(document);
        key("q");
        await expect(confirmation).rejects.toMatchObject({
            code: "CANCELLED",
            exitCode: 130,
        });
        expect(input.setRawMode).toHaveBeenCalledWith(true);
    });

    it("does not accept an already aborted --yes operation", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            confirmEula(document, { yes: true, signal: controller.signal }),
        ).rejects.toMatchObject({ code: "CANCELLED" });
        expect(output.text).toBe("");
    });
});
