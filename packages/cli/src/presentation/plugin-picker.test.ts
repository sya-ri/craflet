import { stripVTControlCharacters } from "node:util";
import {
    CrafleetError,
    type PluginCatalog,
    type PluginCatalogProject,
    type PluginCatalogVersion,
    type PluginSearchPage,
} from "@crafleet/core";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    choosePluginSources,
    sanitizePluginCatalogText,
} from "./plugin-picker.js";

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const RIGHT = "\u001b[C";
const ENTER = "\r";
const SPACE = " ";
const CTRL_C = "\u0003";
const F5 = "\u001b[15~";

class FakeTerminal implements Terminal {
    columns = 100;
    rows = 24;
    readonly kittyProtocolActive = false;
    readonly writes: string[] = [];
    readonly drainInput = vi.fn(async () => {});
    starts = 0;
    stops = 0;
    private input: ((data: string) => void) | undefined;
    private resizeHandler: (() => void) | undefined;

    start(onInput: (data: string) => void, onResize: () => void): void {
        this.starts++;
        this.input = onInput;
        this.resizeHandler = onResize;
    }

    stop(): void {
        this.stops++;
        this.input = undefined;
        this.resizeHandler = undefined;
    }

    send(data: string): void {
        this.input?.(data);
    }

    resize(columns: number, rows: number): void {
        this.columns = columns;
        this.rows = rows;
        this.resizeHandler?.();
    }

    text(): string {
        return stripVTControlCharacters(this.writes.join(""));
    }

    write(data: string): void {
        this.writes.push(data);
    }

    moveBy(): void {}
    hideCursor(): void {}
    showCursor(): void {}
    clearLine(): void {}
    clearFromCursor(): void {}
    clearScreen(): void {}
    setTitle(): void {}
    setProgress(): void {}
}

function project(projectId: string, title = projectId): PluginCatalogProject {
    return {
        projectId,
        title,
        author: "Crafleet test",
        description: `Description for ${title}`,
        downloads: 12_345,
    };
}

function version(
    versionId: string,
    type: PluginCatalogVersion["type"] = "release",
    publishedAt = "2026-01-01T00:00:00.000Z",
): PluginCatalogVersion {
    return { versionId, label: `Label ${versionId}`, type, publishedAt };
}

function page(
    projects: PluginCatalogProject[],
    offset = 0,
    total = projects.length,
): PluginSearchPage {
    return { projects, offset, limit: 20, total };
}

function catalog(
    projects = [project("one", "Plugin One")],
    versions = [version("release-1")],
): PluginCatalog {
    return {
        search: vi.fn(async (request) =>
            page(projects, request.offset, projects.length),
        ),
        versions: vi.fn(async () => versions),
    };
}

async function waitForText(
    terminal: FakeTerminal,
    expected: string,
): Promise<void> {
    await vi.waitFor(() => expect(terminal.text()).toContain(expected));
}

afterEach(() => {
    vi.useRealTimers();
});

describe("plugin catalog text", () => {
    it("removes terminal controls and bidi overrides and bounds provider text", () => {
        expect(
            sanitizePluginCatalogText(
                "before\u001b[2J\u202eafter\nnext\titem",
                24,
            ),
        ).toBe("before[2Jafter next item");
        expect(sanitizePluginCatalogText("abcdefgh", 5)).toBe("abcd…");
    });
});

describe("interactive plugin picker", () => {
    it("shows popular plugins immediately and cancels with full terminal cleanup", async () => {
        const terminal = new FakeTerminal();
        const provider = catalog([
            project("safe", "Safe\u001b[2J\u202e Plugin"),
        ]);
        const selection = choosePluginSources(
            provider,
            { serverKind: "paper", minecraftVersion: "1.21.8" },
            { terminal },
        );

        await vi.waitFor(() => {
            expect(provider.search).toHaveBeenCalledWith(
                { query: "", offset: 0, limit: 20 },
                expect.objectContaining({
                    serverKind: "paper",
                    minecraftVersion: "1.21.8",
                    signal: expect.any(AbortSignal),
                }),
            );
        });
        await waitForText(terminal, "Safe[2J Plugin");
        terminal.resize(72, 18);
        terminal.send(CTRL_C);

        await expect(selection).rejects.toMatchObject({
            code: "CANCELLED",
            exitCode: 130,
        });
        expect(terminal.starts).toBe(1);
        expect(terminal.stops).toBe(1);
        expect(terminal.drainInput).toHaveBeenCalledOnce();
        expect(terminal.writes.join("")).toContain("\u001b[?1049h");
        expect(terminal.writes.join("")).toContain("\u001b[?1049l");
    });

    it("adds the newest compatible release with Space and returns its exact IDs after review", async () => {
        const terminal = new FakeTerminal();
        const provider = catalog(
            [project("project-id", "Plugin One")],
            [
                version("beta-new", "beta", "2026-03-01T00:00:00.000Z"),
                version("release-old", "release", "2025-01-01T00:00:00.000Z"),
                version("release-new", "release", "2026-02-01T00:00:00.000Z"),
            ],
        );
        const selection = choosePluginSources(
            provider,
            { serverKind: "paper", minecraftVersion: "1.21.8" },
            { terminal },
        );

        await waitForText(terminal, "Plugin One");
        terminal.send(DOWN);
        terminal.send(SPACE);
        await vi.waitFor(() =>
            expect(provider.versions).toHaveBeenCalledOnce(),
        );
        await waitForText(terminal, "Cart: 1");
        terminal.send(ENTER);
        await waitForText(terminal, "Review plugin selection");
        expect(terminal.text()).toContain("release-new");
        terminal.send(ENTER);

        await expect(selection).resolves.toEqual([
            {
                provider: "modrinth",
                project: "project-id",
                version: "release-new",
            },
        ]);
        expect(terminal.stops).toBe(1);
    });

    it("labels dry-run review as a preview without promising descriptor validation", async () => {
        const terminal = new FakeTerminal();
        const selection = choosePluginSources(
            catalog(),
            { serverKind: "paper", minecraftVersion: "1.21.8" },
            { dryRun: true, terminal },
        );

        await waitForText(terminal, "Plugin One");
        terminal.send(DOWN);
        terminal.send(SPACE);
        await waitForText(terminal, "Cart: 1");
        terminal.send(ENTER);
        await waitForText(terminal, "would be added");
        expect(terminal.text()).toContain(
            "descriptors are checked when applied",
        );
        expect(terminal.text()).toContain("Enter: finish dry-run");
        terminal.send(CTRL_C);

        await expect(selection).rejects.toMatchObject({ code: "CANCELLED" });
    });

    it("keeps prereleases hidden until toggled and lets Right select an exact beta", async () => {
        const terminal = new FakeTerminal();
        const provider = catalog(
            [project("project-id", "Plugin One")],
            [
                version("beta-new", "beta", "2026-03-01T00:00:00.000Z"),
                version("release-old", "release", "2026-01-01T00:00:00.000Z"),
            ],
        );
        const selection = choosePluginSources(
            provider,
            { serverKind: "velocity" },
            { terminal },
        );

        await waitForText(terminal, "Plugin One");
        terminal.send(DOWN);
        terminal.send(RIGHT);
        await waitForText(terminal, "Choose an exact Modrinth version");
        await waitForText(terminal, "release-old");
        expect(terminal.text()).not.toContain("beta-new");
        terminal.send("a");
        await waitForText(terminal, "beta-new");
        terminal.send(ENTER);
        await waitForText(terminal, "Cart: 1");
        terminal.send(ENTER);
        await waitForText(terminal, "Review plugin selection");
        terminal.send(ENTER);

        await expect(selection).resolves.toEqual([
            {
                provider: "modrinth",
                project: "project-id",
                version: "beta-new",
            },
        ]);
    });

    it("keeps a multi-plugin cart while the live search query changes", async () => {
        const terminal = new FakeTerminal();
        const provider: PluginCatalog = {
            search: vi.fn(async (request) =>
                request.query === "x"
                    ? page([project("second", "Second Plugin")])
                    : page([project("first", "First Plugin")]),
            ),
            versions: vi.fn(async (projectId) => [
                version(`${projectId}-release`),
            ]),
        };
        const selection = choosePluginSources(
            provider,
            { serverKind: "paper", minecraftVersion: "1.21.8" },
            { terminal },
        );

        await waitForText(terminal, "First Plugin");
        terminal.send(DOWN);
        terminal.send(SPACE);
        await waitForText(terminal, "Cart: 1");
        terminal.send("\t");
        terminal.send("x");
        await vi.waitFor(() =>
            expect(provider.search).toHaveBeenCalledTimes(2),
        );
        await waitForText(terminal, "Second Plugin");
        terminal.send(DOWN);
        terminal.send(SPACE);
        await waitForText(terminal, "Cart: 2");
        terminal.send(ENTER);
        await waitForText(terminal, "Review plugin selection");
        expect(terminal.text()).toContain("first-release");
        expect(terminal.text()).toContain("second-release");
        terminal.send(ENTER);

        await expect(selection).resolves.toEqual([
            {
                provider: "modrinth",
                project: "first",
                version: "first-release",
            },
            {
                provider: "modrinth",
                project: "second",
                version: "second-release",
            },
        ]);
    });

    it("debounces live search and ignores an older response that resolves last", async () => {
        vi.useFakeTimers();
        const terminal = new FakeTerminal();
        const stale = Promise.withResolvers<PluginSearchPage>();
        const fresh = Promise.withResolvers<PluginSearchPage>();
        const provider: PluginCatalog = {
            search: vi.fn(async (request) => {
                if (request.query === "a") return stale.promise;
                if (request.query === "ab") return fresh.promise;
                return page([project("popular", "Popular")]);
            }),
            versions: vi.fn(async () => [version("release")]),
        };
        const selection = choosePluginSources(
            provider,
            { serverKind: "paper", minecraftVersion: "1.21.8" },
            { terminal },
        );
        await vi.advanceTimersByTimeAsync(20);
        expect(provider.search).toHaveBeenCalledTimes(1);

        terminal.send("a");
        await vi.advanceTimersByTimeAsync(299);
        expect(provider.search).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(provider.search).toHaveBeenCalledTimes(2);
        terminal.send("b");
        await vi.advanceTimersByTimeAsync(300);
        expect(provider.search).toHaveBeenCalledTimes(3);

        fresh.resolve(page([project("fresh", "Fresh result")]));
        await vi.advanceTimersByTimeAsync(20);
        expect(terminal.text()).toContain("Fresh result");
        stale.resolve(page([project("stale", "Stale result")]));
        await vi.advanceTimersByTimeAsync(20);
        expect(terminal.text()).not.toContain("Stale result");

        terminal.send(CTRL_C);
        await expect(selection).rejects.toMatchObject({ code: "CANCELLED" });
    });

    it("pages through at most the first 100 search results", async () => {
        const terminal = new FakeTerminal();
        const provider: PluginCatalog = {
            search: vi.fn(async (request) =>
                page(
                    Array.from({ length: 20 }, (_, index) =>
                        project(
                            `plugin-${request.offset + index}`,
                            `Plugin ${request.offset + index}`,
                        ),
                    ),
                    request.offset,
                    120,
                ),
            ),
            versions: vi.fn(async () => [version("release")]),
        };
        const selection = choosePluginSources(
            provider,
            { serverKind: "velocity" },
            { terminal },
        );
        await waitForText(terminal, "Plugin 0");
        terminal.send(DOWN);

        for (let expectedPage = 1; expectedPage < 5; expectedPage++) {
            for (let index = 0; index < 19; index++) terminal.send(DOWN);
            terminal.send(DOWN);
            await vi.waitFor(() =>
                expect(provider.search).toHaveBeenCalledTimes(expectedPage + 1),
            );
            await waitForText(terminal, `Plugin ${expectedPage * 20}`);
        }
        for (let index = 0; index < 19; index++) terminal.send(DOWN);
        terminal.send(DOWN);
        expect(provider.search).toHaveBeenCalledTimes(5);
        expect(
            vi
                .mocked(provider.search)
                .mock.calls.map(([request]) => request.offset),
        ).toEqual([0, 20, 40, 60, 80]);

        for (let index = 0; index < 20; index++) terminal.send(UP);
        await vi.waitFor(() =>
            expect(provider.search).toHaveBeenCalledTimes(6),
        );
        expect(vi.mocked(provider.search).mock.calls[5]?.[0].offset).toBe(60);
        terminal.send(CTRL_C);
        await expect(selection).rejects.toMatchObject({ code: "CANCELLED" });
    });

    it("renders provider failures and can retry without leaving the picker", async () => {
        const terminal = new FakeTerminal();
        const provider = catalog();
        vi.mocked(provider.search)
            .mockRejectedValueOnce(
                new CrafleetError(
                    "RATE_LIMIT",
                    "Modrinth rate limit reached.",
                    4,
                ),
            )
            .mockResolvedValueOnce(page([project("retry", "Retry result")]));
        const selection = choosePluginSources(
            provider,
            { serverKind: "paper", minecraftVersion: "1.21.8" },
            { terminal },
        );

        await waitForText(terminal, "RATE_LIMIT: Modrinth rate limit reached.");
        terminal.send(F5);
        await waitForText(terminal, "Retry result");
        expect(provider.search).toHaveBeenCalledTimes(2);
        terminal.send(CTRL_C);
        await expect(selection).rejects.toMatchObject({ code: "CANCELLED" });
    });

    it("aborts in-flight catalog work and restores the terminal on external cancellation", async () => {
        const terminal = new FakeTerminal();
        const pending = Promise.withResolvers<PluginSearchPage>();
        const provider: PluginCatalog = {
            search: vi.fn(async () => pending.promise),
            versions: vi.fn(async () => []),
        };
        const controller = new AbortController();
        const selection = choosePluginSources(
            provider,
            {
                serverKind: "paper",
                minecraftVersion: "1.21.8",
                signal: controller.signal,
            },
            { terminal, signal: controller.signal },
        );
        await vi.waitFor(() => expect(provider.search).toHaveBeenCalledOnce());
        const catalogSignal = vi.mocked(provider.search).mock.calls[0]?.[1]
            .signal;
        expect(catalogSignal?.aborted).toBe(false);

        controller.abort();
        await expect(selection).rejects.toMatchObject({ code: "CANCELLED" });
        expect(catalogSignal?.aborted).toBe(true);
        expect(terminal.stops).toBe(1);
    });
});
