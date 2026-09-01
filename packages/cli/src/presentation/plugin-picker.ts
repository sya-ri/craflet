import {
    CrafleetError,
    type PluginCatalog,
    type PluginCatalogContext,
    type PluginCatalogProject,
    type PluginCatalogVersion,
    type SourceInput,
} from "@crafleet/core";
import {
    type Component,
    type Focusable,
    Input,
    Key,
    matchesKey,
    type Terminal,
    TuiAltScreen,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { ConsoleTerminal } from "./console-terminal.js";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 20;
const SEARCH_RESULT_LIMIT = 100;
const MAX_QUERY_CHARACTERS = 120;

type PickerStage = "search" | "versions" | "review";
type SearchFocus = "search" | "results";

interface CartEntry {
    project: PluginCatalogProject;
    version: PluginCatalogVersion;
}

export interface ChoosePluginSourcesOptions {
    dryRun?: boolean;
    signal?: AbortSignal;
    terminal?: Terminal;
}

function boundedCharacters(value: string, maximum: number): string {
    const characters = [...value];
    if (characters.length <= maximum) return value;
    if (maximum <= 1) return characters.slice(0, maximum).join("");
    return `${characters.slice(0, maximum - 1).join("")}…`;
}

function unsafeTerminalCodePoint(point: number): boolean {
    return (
        point <= 0x1f ||
        (point >= 0x7f && point <= 0x9f) ||
        point === 0x061c ||
        point === 0x200e ||
        point === 0x200f ||
        (point >= 0x202a && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x2069)
    );
}

/** Make provider-owned text safe to render as one bounded terminal line. */
export function sanitizePluginCatalogText(
    value: string,
    maximum = 160,
): string {
    const safe = [...value]
        .map((character) => {
            const point = character.codePointAt(0) ?? 0;
            if (
                point === 0x09 ||
                point === 0x0a ||
                point === 0x0d ||
                point === 0x2028 ||
                point === 0x2029
            )
                return " ";
            return unsafeTerminalCodePoint(point) ? "" : character;
        })
        .join("")
        .replace(/\s+/gu, " ")
        .trim();
    return boundedCharacters(safe, Math.max(0, maximum));
}

function sanitizeQuery(value: string): string {
    const safe = [...value]
        .filter(
            (character) =>
                !unsafeTerminalCodePoint(character.codePointAt(0) ?? 0) &&
                character !== "\u2028" &&
                character !== "\u2029",
        )
        .join("");
    return [...safe].slice(0, MAX_QUERY_CHARACTERS).join("");
}

function line(value: string, width: number): string {
    return truncateToWidth(value, Math.max(1, width), "…");
}

function displayError(error: unknown): string {
    if (error instanceof CrafleetError)
        return sanitizePluginCatalogText(
            `${error.code}: ${error.message}`,
            220,
        );
    return sanitizePluginCatalogText(
        error instanceof Error ? error.message : "Unknown catalog error.",
        220,
    );
}

function downloads(value: number): string {
    if (!Number.isFinite(value) || value < 0) return "0";
    return new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(value);
}

function newestFirst(
    versions: readonly PluginCatalogVersion[],
): PluginCatalogVersion[] {
    return versions
        .map((version, index) => ({
            version,
            index,
            publishedAt: Date.parse(version.publishedAt),
        }))
        .sort(
            (left, right) =>
                (Number.isFinite(right.publishedAt)
                    ? right.publishedAt
                    : Number.NEGATIVE_INFINITY) -
                    (Number.isFinite(left.publishedAt)
                        ? left.publishedAt
                        : Number.NEGATIVE_INFINITY) || left.index - right.index,
        )
        .map(({ version }) => version);
}

function cancelled(): CrafleetError {
    return new CrafleetError(
        "CANCELLED",
        "Plugin selection was cancelled; no plugins were added.",
        130,
    );
}

class PluginPickerView implements Component, Focusable {
    private readonly input = new Input();
    private readonly lifecycle = new AbortController();
    private stage: PickerStage = "search";
    private searchFocus: SearchFocus = "search";
    private projects: PluginCatalogProject[] = [];
    private searchOffset = 0;
    private searchTotal = 0;
    private projectIndex = -1;
    private loadingSearch = false;
    private searchError = "";
    private status = "";
    private searchTimer: ReturnType<typeof setTimeout> | undefined;
    private searchEpoch = 0;
    private searchAbort: AbortController | undefined;
    private versionAbort: AbortController | undefined;
    private versionEpoch = 0;
    private versionProject: PluginCatalogProject | undefined;
    private versions: PluginCatalogVersion[] = [];
    private versionIndex = 0;
    private loadingVersions = false;
    private versionError = "";
    private includePrereleases = false;
    private reviewOffset = 0;
    private readonly cart = new Map<string, CartEntry>();
    private closed = false;
    private hasFocus = false;

    constructor(
        private readonly catalog: PluginCatalog,
        private readonly context: PluginCatalogContext,
        private readonly externalSignals: readonly AbortSignal[],
        private readonly dryRun: boolean,
        private readonly rows: () => number,
        private readonly requestRender: () => void,
        private readonly complete: (sources: SourceInput[]) => void,
        private readonly cancel: () => void,
    ) {}

    get focused(): boolean {
        return this.hasFocus;
    }

    set focused(value: boolean) {
        this.hasFocus = value;
        this.syncInputFocus();
    }

    start(): void {
        void this.search(0, this.query);
    }

    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        this.lifecycle.abort();
        this.searchAbort?.abort();
        this.versionAbort?.abort();
        if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
        this.searchTimer = undefined;
    }

    handleInput(data: string): void {
        if (this.closed) return;
        if (matchesKey(data, Key.ctrl("c"))) {
            this.cancel();
            return;
        }
        if (this.stage === "review") {
            this.handleReviewInput(data);
            return;
        }
        if (this.stage === "versions") {
            this.handleVersionInput(data);
            return;
        }
        this.handleSearchInput(data);
    }

    invalidate(): void {
        this.input.invalidate();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        if (this.stage === "versions") return this.renderVersions(safeWidth);
        if (this.stage === "review") return this.renderReview(safeWidth);
        return this.renderSearch(safeWidth);
    }

    private get query(): string {
        return this.input.getValue().trim();
    }

    private handleSearchInput(data: string): void {
        if (matchesKey(data, Key.f5)) {
            void this.search(this.searchOffset, this.query);
            return;
        }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            this.searchFocus =
                this.searchFocus === "search" && this.projects.length > 0
                    ? "results"
                    : "search";
            if (this.searchFocus === "results" && this.projectIndex < 0)
                this.projectIndex = 0;
            this.changed();
            return;
        }
        if (matchesKey(data, Key.enter)) {
            this.openReview();
            return;
        }
        if (this.searchFocus === "results") {
            this.handleResultInput(data);
            return;
        }
        if (matchesKey(data, Key.down)) {
            if (this.projects.length > 0) {
                this.searchFocus = "results";
                this.projectIndex = Math.max(0, this.projectIndex);
                this.changed();
            }
            return;
        }
        const before = this.input.getValue();
        this.input.handleInput(data);
        const safe = sanitizeQuery(this.input.getValue());
        if (safe !== this.input.getValue()) this.input.setValue(safe);
        if (safe !== before) this.scheduleSearch();
    }

    private handleResultInput(data: string): void {
        if (matchesKey(data, Key.left)) {
            this.searchFocus = "search";
            this.changed();
            return;
        }
        if (matchesKey(data, Key.up)) {
            if (this.projectIndex > 0) {
                this.projectIndex--;
                this.changed();
            } else if (this.searchOffset > 0) {
                void this.search(
                    Math.max(0, this.searchOffset - SEARCH_PAGE_SIZE),
                    this.query,
                    "end",
                );
            } else {
                this.searchFocus = "search";
                this.changed();
            }
            return;
        }
        if (matchesKey(data, Key.down)) {
            if (this.projectIndex < this.projects.length - 1) {
                this.projectIndex++;
                this.changed();
            } else if (this.hasNextPage) {
                void this.search(
                    this.searchOffset + SEARCH_PAGE_SIZE,
                    this.query,
                    "start",
                );
            }
            return;
        }
        if (matchesKey(data, Key.space)) {
            void this.toggleLatest();
            return;
        }
        if (matchesKey(data, Key.right)) {
            this.openVersions();
        }
    }

    private handleVersionInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            this.closeVersions();
            return;
        }
        if (matchesKey(data, "a")) {
            this.includePrereleases = !this.includePrereleases;
            this.versionIndex = 0;
            this.changed();
            return;
        }
        const visible = this.visibleVersions;
        if (matchesKey(data, Key.up)) {
            this.versionIndex = Math.max(0, this.versionIndex - 1);
            this.changed();
            return;
        }
        if (matchesKey(data, Key.down)) {
            this.versionIndex = Math.min(
                Math.max(0, visible.length - 1),
                this.versionIndex + 1,
            );
            this.changed();
            return;
        }
        if (matchesKey(data, Key.enter)) {
            const project = this.versionProject;
            const version = visible[this.versionIndex];
            if (!project || !version) return;
            this.cart.set(project.projectId, { project, version });
            this.status = `Selected ${sanitizePluginCatalogText(project.title, 60)} ${sanitizePluginCatalogText(version.label, 60)}.`;
            this.closeVersions();
        }
    }

    private handleReviewInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            this.stage = "search";
            this.reviewOffset = 0;
            this.syncInputFocus();
            this.changed();
            return;
        }
        const pageSize = this.reviewPageSize;
        const maximum = Math.max(0, this.cart.size - pageSize);
        if (matchesKey(data, Key.up)) {
            this.reviewOffset = Math.max(0, this.reviewOffset - 1);
            this.changed();
            return;
        }
        if (matchesKey(data, Key.down)) {
            this.reviewOffset = Math.min(maximum, this.reviewOffset + 1);
            this.changed();
            return;
        }
        if (matchesKey(data, Key.enter)) {
            this.complete(
                [...this.cart.values()].map(({ project, version }) => ({
                    provider: "modrinth",
                    project: project.projectId,
                    version: version.versionId,
                })),
            );
        }
    }

    private scheduleSearch(): void {
        this.searchEpoch++;
        this.searchAbort?.abort();
        if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
        this.projects = [];
        this.projectIndex = -1;
        this.searchOffset = 0;
        this.searchTotal = 0;
        this.searchError = "";
        this.loadingSearch = false;
        this.status = "Search updates in 300 ms…";
        this.searchTimer = setTimeout(() => {
            this.searchTimer = undefined;
            void this.search(0, this.query);
        }, SEARCH_DEBOUNCE_MS);
        this.changed();
    }

    private async search(
        offset: number,
        query: string,
        select: "start" | "end" = "start",
    ): Promise<void> {
        if (this.closed || this.loadingSearch) return;
        if (this.searchTimer !== undefined) {
            clearTimeout(this.searchTimer);
            this.searchTimer = undefined;
        }
        const safeOffset = Math.max(
            0,
            Math.min(
                SEARCH_RESULT_LIMIT - SEARCH_PAGE_SIZE,
                Math.floor(offset / SEARCH_PAGE_SIZE) * SEARCH_PAGE_SIZE,
            ),
        );
        const epoch = ++this.searchEpoch;
        this.searchAbort?.abort();
        const request = new AbortController();
        this.searchAbort = request;
        const signal = this.requestSignal(request.signal);
        this.loadingSearch = true;
        this.searchError = "";
        this.status = query
            ? "Searching Modrinth…"
            : "Loading popular plugins…";
        this.changed();
        try {
            const page = await this.catalog.search(
                {
                    query,
                    offset: safeOffset,
                    limit: SEARCH_PAGE_SIZE,
                },
                { ...this.context, signal },
            );
            if (this.closed || epoch !== this.searchEpoch || signal.aborted)
                return;
            this.projects = page.projects.slice(0, SEARCH_PAGE_SIZE);
            this.searchOffset = safeOffset;
            this.searchTotal = Math.max(0, page.total);
            this.projectIndex =
                this.projects.length === 0
                    ? -1
                    : select === "end"
                      ? this.projects.length - 1
                      : 0;
            this.status =
                this.projects.length === 0
                    ? "No compatible plugins found. Edit the search or press F5 to retry."
                    : "";
        } catch (error) {
            if (this.closed || epoch !== this.searchEpoch || signal.aborted)
                return;
            this.projects = [];
            this.projectIndex = -1;
            this.searchError = displayError(error);
            this.status = "Search failed. Edit the query or press F5 to retry.";
        } finally {
            if (!this.closed && epoch === this.searchEpoch) {
                this.loadingSearch = false;
                this.changed();
            }
        }
    }

    private async toggleLatest(): Promise<void> {
        const project = this.projects[this.projectIndex];
        if (!project || this.loadingVersions) return;
        if (this.cart.delete(project.projectId)) {
            this.status = `Removed ${sanitizePluginCatalogText(project.title, 80)} from the selection.`;
            this.changed();
            return;
        }
        const epoch = ++this.versionEpoch;
        this.versionAbort?.abort();
        const request = new AbortController();
        this.versionAbort = request;
        const signal = this.requestSignal(request.signal);
        this.loadingVersions = true;
        this.status = `Loading releases for ${sanitizePluginCatalogText(project.title, 80)}…`;
        this.changed();
        try {
            const available = newestFirst(
                await this.catalog.versions(project.projectId, {
                    ...this.context,
                    signal,
                }),
            );
            if (this.closed || epoch !== this.versionEpoch || signal.aborted)
                return;
            const version = available.find((item) => item.type === "release");
            if (!version) {
                this.status = `No compatible release is available for ${sanitizePluginCatalogText(project.title, 80)}. Use → to inspect prereleases.`;
                return;
            }
            this.cart.set(project.projectId, { project, version });
            this.status = `Selected ${sanitizePluginCatalogText(project.title, 60)} ${sanitizePluginCatalogText(version.label, 60)}.`;
        } catch (error) {
            if (this.closed || epoch !== this.versionEpoch || signal.aborted)
                return;
            this.status = `Could not load versions: ${displayError(error)}`;
        } finally {
            if (!this.closed && epoch === this.versionEpoch) {
                this.loadingVersions = false;
                this.changed();
            }
        }
    }

    private openVersions(): void {
        const project = this.projects[this.projectIndex];
        if (!project || this.loadingVersions) return;
        this.stage = "versions";
        this.versionProject = project;
        this.versions = [];
        this.versionIndex = 0;
        this.versionError = "";
        this.includePrereleases = false;
        this.syncInputFocus();
        this.changed();
        void this.loadVersions(project);
    }

    private async loadVersions(project: PluginCatalogProject): Promise<void> {
        const epoch = ++this.versionEpoch;
        this.versionAbort?.abort();
        const request = new AbortController();
        this.versionAbort = request;
        const signal = this.requestSignal(request.signal);
        this.loadingVersions = true;
        this.changed();
        try {
            const versions = await this.catalog.versions(project.projectId, {
                ...this.context,
                signal,
            });
            if (this.closed || epoch !== this.versionEpoch || signal.aborted)
                return;
            this.versions = newestFirst(versions);
            this.versionIndex = 0;
        } catch (error) {
            if (this.closed || epoch !== this.versionEpoch || signal.aborted)
                return;
            this.versionError = displayError(error);
        } finally {
            if (!this.closed && epoch === this.versionEpoch) {
                this.loadingVersions = false;
                this.changed();
            }
        }
    }

    private closeVersions(): void {
        this.versionEpoch++;
        this.versionAbort?.abort();
        this.loadingVersions = false;
        this.stage = "search";
        this.syncInputFocus();
        this.changed();
    }

    private openReview(): void {
        if (this.cart.size === 0) {
            this.status = "Select at least one plugin before review.";
            this.changed();
            return;
        }
        this.stage = "review";
        this.reviewOffset = 0;
        this.syncInputFocus();
        this.changed();
    }

    private requestSignal(request: AbortSignal): AbortSignal {
        return AbortSignal.any([
            this.lifecycle.signal,
            request,
            ...this.externalSignals,
        ]);
    }

    private get hasNextPage(): boolean {
        return (
            this.searchOffset + SEARCH_PAGE_SIZE < this.searchTotal &&
            this.searchOffset + SEARCH_PAGE_SIZE < SEARCH_RESULT_LIMIT
        );
    }

    private get visibleVersions(): PluginCatalogVersion[] {
        return this.includePrereleases
            ? this.versions
            : this.versions.filter((version) => version.type === "release");
    }

    private syncInputFocus(): void {
        this.input.focused =
            this.hasFocus &&
            this.stage === "search" &&
            this.searchFocus === "search";
    }

    private changed(): void {
        this.syncInputFocus();
        this.requestRender();
    }

    private renderSearch(width: number): string[] {
        const rows = Math.max(1, this.rows());
        const inputPrefix = `${this.searchFocus === "search" ? ">" : " "} Search: `;
        const inputWidth = Math.max(1, width - visibleWidth(inputPrefix));
        const inputLine = this.input.render(inputWidth)[0] ?? "";
        const cappedTotal = Math.min(SEARCH_RESULT_LIMIT, this.searchTotal);
        const rangeStart =
            this.projects.length === 0 ? 0 : this.searchOffset + 1;
        const rangeEnd = this.searchOffset + this.projects.length;
        const output = [
            line("Crafleet plugin picker — Modrinth", width),
            line(`${inputPrefix}${inputLine}`, width),
            line(
                `Results ${rangeStart}-${rangeEnd} of ${cappedTotal} | Cart: ${this.cart.size}`,
                width,
            ),
            line(
                this.loadingSearch
                    ? this.status
                    : this.searchError || this.status,
                width,
            ),
            "",
        ];
        const footerRows = 2;
        const availableRows = Math.max(2, rows - output.length - footerRows);
        const visibleCount = Math.max(1, Math.floor(availableRows / 2));
        const selected = Math.max(0, this.projectIndex);
        const start = Math.max(
            0,
            Math.min(
                Math.max(0, this.projects.length - visibleCount),
                selected - visibleCount + 1,
            ),
        );
        for (const [relativeIndex, project] of this.projects
            .slice(start, start + visibleCount)
            .entries()) {
            const index = start + relativeIndex;
            const marker =
                this.searchFocus === "results" && index === this.projectIndex
                    ? ">"
                    : " ";
            const checked = this.cart.has(project.projectId) ? "x" : " ";
            output.push(
                line(
                    `${marker} [${checked}] ${sanitizePluginCatalogText(project.title, 80)} by ${sanitizePluginCatalogText(project.author, 50)} · ${downloads(project.downloads)} downloads`,
                    width,
                ),
                line(
                    `      ${sanitizePluginCatalogText(project.description, 180)}`,
                    width,
                ),
            );
        }
        while (output.length < rows - footerRows) output.push("");
        output.push(
            line(
                "Tab/↓: results · ↑/↓: move/page · Space: latest · →: versions",
                width,
            ),
            line("Enter: review · F5: retry · Ctrl-C: cancel", width),
        );
        return output.slice(0, rows);
    }

    private renderVersions(width: number): string[] {
        const rows = Math.max(1, this.rows());
        const project = this.versionProject;
        const visible = this.visibleVersions;
        this.versionIndex = Math.min(
            Math.max(0, visible.length - 1),
            this.versionIndex,
        );
        const output = [
            line("Choose an exact Modrinth version", width),
            line(
                project
                    ? sanitizePluginCatalogText(project.title, 100)
                    : "Plugin",
                width,
            ),
            line(
                `Showing ${this.includePrereleases ? "release, beta and alpha" : "release only"}`,
                width,
            ),
            line(
                this.loadingVersions
                    ? "Loading compatible versions…"
                    : this.versionError ||
                          (visible.length === 0
                              ? "No versions in this view. Press a to include prereleases."
                              : ""),
                width,
            ),
            "",
        ];
        const footerRows = 2;
        const visibleCount = Math.max(1, rows - output.length - footerRows);
        const start = Math.max(
            0,
            Math.min(
                Math.max(0, visible.length - visibleCount),
                this.versionIndex - visibleCount + 1,
            ),
        );
        for (const [relativeIndex, version] of visible
            .slice(start, start + visibleCount)
            .entries()) {
            const index = start + relativeIndex;
            const selected =
                project &&
                this.cart.get(project.projectId)?.version.versionId ===
                    version.versionId;
            output.push(
                line(
                    `${index === this.versionIndex ? ">" : " "} [${selected ? "x" : " "}] ${sanitizePluginCatalogText(version.label, 90)} · ${version.type} · ${sanitizePluginCatalogText(version.publishedAt, 30)} · ${sanitizePluginCatalogText(version.versionId, 80)}`,
                    width,
                ),
            );
        }
        while (output.length < rows - footerRows) output.push("");
        output.push(
            line("↑/↓: move · a: toggle prereleases · Enter: select", width),
            line("Esc: back · Ctrl-C: cancel", width),
        );
        return output.slice(0, rows);
    }

    private get reviewPageSize(): number {
        return Math.max(1, Math.max(1, this.rows()) - 7);
    }

    private renderReview(width: number): string[] {
        const rows = Math.max(1, this.rows());
        const entries = [...this.cart.values()];
        const pageSize = this.reviewPageSize;
        this.reviewOffset = Math.min(
            Math.max(0, entries.length - pageSize),
            this.reviewOffset,
        );
        const output = [
            line("Review plugin selection", width),
            line(
                this.dryRun
                    ? `${entries.length} ${entries.length === 1 ? "plugin" : "plugins"} would be added; JAR descriptors are checked when applied.`
                    : `${entries.length} ${entries.length === 1 ? "plugin" : "plugins"} will be resolved and descriptor-checked.`,
                width,
            ),
            "",
        ];
        for (const { project, version } of entries.slice(
            this.reviewOffset,
            this.reviewOffset + pageSize,
        )) {
            output.push(
                line(
                    `• ${sanitizePluginCatalogText(project.title, 70)} — ${sanitizePluginCatalogText(version.label, 70)} (${sanitizePluginCatalogText(version.versionId, 80)})`,
                    width,
                ),
            );
        }
        while (output.length < rows - 3) output.push("");
        output.push(
            line(
                entries.length > pageSize
                    ? `Showing ${this.reviewOffset + 1}-${Math.min(entries.length, this.reviewOffset + pageSize)} of ${entries.length} · ↑/↓: scroll`
                    : "Exact Modrinth version IDs will be saved.",
                width,
            ),
            line(
                `${this.dryRun ? "Enter: finish dry-run" : "Enter: add selected plugins"} · Esc: back`,
                width,
            ),
            line("Ctrl-C: cancel", width),
        );
        return output.slice(0, rows);
    }
}

/** Interactively choose exact Modrinth plugin sources in an alternate-screen TUI. */
export async function choosePluginSources(
    catalog: PluginCatalog,
    context: PluginCatalogContext,
    options: ChoosePluginSourcesOptions = {},
): Promise<SourceInput[]> {
    const terminal =
        options.terminal ?? new ConsoleTerminal(process.stdin, process.stderr);
    const tui = new TuiAltScreen(terminal, true, undefined, { mouse: false });
    const done = Promise.withResolvers<SourceInput[]>();
    let settled = false;
    const settle = (
        outcome:
            | { kind: "complete"; sources: SourceInput[] }
            | { kind: "cancel" },
    ) => {
        if (settled) return;
        settled = true;
        if (outcome.kind === "complete") done.resolve(outcome.sources);
        else done.reject(cancelled());
    };
    const signals = [...new Set([context.signal, options.signal])].filter(
        (signal): signal is AbortSignal => signal !== undefined,
    );
    const view = new PluginPickerView(
        catalog,
        context,
        signals,
        options.dryRun ?? false,
        () => terminal.rows,
        () => tui.requestRender(),
        (sources) => settle({ kind: "complete", sources }),
        () => settle({ kind: "cancel" }),
    );
    const onAbort = () => settle({ kind: "cancel" });
    for (const signal of signals)
        signal.addEventListener("abort", onAbort, { once: true });
    let startAttempted = false;
    try {
        if (signals.some((signal) => signal.aborted)) throw cancelled();
        tui.setLayoutRoot(view);
        tui.setFocus(view);
        startAttempted = true;
        tui.start();
        view.start();
        return await done.promise;
    } finally {
        view.dispose();
        for (const signal of signals)
            signal.removeEventListener("abort", onAbort);
        if (startAttempted) {
            try {
                await terminal.drainInput(100, 20);
            } finally {
                tui.stop({ preserveScreen: true });
            }
        }
    }
}
