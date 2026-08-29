import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CrafletError } from "@craflet/core";
import { assertNoSymlinks } from "../filesystem/io.js";

const LOG_PATH = ".craflet/server.log";
const FOLLOW_BYTES = 64 * 1024;
const PAGE_BYTES = 1024 * 1024;
const LINE_BYTES = 256 * 1024;
const TAIL_BYTES = LINE_BYTES + 2;
const ANCHOR_BYTES = 4096;
const OMITTED = "[craflet] Oversized server log line omitted.";

export interface ServerLogCursor {
    generation: string;
    /** Exclusive upper bound for the next backward read. */
    before: number;
    /** SHA-256 of the bounded byte window immediately before `before`. */
    anchor: string;
    /** Continue walking backward through a line already represented by OMITTED. */
    skippingOversized: boolean;
}

export interface ServerLogCheckpoint {
    generation: string | null;
    /** The next byte to follow. */
    offset: number;
    /** SHA-256 of the bounded byte window immediately before `offset`. */
    anchor: string | null;
    /** Ignore bytes until LF because the snapshot already represented this line. */
    discarding: boolean;
}

export interface RecentServerLogs {
    /** Complete display lines, including their normalized LF terminators. */
    text: string;
    lineCount: number;
    older: ServerLogCursor | null;
    follow: ServerLogCheckpoint;
}

export type OlderServerLogs =
    | {
          kind: "page";
          text: string;
          lineCount: number;
          older: ServerLogCursor | null;
      }
    | { kind: "stale" };

export type ServerLogFollowEvent =
    | { kind: "append"; text: string; lineCount: number }
    | { kind: "reset" };

interface OpenedLog {
    file: string;
    handle: FileHandle;
    size: number;
    generation: string;
}

interface Page {
    text: string;
    lineCount: number;
    start: number;
    skippingOversized: boolean;
}

interface Tail {
    displayEnd: number;
    followOffset: number;
    oversized: boolean;
}

class LogChangedError extends Error {}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

export function serverLogGeneration(stats: {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
}): string {
    return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

function serverLogSize(size: bigint): number {
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new CrafletError(
            "LOG_FILE",
            "Managed server log is too large to read safely.",
            3,
        );
    return Number(size);
}

function validateLines(lines: number): void {
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000)
        throw new CrafletError(
            "LOG_LINES",
            "Log lines must be an integer from 1 to 10000.",
            2,
        );
}

function symlinkError(): CrafletError {
    return new CrafletError(
        "SYMLINK_UNSAFE",
        "Refusing managed server log through a symbolic link.",
        3,
    );
}

async function openVerifiedLog(
    projectDir: string,
): Promise<OpenedLog | undefined> {
    const file = path.join(projectDir, LOG_PATH);
    await assertNoSymlinks(projectDir, LOG_PATH);
    const noFollow =
        typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let handle: FileHandle;
    try {
        handle = await open(file, constants.O_RDONLY | noFollow);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        if (errorCode(error) === "ELOOP") throw symlinkError();
        throw error;
    }
    try {
        const stats = await handle.stat({ bigint: true });
        const named = await lstat(file, { bigint: true });
        if (named.isSymbolicLink()) throw symlinkError();
        if (!stats.isFile() || !named.isFile())
            throw new CrafletError(
                "LOG_FILE",
                "Managed server log is not a regular file.",
                3,
            );
        await assertNoSymlinks(projectDir, LOG_PATH);
        if (serverLogGeneration(named) !== serverLogGeneration(stats))
            throw new LogChangedError();
        return {
            file,
            handle,
            size: serverLogSize(stats.size),
            generation: serverLogGeneration(stats),
        };
    } catch (error) {
        await handle.close().catch(() => {});
        if (errorCode(error) === "ENOENT") throw new LogChangedError();
        if (errorCode(error) === "ELOOP") throw symlinkError();
        throw error;
    }
}

async function namedLogMatches(
    projectDir: string,
    opened: OpenedLog,
): Promise<boolean> {
    try {
        await assertNoSymlinks(projectDir, LOG_PATH);
        const stats = await lstat(opened.file, { bigint: true });
        if (stats.isSymbolicLink()) throw symlinkError();
        return (
            stats.isFile() && serverLogGeneration(stats) === opened.generation
        );
    } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        if (errorCode(error) === "ELOOP") throw symlinkError();
        throw error;
    }
}

async function snapshotMatches(
    projectDir: string,
    opened: OpenedLog,
): Promise<boolean> {
    const stats = await opened.handle.stat({ bigint: true });
    if (serverLogSize(stats.size) < opened.size) return false;
    return namedLogMatches(projectDir, opened);
}

async function readExact(
    handle: FileHandle,
    position: number,
    length: number,
): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await handle.read(
            buffer,
            offset,
            length - offset,
            position + offset,
        );
        if (bytesRead === 0) throw new LogChangedError();
        offset += bytesRead;
    }
    return buffer;
}

async function anchorAt(opened: OpenedLog, position: number): Promise<string> {
    if (!Number.isSafeInteger(position) || position < 0)
        throw new LogChangedError();
    const start = Math.max(0, position - ANCHOR_BYTES);
    const bytes = await readExact(opened.handle, start, position - start);
    return createHash("sha256").update(bytes).digest("hex");
}

async function anchorMatches(
    opened: OpenedLog,
    position: number,
    expected: string,
): Promise<boolean> {
    return (await anchorAt(opened, position)) === expected;
}

function renderLines(buffer: Buffer): { text: string; lineCount: number } {
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== 0x0a) continue;
        const end =
            index > start && buffer[index - 1] === 0x0d ? index - 1 : index;
        lines.push(
            end - start > LINE_BYTES
                ? OMITTED
                : buffer.subarray(start, end).toString("utf8"),
        );
        start = index + 1;
    }
    if (start !== buffer.length) throw new LogChangedError();
    return {
        text: lines.length ? `${lines.join("\n")}\n` : "",
        lineCount: lines.length,
    };
}

async function inspectTail(opened: OpenedLog): Promise<Tail> {
    const size = opened.size;
    if (size === 0) return { displayEnd: 0, followOffset: 0, oversized: false };
    if ((await readExact(opened.handle, size - 1, 1))[0] === 0x0a)
        return { displayEnd: size, followOffset: size, oversized: false };

    const start = Math.max(0, size - TAIL_BYTES);
    const tail = await readExact(opened.handle, start, size - start);
    const separator = tail.lastIndexOf(0x0a);
    if (separator < 0 && start > 0)
        return { displayEnd: start, followOffset: size, oversized: true };

    const displayEnd = separator < 0 ? 0 : start + separator + 1;
    const trailingCr = tail.at(-1) === 0x0d ? 1 : 0;
    const contentBytes = size - displayEnd - trailingCr;
    return contentBytes > LINE_BYTES
        ? { displayEnd, followOffset: size, oversized: true }
        : { displayEnd, followOffset: displayEnd, oversized: false };
}

async function readPage(
    opened: OpenedLog,
    before: number,
    lines: number,
    skippingOversized = false,
): Promise<Page> {
    if (!Number.isSafeInteger(before) || before < 0 || before > opened.size)
        throw new LogChangedError();
    if (before === 0)
        return {
            text: "",
            lineCount: 0,
            start: 0,
            skippingOversized: false,
        };

    const windowStart = Math.max(0, before - PAGE_BYTES);
    const buffer = await readExact(
        opened.handle,
        windowStart,
        before - windowStart,
    );
    let end = buffer.length;
    if (skippingOversized) {
        const boundary = buffer.lastIndexOf(0x0a);
        if (boundary < 0)
            return {
                text: "",
                lineCount: 0,
                start: windowStart,
                skippingOversized: windowStart > 0,
            };
        end = boundary + 1;
    }

    const complete = buffer.subarray(0, end);
    let start = 0;
    let selected = 0;
    let bounded = false;
    for (let index = complete.length - 1; index >= 0; index--) {
        if (complete[index] !== 0x0a) continue;
        if (selected === lines) {
            start = index + 1;
            bounded = true;
            break;
        }
        selected++;
    }
    if (bounded) {
        const rendered = renderLines(complete.subarray(start));
        return {
            ...rendered,
            start: windowStart + start,
            skippingOversized: false,
        };
    }
    if (windowStart === 0) {
        const rendered = renderLines(complete);
        return { ...rendered, start: 0, skippingOversized: false };
    }

    const firstBoundary = complete.indexOf(0x0a);
    if (firstBoundary >= 0 && firstBoundary + 1 < complete.length) {
        const rendered = renderLines(complete.subarray(firstBoundary + 1));
        const prefixBytes =
            firstBoundary > 0 && complete[firstBoundary - 1] === 0x0d
                ? firstBoundary - 1
                : firstBoundary;
        if (prefixBytes > LINE_BYTES)
            return {
                text: `${OMITTED}\n${rendered.text}`,
                lineCount: rendered.lineCount + 1,
                start: windowStart,
                skippingOversized: true,
            };
        return {
            ...rendered,
            start: windowStart + firstBoundary + 1,
            skippingOversized: false,
        };
    }
    if (skippingOversized && firstBoundary >= 0)
        return {
            text: "",
            lineCount: 0,
            start: windowStart + firstBoundary + 1,
            skippingOversized: false,
        };
    return {
        text: `${OMITTED}\n`,
        lineCount: 1,
        start: windowStart,
        skippingOversized: true,
    };
}

async function olderCursor(
    opened: OpenedLog,
    page: Pick<Page, "start" | "skippingOversized">,
): Promise<ServerLogCursor | null> {
    if (page.start === 0) return null;
    return {
        generation: opened.generation,
        before: page.start,
        anchor: await anchorAt(opened, page.start),
        skippingOversized: page.skippingOversized,
    };
}

async function readRecentOnce(
    projectDir: string,
    lines: number,
): Promise<RecentServerLogs> {
    const opened = await openVerifiedLog(projectDir);
    if (!opened)
        return {
            text: "",
            lineCount: 0,
            older: null,
            follow: {
                generation: null,
                offset: 0,
                anchor: null,
                discarding: false,
            },
        };
    try {
        const tail = await inspectTail(opened);
        const page = tail.oversized
            ? {
                  text: `${OMITTED}\n`,
                  lineCount: 1,
                  start: tail.displayEnd,
                  skippingOversized: true,
              }
            : await readPage(opened, tail.displayEnd, lines);
        const older = await olderCursor(opened, page);
        const followAnchor = await anchorAt(opened, tail.followOffset);
        if (
            !(await snapshotMatches(projectDir, opened)) ||
            !(await anchorMatches(opened, tail.followOffset, followAnchor)) ||
            (older &&
                !(await anchorMatches(opened, older.before, older.anchor)))
        )
            throw new LogChangedError();
        return {
            text: page.text,
            lineCount: page.lineCount,
            older,
            follow: {
                generation: opened.generation,
                offset: tail.followOffset,
                anchor: followAnchor,
                discarding: tail.oversized,
            },
        };
    } finally {
        await opened.handle.close();
    }
}

export async function readRecentServerLogs(
    projectDir: string,
    lines = 200,
): Promise<RecentServerLogs> {
    validateLines(lines);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await readRecentOnce(projectDir, lines);
        } catch (error) {
            if (!(error instanceof LogChangedError)) throw error;
            if (attempt === 1)
                throw new CrafletError(
                    "LOG_CHANGED",
                    "Server log changed while it was being read.",
                    3,
                );
        }
    }
    throw new CrafletError(
        "LOG_CHANGED",
        "Server log changed while it was being read.",
        3,
    );
}

export async function readOlderServerLogs(
    projectDir: string,
    cursor: ServerLogCursor,
    lines = 200,
): Promise<OlderServerLogs> {
    validateLines(lines);
    let opened: OpenedLog | undefined;
    try {
        opened = await openVerifiedLog(projectDir);
        if (
            !opened ||
            cursor.generation !== opened.generation ||
            !Number.isSafeInteger(cursor.before) ||
            cursor.before < 1 ||
            cursor.before > opened.size ||
            typeof cursor.anchor !== "string" ||
            !(await anchorMatches(opened, cursor.before, cursor.anchor))
        )
            return { kind: "stale" };
        const page = await readPage(
            opened,
            cursor.before,
            lines,
            cursor.skippingOversized,
        );
        const older = await olderCursor(opened, page);
        if (
            !(await snapshotMatches(projectDir, opened)) ||
            !(await anchorMatches(opened, cursor.before, cursor.anchor)) ||
            (older &&
                !(await anchorMatches(opened, older.before, older.anchor)))
        )
            throw new LogChangedError();
        return {
            kind: "page",
            text: page.text,
            lineCount: page.lineCount,
            older,
        };
    } catch (error) {
        if (error instanceof LogChangedError) return { kind: "stale" };
        throw error;
    } finally {
        await opened?.handle.close();
    }
}

function consumeForward(
    state: { pending: Buffer; discarding: boolean; omitted: boolean },
    chunk: Buffer,
): { text: string; lineCount: number } {
    const lines: string[] = [];
    let remaining = chunk;
    if (state.discarding) {
        const separator = remaining.indexOf(0x0a);
        if (separator < 0) return { text: "", lineCount: 0 };
        if (!state.omitted) lines.push(OMITTED);
        state.discarding = false;
        state.omitted = false;
        remaining = remaining.subarray(separator + 1);
    }

    const combined = state.pending.length
        ? Buffer.concat([state.pending, remaining])
        : remaining;
    state.pending = Buffer.alloc(0);
    let start = 0;
    for (let index = 0; index < combined.length; index++) {
        if (combined[index] !== 0x0a) continue;
        const end =
            index > start && combined[index - 1] === 0x0d ? index - 1 : index;
        lines.push(
            end - start > LINE_BYTES
                ? OMITTED
                : combined.subarray(start, end).toString("utf8"),
        );
        start = index + 1;
    }
    const tail = combined.subarray(start);
    if (tail.length > LINE_BYTES + 1) {
        state.discarding = true;
        state.omitted = false;
    } else state.pending = Buffer.from(tail);
    return {
        text: lines.length ? `${lines.join("\n")}\n` : "",
        lineCount: lines.length,
    };
}

async function poll(signal: AbortSignal): Promise<void> {
    try {
        await delay(150, undefined, { signal });
    } catch {
        if (!signal.aborted)
            throw new CrafletError(
                "LOG_FOLLOW",
                "Unable to follow the server log.",
                3,
            );
    }
}

export async function* followServerLogsFrom(
    projectDir: string,
    checkpoint: ServerLogCheckpoint,
    signal: AbortSignal,
): AsyncGenerator<ServerLogFollowEvent> {
    if (signal.aborted) return;
    let opened: OpenedLog | undefined;
    try {
        opened = await openVerifiedLog(projectDir);
        while (!opened && !signal.aborted) {
            if (checkpoint.generation !== null) {
                yield { kind: "reset" };
                return;
            }
            await poll(signal);
            if (!signal.aborted) opened = await openVerifiedLog(projectDir);
        }
        if (!opened || signal.aborted) return;
        if (checkpoint.generation === null) {
            yield { kind: "reset" };
            return;
        }
        if (checkpoint.generation !== opened.generation) {
            yield { kind: "reset" };
            return;
        }
        if (
            !Number.isSafeInteger(checkpoint.offset) ||
            checkpoint.offset < 0 ||
            checkpoint.offset > opened.size ||
            typeof checkpoint.anchor !== "string" ||
            !(await anchorMatches(opened, checkpoint.offset, checkpoint.anchor))
        ) {
            yield { kind: "reset" };
            return;
        }

        let position = checkpoint.offset;
        let anchor = checkpoint.anchor;
        const state = {
            pending: Buffer.alloc(0),
            discarding: checkpoint.discarding,
            omitted: checkpoint.discarding,
        };
        while (!signal.aborted) {
            if (!(await namedLogMatches(projectDir, opened))) {
                yield { kind: "reset" };
                return;
            }
            const stats = await opened.handle.stat({ bigint: true });
            const size = serverLogSize(stats.size);
            if (
                size < position ||
                !(await anchorMatches(opened, position, anchor))
            ) {
                yield { kind: "reset" };
                return;
            }
            if (size === position) {
                await poll(signal);
                continue;
            }
            const length = Math.min(FOLLOW_BYTES, size - position);
            const chunk = await readExact(opened.handle, position, length);
            position += length;
            anchor = await anchorAt(opened, position);
            const event = consumeForward(state, chunk);
            if (event.text)
                yield {
                    kind: "append",
                    text: event.text,
                    lineCount: event.lineCount,
                };
        }
    } catch (error) {
        if (error instanceof LogChangedError) {
            yield { kind: "reset" };
            return;
        }
        throw error;
    } finally {
        await opened?.handle.close();
    }
}
