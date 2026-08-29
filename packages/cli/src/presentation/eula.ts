import { emitKeypressEvents, type Key } from "node:readline";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { CrafletError } from "@craflet/core";

export interface EulaDocument {
    path: string;
    text: string;
    url: string;
}

export interface EulaConfirmationOptions {
    yes?: boolean;
    json?: boolean;
    signal?: AbortSignal;
}

export interface EulaPagerState {
    stage: "document" | "confirm";
    offset: number;
    agree: boolean;
}

interface EulaFrame {
    text: string;
    offset: number;
    pageSize: number;
    maxOffset: number;
}

const ENTER_SCREEN = "\u001b[?1049h";
const LEAVE_SCREEN = "\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[H\u001b[2J";

export function sanitizeEulaTerminalText(value: string): string {
    const stripped = stripVTControlCharacters(value)
        .replace(/\r\n?/g, "\n")
        .replace(/[\u2028\u2029]/g, "\n")
        .replace(/\t/g, "    ");
    return [...stripped]
        .filter((character) => {
            const point = character.codePointAt(0) ?? 0;
            return !(
                (point <= 0x1f && point !== 0x0a) ||
                (point >= 0x7f && point <= 0x9f) ||
                point === 0x200e ||
                point === 0x200f ||
                (point >= 0x202a && point <= 0x202e) ||
                (point >= 0x2066 && point <= 0x2069)
            );
        })
        .join("");
}

function wrap(value: string, width: number): string[] {
    const result: string[] = [];
    for (const line of value.split("\n")) {
        let current = "";
        let columns = 0;
        for (const character of line) {
            // Counting every non-ASCII code point as two cells is conservative:
            // it preserves all text without depending on a terminal's Unicode width table.
            const size = character.charCodeAt(0) > 0x7e ? 2 : 1;
            if (columns + size > width && current) {
                result.push(current);
                current = "";
                columns = 0;
            }
            current += character;
            columns += size;
        }
        result.push(current);
    }
    return result;
}

function dimension(
    value: number | undefined,
    fallback: number,
    maximum: number,
): number {
    return Number.isFinite(value) && value !== undefined
        ? Math.min(maximum, Math.floor(value))
        : fallback;
}

export function renderEulaFrame(
    document: EulaDocument,
    state: EulaPagerState,
    terminal: { columns?: number; rows?: number },
): EulaFrame {
    const columns = dimension(terminal.columns, 80, 240);
    const rows = dimension(terminal.rows, 24, 100);
    if (columns < 40 || rows < 10)
        throw new CrafletError(
            "CONFIRMATION_REQUIRED",
            "EULA confirmation needs a terminal at least 40 columns wide and 10 rows high. Resize it and retry.",
            3,
        );
    const width = columns - 2;
    const pageSize = rows - 7;
    const path = sanitizeEulaTerminalText(document.path).replaceAll("\n", " ");
    const url = sanitizeEulaTerminalText(document.url).replaceAll("\n", " ");
    const lines = wrap(
        `File: ${path}\nFull agreement: ${url}\n\n${sanitizeEulaTerminalText(document.text)}`,
        width,
    );
    const maxOffset = Math.max(0, lines.length - pageSize);
    const offset = Math.max(0, Math.min(maxOffset, state.offset));
    const content =
        state.stage === "document"
            ? [
                  "Review the EULA document",
                  ...lines.slice(offset, offset + pageSize),
                  "-".repeat(width),
                  `Lines ${offset + 1}-${Math.min(lines.length, offset + pageSize)} of ${lines.length}`,
                  "Up/Down/PgUp/PgDn: scroll",
                  "Home/End: top/bottom",
                  "Enter: continue | q/Esc: cancel",
              ]
            : [
                  "Accept the Minecraft EULA?",
                  "Scope: this OS user and host.",
                  "Future projects in this home reuse it.",
                  "",
                  `${state.agree ? " " : ">"} Decline`,
                  `${state.agree ? ">" : " "} Agree`,
                  "",
                  "Arrows: select | Enter: confirm",
                  "q/Esc/Ctrl-C: cancel",
              ];
    return { text: content.join("\n"), offset, pageSize, maxOffset };
}

export function handleEulaKey(
    state: EulaPagerState,
    key: Pick<Key, "name" | "ctrl">,
    page: Pick<EulaFrame, "pageSize" | "maxOffset">,
): { state: EulaPagerState; result?: "accept" | "cancel" } {
    const name = key.name?.toLowerCase();
    if (
        name === "escape" ||
        name === "q" ||
        (key.ctrl && (name === "c" || name === "d"))
    )
        return { state, result: "cancel" };
    if (name === "return" || name === "enter")
        return state.stage === "document"
            ? { state: { ...state, stage: "confirm", agree: false } }
            : { state, result: state.agree ? "accept" : "cancel" };
    if (state.stage === "confirm") {
        if (name === "up" || name === "left")
            return { state: { ...state, agree: false } };
        if (name === "down" || name === "right")
            return { state: { ...state, agree: true } };
        return { state };
    }
    let offset = state.offset;
    if (name === "up") offset--;
    else if (name === "down") offset++;
    else if (name === "pageup") offset -= page.pageSize;
    else if (name === "pagedown" || name === "space") offset += page.pageSize;
    else if (name === "home") offset = 0;
    else if (name === "end") offset = page.maxOffset;
    return {
        state: {
            ...state,
            offset: Math.max(0, Math.min(page.maxOffset, offset)),
        },
    };
}

function cancelled(): CrafletError {
    return new CrafletError(
        "CANCELLED",
        "EULA confirmation was declined or cancelled; no consent was granted.",
        130,
    );
}

function terminalFailure(): CrafletError {
    return new CrafletError(
        "EULA_TERMINAL",
        "The EULA confirmation could not be completed; no consent was granted.",
        3,
    );
}

function isCiEnvironment(value: string | undefined): boolean {
    if (value === undefined) return false;
    const normalized = value.trim().toLowerCase();
    return !["", "0", "false", "no", "off"].includes(normalized);
}

export async function confirmEula(
    document: EulaDocument,
    options: EulaConfirmationOptions = {},
): Promise<void> {
    if (options.signal?.aborted) throw cancelled();
    if (options.yes) return;
    const input = process.stdin;
    const output = process.stderr;
    if (
        options.json ||
        isCiEnvironment(process.env.CI) ||
        !input.isTTY ||
        !output.isTTY ||
        typeof input.setRawMode !== "function"
    )
        throw new CrafletError(
            "CONFIRMATION_REQUIRED",
            "EULA confirmation requires an interactive terminal outside CI. Read the agreement and explicitly pass --yes to accept without the UI.",
            3,
        );
    const wasRaw = input.isRaw;
    const wasFlowing = input.readableFlowing === true;
    let state: EulaPagerState = { stage: "document", offset: 0, agree: false };
    let frame = renderEulaFrame(document, state, output);
    // Decode keys on an owned stream so readline adds no hidden listeners to stdin.
    const keyboard = new PassThrough();
    await new Promise<void>((resolve, reject) => {
        let finished = false;
        let rawChanged = false;
        let alternateScreen = false;
        const finish = (error?: CrafletError) => {
            if (finished) return;
            finished = true;
            let cleanupFailed = false;
            const cleanup = (action: () => void) => {
                try {
                    action();
                } catch {
                    cleanupFailed = true;
                }
            };
            cleanup(() => input.off("data", onData));
            cleanup(() => input.off("end", onCancel));
            cleanup(() => input.off("close", onCancel));
            cleanup(() => input.off("error", onError));
            cleanup(() => output.off("resize", draw));
            cleanup(() => output.off("error", onError));
            cleanup(() => process.off("SIGINT", onCancel));
            cleanup(() =>
                options.signal?.removeEventListener("abort", onCancel),
            );
            cleanup(() => keyboard.removeAllListeners());
            cleanup(() => keyboard.destroy());
            if (rawChanged)
                cleanup(() => {
                    input.setRawMode(wasRaw);
                });
            cleanup(() => {
                if (wasFlowing) input.resume();
                else input.pause();
            });
            // The alternate screen restores the original screen and cursor position.
            // Cursor visibility is never changed.
            if (alternateScreen)
                cleanup(() => {
                    output.write(LEAVE_SCREEN);
                });
            if (error) reject(error);
            else if (cleanupFailed) reject(terminalFailure());
            else resolve();
        };
        const onCancel = () => finish(cancelled());
        const onError = () => finish(terminalFailure());
        const draw = () => {
            if (finished) return;
            try {
                frame = renderEulaFrame(document, state, output);
                state = { ...state, offset: frame.offset };
                output.write(`${CLEAR_SCREEN}${frame.text}`);
            } catch (error) {
                finish(
                    error instanceof CrafletError ? error : terminalFailure(),
                );
            }
        };
        const onKey = (_text: string, key: Key) => {
            if (finished) return;
            try {
                const next = handleEulaKey(state, key, frame);
                state = next.state;
                if (next.result === "accept") finish();
                else if (next.result === "cancel") onCancel();
                else draw();
            } catch {
                onError();
            }
        };
        const onData = (data: Buffer | string) => {
            if (!finished) {
                try {
                    keyboard.write(data);
                } catch {
                    onError();
                }
            }
        };
        try {
            emitKeypressEvents(keyboard);
            keyboard.on("keypress", onKey);
            keyboard.on("error", onError);
            input.on("data", onData);
            input.on("end", onCancel);
            input.on("close", onCancel);
            input.on("error", onError);
            output.on("resize", draw);
            output.on("error", onError);
            process.on("SIGINT", onCancel);
            options.signal?.addEventListener("abort", onCancel, { once: true });
            if (options.signal?.aborted) {
                onCancel();
                return;
            }
            if (!wasRaw) {
                rawChanged = true;
                input.setRawMode(true);
            }
            alternateScreen = true;
            output.write(ENTER_SCREEN);
            draw();
            if (!finished) input.resume();
        } catch {
            onError();
        }
    });
}
