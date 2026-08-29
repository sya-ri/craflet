import { StdinBuffer, type Terminal } from "@earendil-works/pi-tui";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const PROGRESS_ACTIVE = "\u001b]9;4;3\u0007";
const PROGRESS_CLEAR = "\u001b]9;4;0\u0007";

function escapeTimeout(env: NodeJS.ProcessEnv): number {
    const configured = Number(env.PI_TUI_ESC_TIMEOUT);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return env.SSH_CONNECTION || env.SSH_TTY ? 100 : 10;
}

function dimension(
    value: number | undefined,
    configured: string | undefined,
    fallback: number,
): number {
    const candidate = value || Number(configured);
    return Number.isSafeInteger(candidate) && candidate > 0
        ? candidate
        : fallback;
}

function titleText(value: string): string {
    return [...value]
        .filter((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code >= 32 && (code < 127 || code > 159);
        })
        .join("");
}

/** A portable terminal for Craflet's single-line server console. */
export class ConsoleTerminal implements Terminal {
    private readonly timeout: number;
    private wasRaw = false;
    private inputHandler: ((data: string) => void) | undefined;
    private resizeHandler: (() => void) | undefined;
    private buffer: StdinBuffer | undefined;
    private dataHandler: ((data: string | Buffer) => void) | undefined;

    constructor(
        private readonly input: NodeJS.ReadStream = process.stdin,
        private readonly output: NodeJS.WriteStream = process.stdout,
        private readonly env: NodeJS.ProcessEnv = process.env,
    ) {
        this.timeout = escapeTimeout(this.env);
    }

    get kittyProtocolActive(): boolean {
        return false;
    }

    get columns(): number {
        return dimension(this.output.columns, this.env.COLUMNS, 80);
    }

    get rows(): number {
        return dimension(this.output.rows, this.env.LINES, 24);
    }

    start(onInput: (data: string) => void, onResize: () => void): void {
        if (this.inputHandler)
            throw new Error("The console terminal is already running.");

        this.inputHandler = onInput;
        this.resizeHandler = onResize;
        this.buffer = new StdinBuffer({ escapeTimeout: this.timeout });
        this.buffer.on("data", (sequence) => this.inputHandler?.(sequence));
        this.buffer.on("paste", (content) =>
            this.inputHandler?.(`${PASTE_START}${content}${PASTE_END}`),
        );
        this.dataHandler = (data) => this.buffer?.process(data);
        this.input.on("data", this.dataHandler);
        this.output.on("resize", this.resizeHandler);

        this.wasRaw = this.input.isRaw ?? false;
        this.input.setRawMode?.(true);
        this.input.setEncoding("utf8");
        this.input.resume();
        this.output.write("\u001b[?2004h");
    }

    async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
        const previousHandler = this.inputHandler;
        this.inputHandler = undefined;
        let lastDataAt = Date.now();
        const onData = () => {
            lastDataAt = Date.now();
        };
        this.input.on("data", onData);
        const endAt = Date.now() + maxMs;
        try {
            while (Date.now() < endAt && Date.now() - lastDataAt < idleMs) {
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(idleMs, endAt - Date.now())),
                );
            }
        } finally {
            this.input.removeListener("data", onData);
            this.inputHandler = previousHandler;
        }
    }

    stop(): void {
        if (!this.inputHandler && !this.buffer) return;
        this.output.write("\u001b[?2004l");
        this.buffer?.destroy();
        this.buffer = undefined;
        if (this.dataHandler)
            this.input.removeListener("data", this.dataHandler);
        if (this.resizeHandler)
            this.output.removeListener("resize", this.resizeHandler);
        this.dataHandler = undefined;
        this.resizeHandler = undefined;
        this.inputHandler = undefined;
        this.input.pause();
        this.input.setRawMode?.(this.wasRaw);
    }

    write(data: string): void {
        this.output.write(data);
    }

    moveBy(lines: number): void {
        if (lines > 0) this.output.write(`\u001b[${lines}B`);
        else if (lines < 0) this.output.write(`\u001b[${-lines}A`);
    }

    hideCursor(): void {
        this.output.write("\u001b[?25l");
    }

    showCursor(): void {
        this.output.write("\u001b[?25h");
    }

    clearLine(): void {
        this.output.write("\u001b[K");
    }

    clearFromCursor(): void {
        this.output.write("\u001b[J");
    }

    clearScreen(): void {
        this.output.write("\u001b[2J\u001b[H");
    }

    setTitle(title: string): void {
        this.output.write(`\u001b]0;${titleText(title)}\u0007`);
    }

    setProgress(active: boolean): void {
        this.output.write(active ? PROGRESS_ACTIVE : PROGRESS_CLEAR);
    }
}
