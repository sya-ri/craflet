import {
    type Component,
    type Focusable,
    Input,
    Key,
    matchesKey,
    ScrollView,
    type ScrollViewScrollToOptions,
    type Terminal,
    TuiAltScreen,
    truncateToWidth,
    VStack,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { ConsoleTerminal } from "./console-terminal.js";
import {
    sanitizeInlineTerminalOutput,
    sanitizeTerminalOutput,
} from "./terminal.js";

const EMPTY_HISTORY_PAGE_LIMIT = 8;
const LIVE_COMPACT_LINES = 2000;
const LIVE_COMPACT_BYTES = 4 * 1024 * 1024;

export interface ConsoleLogSnapshot<Cursor, Checkpoint> {
    text: string;
    older: Cursor | null;
    follow: Checkpoint;
}

export type ConsoleOlderPage<Cursor> =
    | { kind: "page"; text: string; older: Cursor | null }
    | { kind: "stale" };

export type ConsoleLogEvent =
    | { kind: "append"; text: string; lineCount?: number }
    | { kind: "reset" };

export interface InteractiveConsoleOptions<Cursor, Checkpoint> {
    loadRecent(): Promise<ConsoleLogSnapshot<Cursor, Checkpoint>>;
    loadOlder(cursor: Cursor): Promise<ConsoleOlderPage<Cursor>>;
    follow(
        checkpoint: Checkpoint,
        signal: AbortSignal,
    ): AsyncIterable<ConsoleLogEvent>;
    sendCommand(command: string): Promise<void>;
    signal?: AbortSignal;
    terminal?: Terminal;
}

function normalizeLogText(value: string): string {
    return sanitizeTerminalOutput(
        value.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n"),
    ).replaceAll("\t", "    ");
}

class MutableLine implements Component {
    private value: string;

    constructor(value: string) {
        this.value = value;
    }

    set(value: string): void {
        this.value = value;
    }

    invalidate(): void {}

    render(width: number): string[] {
        return [truncateToWidth(this.value, Math.max(1, width), "")];
    }
}

class Transcript implements Component {
    private lines: string[];
    private wrapped: string[][] | undefined;
    private rows: string[] | undefined;
    private width: number | undefined;

    constructor(value: string) {
        this.lines = normalizeLogText(value).split("\n");
    }

    append(value: string): void {
        const added = normalizeLogText(value).split("\n");
        const last = this.lines.length - 1;
        this.lines[last] = (this.lines[last] ?? "") + (added.shift() ?? "");
        this.lines.push(...added);
        if (!this.wrapped || !this.rows || this.width === undefined) return;

        const width = this.width;
        const previousLast = this.wrapped[last] ?? [];
        const replacement = this.wrap(this.lines[last] ?? "", width);
        const appended = added.map((line) => this.wrap(line, width));
        this.wrapped[last] = replacement;
        for (const line of appended) this.wrapped.push(line);
        this.rows.length -= previousLast.length;
        for (const row of replacement) this.rows.push(row);
        for (const line of appended)
            for (const row of line) this.rows.push(row);
    }

    prepend(value: string, width: number): number {
        const added = normalizeLogText(value).split("\n");
        const previousFirst = this.lines[0] ?? "";
        added[added.length - 1] =
            (added[added.length - 1] ?? "") + previousFirst;
        this.lines = [...added, ...this.lines.slice(1)];
        const previousRows = this.wrap(previousFirst, width).length;
        const replacement = added.map((line) => this.wrap(line, width));
        if (this.wrapped && this.rows && this.width === width) {
            this.wrapped = [...replacement, ...this.wrapped.slice(1)];
            this.rows = [
                ...this.flatten(replacement),
                ...this.rows.slice(previousRows),
            ];
        } else {
            this.clearCache();
        }
        return (
            replacement.reduce((total, lines) => total + lines.length, 0) -
            previousRows
        );
    }

    replace(value: string): void {
        this.lines = normalizeLogText(value).split("\n");
        this.clearCache();
    }

    invalidate(): void {
        this.clearCache();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        if (!this.wrapped || !this.rows || this.width !== safeWidth) {
            this.width = safeWidth;
            this.wrapped = this.lines.map((line) => this.wrap(line, safeWidth));
            this.rows = this.flatten(this.wrapped);
        }
        return this.rows;
    }

    private wrap(value: string, width: number): string[] {
        return wrapTextWithAnsi(value, Math.max(1, width));
    }

    private flatten(lines: string[][]): string[] {
        const rows: string[] = [];
        for (const line of lines) for (const row of line) rows.push(row);
        return rows;
    }

    private clearCache(): void {
        this.wrapped = undefined;
        this.rows = undefined;
        this.width = undefined;
    }
}

class CommandInput implements Component, Focusable {
    private readonly input = new Input();

    constructor(onSubmit: (value: string) => void) {
        this.input.onSubmit = (value) =>
            onSubmit(sanitizeTerminalOutput(value));
    }

    get focused(): boolean {
        return this.input.focused;
    }

    set focused(value: boolean) {
        this.input.focused = value;
    }

    get value(): string {
        return this.input.getValue();
    }

    clear(): void {
        this.input.setValue("");
    }

    handleInput(data: string): void {
        this.input.handleInput(data);
        const value = this.input.getValue();
        const sanitized = sanitizeTerminalOutput(value);
        if (sanitized !== value) this.input.setValue(sanitized);
    }

    invalidate(): void {
        this.input.invalidate();
    }

    render(width: number): string[] {
        return this.input.render(Math.max(1, width));
    }
}

type ScrollIntent = "older" | "newer" | "start" | "end";

class LazyScrollView extends ScrollView {
    onScroll?: (intent: ScrollIntent) => void;
    private intentEpoch = 0;
    private pendingAnchor:
        | { position: number; addedRows: number; intentEpoch: number }
        | undefined;

    preserveAnchor(position: number, addedRows: number): void {
        this.pendingAnchor = {
            position,
            addedRows,
            intentEpoch: this.intentEpoch,
        };
    }

    override scrollBy(lines: number): number {
        if (lines !== 0) this.intentEpoch++;
        const remaining = super.scrollBy(lines);
        if (lines !== 0) this.onScroll?.(lines < 0 ? "older" : "newer");
        return remaining;
    }

    override scrollTo(
        position: number,
        options?: ScrollViewScrollToOptions,
    ): void {
        this.intentEpoch++;
        const previous = this.scrollTop;
        super.scrollTo(position, options);
        this.onScroll?.(this.scrollTop < previous ? "older" : "newer");
    }

    override scrollToStart(): void {
        this.intentEpoch++;
        super.scrollToStart();
        this.onScroll?.("start");
    }

    override scrollToEnd(): void {
        this.intentEpoch++;
        super.scrollToEnd();
        this.onScroll?.("end");
    }

    override updateLayout(
        contentHeight: number,
        viewportHeight: number,
        requestRender: () => void,
    ): void {
        super.updateLayout(contentHeight, viewportHeight, requestRender);
        const anchor = this.pendingAnchor;
        if (!anchor) return;
        this.pendingAnchor = undefined;
        if (this.isFollowingEnd) return;
        const position =
            anchor.intentEpoch === this.intentEpoch
                ? anchor.position
                : this.scrollTop;
        super.scrollTo(position + anchor.addedRows, {
            disableFollow: true,
        });
    }
}

function errorMessage(error: unknown): string {
    return sanitizeInlineTerminalOutput(
        error instanceof Error ? error.message : "Unknown console error.",
    );
}

function appendedLines(
    event: Extract<ConsoleLogEvent, { kind: "append" }>,
): number {
    if (event.lineCount !== undefined) return event.lineCount;
    const value = normalizeLogText(event.text);
    const breaks = value.match(/\n/g)?.length ?? 0;
    return value.length === 0 ? 0 : breaks + (value.endsWith("\n") ? 0 : 1);
}

class InteractiveConsole<Cursor, Checkpoint> {
    private readonly terminal: Terminal;
    private readonly tui: TuiAltScreen;
    private readonly transcript: Transcript;
    private readonly status = new MutableLine("");
    private readonly input: CommandInput;
    private readonly scroll: LazyScrollView;
    private readonly abort = new AbortController();
    private older: Cursor | null;
    private checkpoint: Checkpoint;
    private unread = 0;
    private loadingOlder = false;
    private historyVersion = 0;
    private closed = false;
    private commandQueue: Promise<void> = Promise.resolve();
    private detachedCommandFailure: { error: unknown } | undefined;
    private compactPending = false;
    private liveLines = 0;
    private liveBytes = 0;

    constructor(
        private readonly options: InteractiveConsoleOptions<Cursor, Checkpoint>,
        snapshot: ConsoleLogSnapshot<Cursor, Checkpoint>,
    ) {
        this.terminal = options.terminal ?? new ConsoleTerminal();
        this.transcript = new Transcript(snapshot.text);
        this.older = snapshot.older;
        this.checkpoint = snapshot.follow;
        this.scroll = new LazyScrollView(this.transcript, {
            follow: "end",
            primary: true,
            overscroll: "contain",
            scrollbar: "auto",
        });
        this.input = new CommandInput((value) => {
            void this.queueCommand(value);
        });
        this.tui = new TuiAltScreen(this.terminal, true, undefined, {
            mouse: true,
            wheelScrollLines: 3,
        });
        this.tui.setLayoutRoot(
            new VStack([
                {
                    component: this.scroll,
                    basis: 0,
                    grow: 1,
                    minSize: 1,
                },
                {
                    component: this.status,
                    basis: 1,
                    shrink: 0,
                    minSize: 1,
                },
                {
                    component: this.input,
                    basis: 1,
                    shrink: 0,
                    minSize: 1,
                },
            ]),
        );
        this.tui.setFocus(this.input);
        this.scroll.onScroll = (intent) => this.handleScroll(intent);
        this.updateStatus();
    }

    async run(): Promise<void> {
        const done = Promise.withResolvers<void>();
        const close = () => {
            if (this.closed) return;
            this.closed = true;
            this.abort.abort();
            done.resolve();
        };
        const fail = (error: unknown) => {
            if (this.closed) return;
            this.closed = true;
            this.abort.abort();
            done.reject(error);
        };
        const removeInputListener = this.tui.addInputListener((data) => {
            if (
                matchesKey(data, Key.ctrl("c")) ||
                (matchesKey(data, Key.ctrl("d")) &&
                    this.input.value.length === 0)
            ) {
                close();
                return { consume: true };
            }
            return undefined;
        });
        const onAbort = () => close();
        this.options.signal?.addEventListener("abort", onAbort, { once: true });
        const useProcessInput = this.options.terminal === undefined;
        if (useProcessInput) {
            process.stdin.once("end", close);
            process.stdin.once("close", close);
            process.stdin.once("error", fail);
        }
        let startAttempted = false;
        let follower: Promise<void> | undefined;
        try {
            if (this.options.signal?.aborted) return;
            startAttempted = true;
            this.tui.start();
            follower = this.followLogs();
            void follower.then(close, fail);
            await done.promise;
        } finally {
            this.closed = true;
            this.abort.abort();
            removeInputListener();
            this.options.signal?.removeEventListener("abort", onAbort);
            if (useProcessInput) {
                process.stdin.removeListener("end", close);
                process.stdin.removeListener("close", close);
                process.stdin.removeListener("error", fail);
            }
            await Promise.allSettled([
                this.commandQueue,
                follower ?? Promise.resolve(),
            ]);
            if (startAttempted) {
                try {
                    await this.terminal.drainInput(100, 20);
                } finally {
                    this.tui.stop({ preserveScreen: true });
                }
            }
        }
        if (this.detachedCommandFailure)
            throw this.detachedCommandFailure.error;
    }

    private handleScroll(intent: ScrollIntent): void {
        if (this.closed) return;
        if (
            (intent === "older" || intent === "start") &&
            this.scroll.scrollTop <= 2 &&
            this.older !== null
        ) {
            void this.loadOlder();
            return;
        }
        if (intent === "end" || this.scroll.isFollowingEnd) {
            this.unread = 0;
            this.updateStatus();
            return;
        }
        this.updateStatus();
    }

    private async loadOlder(): Promise<void> {
        if (this.loadingOlder || this.older === null || this.closed) return;
        this.loadingOlder = true;
        const cursor = this.older;
        const historyVersion = this.historyVersion;
        this.updateStatus("Loading older logs...");
        try {
            let next = cursor;
            for (
                let attempt = 0;
                attempt < EMPTY_HISTORY_PAGE_LIMIT;
                attempt++
            ) {
                const page = await this.options.loadOlder(next);
                if (this.closed || historyVersion !== this.historyVersion)
                    return;
                if (page.kind === "stale") {
                    this.older = null;
                    this.updateStatus(
                        "Log history changed; current live output is intact.",
                    );
                    return;
                }
                this.older = page.older;
                if (page.text.length > 0) {
                    const width = Math.max(1, this.terminal.columns);
                    const following = this.scroll.isFollowingEnd;
                    const anchor = this.scroll.scrollTop;
                    const addedRows = this.transcript.prepend(page.text, width);
                    if (!following)
                        this.scroll.preserveAnchor(anchor, addedRows);
                    this.tui.requestRender();
                    break;
                }
                if (page.older === null) break;
                next = page.older;
            }
            this.updateStatus(
                this.older === null && !this.scroll.isFollowingEnd
                    ? "Beginning of log history."
                    : undefined,
            );
        } catch (error) {
            if (!this.closed)
                this.updateStatus(
                    `Could not load older logs: ${errorMessage(error)}`,
                );
        } finally {
            this.loadingOlder = false;
        }
    }

    private async followLogs(): Promise<void> {
        while (!this.abort.signal.aborted) {
            let reset = false;
            let compacted = false;
            for await (const event of this.options.follow(
                this.checkpoint,
                this.abort.signal,
            )) {
                if (this.closed) return;
                if (event.kind === "reset") {
                    reset = true;
                    break;
                }
                if (event.text.length === 0) continue;
                const following = this.scroll.isFollowingEnd;
                this.transcript.append(event.text);
                if (!following) this.unread += appendedLines(event);
                const shouldCompact = this.recordLiveAppend(event);
                this.updateStatus();
                if (!shouldCompact) continue;

                const snapshot = await this.options.loadRecent();
                if (this.closed) return;
                if (!this.scroll.isFollowingEnd) continue;
                this.applyRecent(snapshot);
                compacted = true;
                break;
            }
            if (this.abort.signal.aborted) return;
            if (reset) {
                const snapshot = await this.options.loadRecent();
                if (this.closed) return;
                this.applyRecent(
                    snapshot,
                    "Log file changed; reloaded recent output.",
                );
                continue;
            }
            if (compacted) continue;
            return;
        }
    }

    private recordLiveAppend(
        event: Extract<ConsoleLogEvent, { kind: "append" }>,
    ): boolean {
        if (!this.compactPending) {
            this.liveLines += appendedLines(event);
            this.liveBytes += Buffer.byteLength(event.text, "utf8");
            this.compactPending =
                this.liveLines >= LIVE_COMPACT_LINES ||
                this.liveBytes >= LIVE_COMPACT_BYTES;
        }
        return this.compactPending && this.scroll.isFollowingEnd;
    }

    private applyRecent(
        snapshot: ConsoleLogSnapshot<Cursor, Checkpoint>,
        message?: string,
    ): void {
        this.historyVersion++;
        this.scroll.scrollToEnd();
        this.transcript.replace(snapshot.text);
        this.older = snapshot.older;
        this.checkpoint = snapshot.follow;
        this.unread = 0;
        this.compactPending = false;
        this.liveLines = 0;
        this.liveBytes = 0;
        this.tui.requestRender();
        this.updateStatus(message);
    }

    private queueCommand(value: string): void {
        if (this.closed) return;
        this.input.clear();
        if (!value.trim()) return;
        this.commandQueue = this.commandQueue.then(async () => {
            if (!this.closed) this.updateStatus("Sending command...");
            try {
                await this.options.sendCommand(value);
                if (!this.closed) this.updateStatus("Command sent.");
            } catch (error) {
                if (this.closed) this.detachedCommandFailure ??= { error };
                else
                    this.updateStatus(`Command failed: ${errorMessage(error)}`);
            }
        });
    }

    private updateStatus(message?: string): void {
        const position = this.scroll.isFollowingEnd
            ? "Live"
            : `${this.unread} new ${this.unread === 1 ? "line" : "lines"}; End returns to live`;
        this.status.set(
            `${message ?? position} | PageUp or mouse wheel: history | Ctrl-C: detach`,
        );
        this.tui.requestRender();
    }
}

export async function openInteractiveConsole<Cursor, Checkpoint>(
    options: InteractiveConsoleOptions<Cursor, Checkpoint>,
): Promise<void> {
    const snapshot = await options.loadRecent();
    await new InteractiveConsole(options, snapshot).run();
}
