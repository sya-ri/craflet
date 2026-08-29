import { stripVTControlCharacters } from "node:util";
import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
    type ConsoleLogEvent,
    type InteractiveConsoleOptions,
    openInteractiveConsole,
} from "./console.js";

const PAGE_UP = "\u001b[5~";
const HOME = "\u001b[H";
const END = "\u001b[F";
const LEFT = "\u001b[D";
const CTRL_C = "\u0003";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const MOUSE_WHEEL_UP = "\u001b[<64;1;1M";
const ESCAPE = String.fromCharCode(27);

class FakeTerminal implements Terminal {
    readonly columns: number;
    readonly rows: number;
    readonly kittyProtocolActive = false;
    readonly writes: string[] = [];
    readonly lifecycle: string[] = [];
    readonly drainCalls: Array<[number | undefined, number | undefined]> = [];
    startCount = 0;
    stopCount = 0;

    private inputHandler: ((data: string) => void) | undefined;
    private readonly screenRows: string[];

    constructor(columns = 80, rows = 10) {
        this.columns = columns;
        this.rows = rows;
        this.screenRows = Array.from({ length: rows }, () => "");
    }

    start(onInput: (data: string) => void, _onResize: () => void): void {
        this.startCount += 1;
        this.lifecycle.push("start");
        this.inputHandler = onInput;
    }

    stop(): void {
        this.stopCount += 1;
        this.lifecycle.push("stop");
        this.inputHandler = undefined;
    }

    async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
        this.drainCalls.push([maxMs, idleMs]);
        this.lifecycle.push("drain");
    }

    write(data: string): void {
        this.writes.push(data);
        this.applyScreenWrite(data);
    }

    send(data: string): void {
        if (!this.inputHandler)
            throw new Error("Terminal is not accepting input.");
        this.inputHandler(data);
    }

    get screenText(): string {
        return this.screenRows.join("\n");
    }

    get logRows(): string[] {
        return this.screenRows.slice(0, -2).map((line) => line.trimEnd());
    }

    moveBy(): void {}
    hideCursor(): void {}
    showCursor(): void {}
    clearLine(): void {}
    clearFromCursor(): void {}
    clearScreen(): void {}
    setTitle(): void {}
    setProgress(): void {}

    private applyScreenWrite(data: string): void {
        if (data.includes("\u001b[2J")) this.screenRows.fill("");

        const rowPattern = new RegExp(
            `${ESCAPE}\\[(\\d+);(\\d+)H${ESCAPE}\\[2K`,
            "g",
        );
        const rowWrites = [...data.matchAll(rowPattern)];
        for (let index = 0; index < rowWrites.length; index += 1) {
            const match = rowWrites[index];
            if (!match) continue;
            const row = Number(match[1]) - 1;
            if (row < 0 || row >= this.rows) continue;
            const start = (match.index ?? 0) + match[0].length;
            const end = rowWrites[index + 1]?.index ?? data.length;
            this.screenRows[row] = stripVTControlCharacters(
                data.slice(start, end),
            );
        }
    }
}

class ControlledLogFeed {
    readonly signals: AbortSignal[] = [];
    private readonly queued: ConsoleLogEvent[] = [];
    private waiter:
        | {
              resolve: (event: ConsoleLogEvent | undefined) => void;
              abort: () => void;
          }
        | undefined;

    push(event: ConsoleLogEvent): void {
        const waiter = this.waiter;
        if (!waiter) {
            this.queued.push(event);
            return;
        }
        this.waiter = undefined;
        waiter.resolve(event);
    }

    stream(signal: AbortSignal): AsyncIterable<ConsoleLogEvent> {
        this.signals.push(signal);
        const feed = this;
        return {
            async *[Symbol.asyncIterator]() {
                while (!signal.aborted) {
                    const event = await feed.take(signal);
                    if (!event) return;
                    yield event;
                }
            },
        };
    }

    private take(signal: AbortSignal): Promise<ConsoleLogEvent | undefined> {
        const queued = this.queued.shift();
        if (queued) return Promise.resolve(queued);
        if (signal.aborted) return Promise.resolve(undefined);

        return new Promise((resolve) => {
            const finish = (event: ConsoleLogEvent | undefined) => {
                signal.removeEventListener("abort", abort);
                resolve(event);
            };
            const abort = () => {
                if (this.waiter?.abort === abort) this.waiter = undefined;
                finish(undefined);
            };
            this.waiter = { resolve: finish, abort };
            signal.addEventListener("abort", abort, { once: true });
        });
    }
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
} {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value) {
            resolvePromise?.(value);
        },
    };
}

function createOptions(
    terminal: FakeTerminal,
    feed: ControlledLogFeed,
    overrides: Partial<InteractiveConsoleOptions<string, string>> = {},
): InteractiveConsoleOptions<string, string> {
    return {
        loadRecent: vi.fn(async () => ({
            text: Array.from(
                { length: 14 },
                (_, index) => `recent-${String(index + 1).padStart(2, "0")}`,
            ).join("\n"),
            older: "older-cursor",
            follow: "follow-checkpoint",
        })),
        loadOlder: vi.fn(async () => ({
            kind: "page" as const,
            text: "",
            older: null,
        })),
        follow: (_checkpoint, signal) => feed.stream(signal),
        sendCommand: vi.fn(async () => undefined),
        terminal,
        ...overrides,
    };
}

describe("interactive console", () => {
    it("shows recent logs, lazily loads older logs without moving the anchor, and returns to live output", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const older = deferred<{
            kind: "page";
            text: string;
            older: string | null;
        }>();
        const loadOlder = vi.fn(() => older.promise);
        const options = createOptions(terminal, feed, { loadOlder });
        const session = openInteractiveConsole(options);

        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("recent-14");
            expect(terminal.screenText).toContain("Live | PageUp");
        });

        terminal.send(PAGE_UP);
        terminal.send(PAGE_UP);
        await vi.waitFor(() => {
            expect(loadOlder).toHaveBeenCalledExactlyOnceWith("older-cursor");
            expect(terminal.logRows).toContain("recent-01");
        });
        const anchoredRows = terminal.logRows;

        older.resolve({
            kind: "page",
            text: "older-01\nolder-02\nolder-03\nolder-04\n",
            older: null,
        });
        await vi.waitFor(() => {
            expect(terminal.logRows).toEqual(anchoredRows);
            expect(terminal.screenText).toContain("Beginning of log history.");
        });

        terminal.send(PAGE_UP);
        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("older-01");
        });

        feed.push({ kind: "append", text: "live-event\n", lineCount: 1 });
        await vi.waitFor(() => {
            expect(terminal.screenText).toContain(
                "1 new line; End returns to live",
            );
        });
        expect(terminal.logRows.join("\n")).not.toContain("live-event");

        terminal.send(END);
        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("live-event");
            expect(terminal.screenText).toContain("Live | PageUp");
        });

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
        expect(terminal.startCount).toBe(1);
        expect(terminal.stopCount).toBe(1);
        expect(terminal.drainCalls).toEqual([[100, 20]]);
        expect(terminal.lifecycle).toEqual(["start", "drain", "stop"]);
        expect(terminal.writes.join("")).toContain("\u001b[?1049h");
        expect(terminal.writes.at(-1)).toContain("\u001b[?1049l");
        expect(terminal.writes.at(-1)).not.toContain("recent-14");
        expect(() => terminal.send("after-close")).toThrow(
            "Terminal is not accepting input.",
        );
        expect(feed.signals).toHaveLength(1);
        expect(feed.signals[0]?.aborted).toBe(true);
    });

    it("sends a submitted command exactly once", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const sendCommand = vi.fn(async () => undefined);
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { sendCommand }),
        );

        await vi.waitFor(() => expect(terminal.startCount).toBe(1));
        for (const character of "say hello") terminal.send(character);
        terminal.send("\r");
        await vi.waitFor(() => {
            expect(sendCommand).toHaveBeenCalledExactlyOnceWith("say hello");
        });

        terminal.send("\r");
        await Promise.resolve();
        expect(sendCommand).toHaveBeenCalledTimes(1);

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("clears whitespace-only input before accepting the next command", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const sendCommand = vi.fn(async () => undefined);
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { sendCommand }),
        );

        await vi.waitFor(() => expect(terminal.startCount).toBe(1));
        for (const character of "   ") terminal.send(character);
        terminal.send("\r");
        await Promise.resolve();
        expect(sendCommand).not.toHaveBeenCalled();

        for (const character of "list") terminal.send(character);
        terminal.send("\r");
        await vi.waitFor(() => {
            expect(sendCommand).toHaveBeenCalledExactlyOnceWith("list");
        });

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("sanitizes fragmented paste before insertion and same-chunk submission", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const sendCommand = vi.fn(async () => undefined);
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { sendCommand }),
        );

        await vi.waitFor(() => expect(terminal.startCount).toBe(1));
        for (const character of "say ac") terminal.send(character);
        terminal.send(LEFT);
        terminal.send(PASTE_START);
        terminal.send("b\u001b]52;c;");
        terminal.send("payload\u0007");
        terminal.send(PASTE_END);
        terminal.send("x");
        terminal.send("\u202e");
        terminal.send(PASTE_START);
        terminal.send("y");
        terminal.send(`${PASTE_END}\r`);

        await vi.waitFor(() => {
            expect(sendCommand).toHaveBeenCalledExactlyOnceWith(
                "say ab?]52;c;payload?x?yc",
            );
        });
        expect(terminal.writes.join("")).not.toContain("\u001b]52;c;payload");

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("finishes an accepted command before detaching", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const command = deferred<void>();
        const sendCommand = vi.fn(() => command.promise);
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { sendCommand }),
        );

        await vi.waitFor(() => expect(terminal.startCount).toBe(1));
        for (const character of "save-all") terminal.send(character);
        terminal.send("\r");
        terminal.send(CTRL_C);

        await vi.waitFor(() => {
            expect(sendCommand).toHaveBeenCalledExactlyOnceWith("save-all");
        });
        let settled = false;
        void session.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(terminal.stopCount).toBe(0);

        command.resolve(undefined);
        await expect(session).resolves.toBeUndefined();
        expect(sendCommand).toHaveBeenCalledTimes(1);
        expect(terminal.lifecycle).toEqual(["start", "drain", "stop"]);
    });

    it("reports an accepted command failure after restoring the terminal", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const command = Promise.withResolvers<void>();
        const sendCommand = vi.fn(() => command.promise);
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { sendCommand }),
        );

        await vi.waitFor(() => expect(terminal.startCount).toBe(1));
        for (const character of "save-all") terminal.send(character);
        terminal.send("\r");
        terminal.send(CTRL_C);
        await vi.waitFor(() => {
            expect(sendCommand).toHaveBeenCalledExactlyOnceWith("save-all");
        });

        const failure = new Error("Runner rejected the command.");
        command.reject(failure);
        await expect(session).rejects.toBe(failure);
        expect(terminal.lifecycle).toEqual(["start", "drain", "stop"]);
    });

    it.each([
        ["PageUp", PAGE_UP],
        ["Home", HOME],
        ["the mouse wheel", MOUSE_WHEEL_UP],
    ])("loads older logs with %s when recent output fits", async (_, key) => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const loadOlder = vi.fn(async () => ({
            kind: "page" as const,
            text: "older-only\n",
            older: null,
        }));
        const options = createOptions(terminal, feed, { loadOlder });
        vi.mocked(options.loadRecent).mockResolvedValue({
            text: "recent-only\n",
            older: "older-cursor",
            follow: "follow-checkpoint",
        });
        const session = openInteractiveConsole(options);

        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("recent-only");
            expect(terminal.screenText).toContain("Live | PageUp");
        });
        terminal.send(key);
        await vi.waitFor(() => {
            expect(loadOlder).toHaveBeenCalledExactlyOnceWith("older-cursor");
            expect(terminal.screenText).toContain("older-only");
        });

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("keeps following live output when an older page resolves after End", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const older = deferred<{
            kind: "page";
            text: string;
            older: string | null;
        }>();
        const loadOlder = vi.fn(() => older.promise);
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { loadOlder }),
        );

        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("recent-14");
        });
        terminal.send(PAGE_UP);
        terminal.send(PAGE_UP);
        await vi.waitFor(() => {
            expect(loadOlder).toHaveBeenCalledExactlyOnceWith("older-cursor");
        });

        terminal.send(END);
        older.resolve({
            kind: "page",
            text: "older-01\nolder-02\n",
            older: null,
        });
        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("Live | PageUp");
            expect(terminal.screenText).not.toContain(
                "Beginning of log history.",
            );
        });

        feed.push({ kind: "append", text: "still-live\n", lineCount: 1 });
        await vi.waitFor(() => {
            expect(terminal.logRows.join("\n")).toContain("still-live");
            expect(terminal.screenText).toContain("Live | PageUp");
        });
        expect(terminal.screenText).not.toContain(
            "new line; End returns to live",
        );

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("compacts live output from a fresh snapshot and resumes at its checkpoint", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const compacted = deferred<{
            text: string;
            older: string | null;
            follow: string;
        }>();
        let loads = 0;
        const loadRecent = vi.fn(async () => {
            loads++;
            if (loads === 1)
                return {
                    text: "initial\n",
                    older: "older-1",
                    follow: "checkpoint-1",
                };
            return compacted.promise;
        });
        const follow = vi.fn((_: string, signal: AbortSignal) =>
            feed.stream(signal),
        );
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { loadRecent, follow }),
        );

        await vi.waitFor(() => expect(feed.signals).toHaveLength(1));
        feed.push({ kind: "append", text: "threshold\n", lineCount: 2000 });
        await vi.waitFor(() => {
            expect(loadRecent).toHaveBeenCalledTimes(2);
        });
        expect(feed.signals[0]?.aborted).toBe(false);

        compacted.resolve({
            text: "initial\nthreshold\nbetween\n",
            older: "older-2",
            follow: "checkpoint-2",
        });
        await vi.waitFor(() => expect(feed.signals).toHaveLength(2));
        feed.push({ kind: "append", text: "after\n", lineCount: 1 });
        await vi.waitFor(() => {
            expect(terminal.logRows.filter(Boolean)).toEqual([
                "initial",
                "threshold",
                "between",
                "after",
            ]);
        });
        expect(follow.mock.calls.map(([checkpoint]) => checkpoint)).toEqual([
            "checkpoint-1",
            "checkpoint-2",
        ]);

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("keeps the current iterator and viewport when history opens during compaction", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const acquiring = deferred<{
            text: string;
            older: string | null;
            follow: string;
        }>();
        let loads = 0;
        const loadRecent = vi.fn(async () => {
            loads++;
            if (loads === 1)
                return {
                    text: Array.from(
                        { length: 14 },
                        (_, index) => `recent-${index + 1}`,
                    ).join("\n"),
                    older: "older-1",
                    follow: "checkpoint-1",
                };
            return acquiring.promise;
        });
        const follow = vi.fn((_: string, signal: AbortSignal) =>
            feed.stream(signal),
        );
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { loadRecent, follow }),
        );

        await vi.waitFor(() => expect(feed.signals).toHaveLength(1));
        feed.push({ kind: "append", text: "threshold\n", lineCount: 2000 });
        await vi.waitFor(() => expect(loadRecent).toHaveBeenCalledTimes(2));

        terminal.send(PAGE_UP);
        terminal.send(PAGE_UP);
        await vi.waitFor(() => {
            expect(terminal.logRows).toContain("recent-1");
            expect(terminal.logRows).not.toContain("threshold");
        });
        acquiring.resolve({
            text: "fresh-snapshot\n",
            older: "older-2",
            follow: "checkpoint-2",
        });
        feed.push({ kind: "append", text: "continued\n", lineCount: 1 });
        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("1 new line");
        });

        expect(terminal.screenText).not.toContain("fresh-snapshot");
        expect(loadRecent).toHaveBeenCalledTimes(2);
        expect(feed.signals).toHaveLength(1);
        expect(feed.signals[0]?.aborted).toBe(false);
        expect(follow.mock.calls.map(([checkpoint]) => checkpoint)).toEqual([
            "checkpoint-1",
        ]);

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("defers live compaction while reading history and refreshes after End", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        let loads = 0;
        const loadRecent = vi.fn(async () => {
            loads++;
            if (loads === 1)
                return {
                    text: Array.from(
                        { length: 14 },
                        (_, index) => `recent-${index + 1}`,
                    ).join("\n"),
                    older: "older-1",
                    follow: "checkpoint-1",
                };
            return {
                text: "snapshot-threshold\nsnapshot-between\nsnapshot-trigger\n",
                older: "older-2",
                follow: "checkpoint-2",
            };
        });
        const follow = vi.fn((_: string, signal: AbortSignal) =>
            feed.stream(signal),
        );
        const session = openInteractiveConsole(
            createOptions(terminal, feed, { loadRecent, follow }),
        );

        await vi.waitFor(() => expect(feed.signals).toHaveLength(1));
        terminal.send(PAGE_UP);
        terminal.send(PAGE_UP);
        await vi.waitFor(() => {
            expect(terminal.logRows).toContain("recent-1");
            expect(terminal.logRows).not.toContain("recent-14");
        });

        feed.push({ kind: "append", text: "threshold\n", lineCount: 2000 });
        feed.push({ kind: "append", text: "between\n", lineCount: 1 });
        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("2001 new lines");
        });
        expect(feed.signals[0]?.aborted).toBe(false);
        expect(loadRecent).toHaveBeenCalledTimes(1);

        terminal.send(END);
        expect(loadRecent).toHaveBeenCalledTimes(1);
        feed.push({ kind: "append", text: "trigger\n", lineCount: 1 });
        await vi.waitFor(() => {
            expect(feed.signals).toHaveLength(2);
        });
        expect(feed.signals[0]?.aborted).toBe(false);
        feed.push({ kind: "append", text: "after\n", lineCount: 1 });
        await vi.waitFor(() => {
            expect(terminal.logRows.filter(Boolean)).toEqual([
                "snapshot-threshold",
                "snapshot-between",
                "snapshot-trigger",
                "after",
            ]);
        });
        expect(follow.mock.calls.map(([checkpoint]) => checkpoint)).toEqual([
            "checkpoint-1",
            "checkpoint-2",
        ]);

        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("skips bounded empty pages while traversing one oversized log line", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const loadOlder = vi.fn(async (cursor: string) => {
            const remaining = Number(cursor);
            return remaining > 0
                ? {
                      kind: "page" as const,
                      text: "",
                      older: String(remaining - 1),
                  }
                : {
                      kind: "page" as const,
                      text: "before-oversized\n",
                      older: null,
                  };
        });
        const options = createOptions(terminal, feed, { loadOlder });
        vi.mocked(options.loadRecent).mockResolvedValue({
            text: Array.from(
                { length: 14 },
                (_, index) => `recent-${String(index + 1).padStart(2, "0")}`,
            ).join("\n"),
            older: "4",
            follow: "follow-checkpoint",
        });
        const session = openInteractiveConsole(options);

        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("recent-14");
        });
        terminal.send(PAGE_UP);
        terminal.send(PAGE_UP);
        await vi.waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(5);
        });

        terminal.send(PAGE_UP);
        await vi.waitFor(() => {
            expect(terminal.screenText).toContain("before-oversized");
        });
        terminal.send(CTRL_C);
        await expect(session).resolves.toBeUndefined();
    });

    it("waits for follower cleanup before restoring the terminal", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const cleanup = deferred<void>();
        const following = deferred<void>();
        const options = createOptions(terminal, feed, {
            follow: (_checkpoint, signal) => ({
                async *[Symbol.asyncIterator]() {
                    try {
                        following.resolve(undefined);
                        await new Promise<void>((resolve) => {
                            signal.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                        });
                    } finally {
                        await cleanup.promise;
                    }
                },
            }),
        });
        const session = openInteractiveConsole(options);

        await following.promise;
        terminal.send(CTRL_C);
        await Promise.resolve();
        expect(terminal.stopCount).toBe(0);

        cleanup.resolve(undefined);
        await expect(session).resolves.toBeUndefined();
        expect(terminal.lifecycle).toEqual(["start", "drain", "stop"]);
    });

    it("aborts the follower and restores the terminal", async () => {
        const terminal = new FakeTerminal();
        const feed = new ControlledLogFeed();
        const controller = new AbortController();
        const sendCommand = vi.fn(async () => undefined);
        const session = openInteractiveConsole(
            createOptions(terminal, feed, {
                signal: controller.signal,
                sendCommand,
            }),
        );

        await vi.waitFor(() => {
            expect(terminal.startCount).toBe(1);
            expect(feed.signals).toHaveLength(1);
        });
        controller.abort();

        await expect(session).resolves.toBeUndefined();
        expect(feed.signals[0]?.aborted).toBe(true);
        expect(sendCommand).not.toHaveBeenCalled();
        expect(terminal.stopCount).toBe(1);
        expect(terminal.writes.at(-1)).toContain("\u001b[?1049l");
        expect(() => terminal.send("after-abort")).toThrow(
            "Terminal is not accepting input.",
        );
    });
});
