import type { PluginCatalogContext } from "@crafleet/core";
import { describe, expect, it, vi } from "vitest";
import { NodePluginCatalog } from "./plugin-catalog.js";

const paper: PluginCatalogContext = {
    serverKind: "paper",
    minecraftVersion: "1.21.4",
};

function searchHit(extra: Record<string, unknown> = {}) {
    return {
        project_id: "project-id",
        title: "Plugin",
        author: "Author",
        description: "Description",
        downloads: 123,
        ...extra,
    };
}

function version(extra: Record<string, unknown> = {}) {
    return {
        id: "version-id",
        name: "Plugin 1.0",
        version_number: "1.0",
        version_type: "release",
        date_published: "2026-01-01T00:00:00Z",
        loaders: ["paper"],
        game_versions: ["1.21.4"],
        ...extra,
    };
}

function queued(values: Array<unknown | Response>) {
    const fetcher = vi.fn<typeof fetch>(async () => {
        const value = values.shift();
        return value instanceof Response
            ? value
            : new Response(JSON.stringify(value), {
                  headers: { "content-type": "application/json" },
              });
    });
    return {
        catalog: new NodePluginCatalog({ fetch: fetcher }),
        fetcher,
    };
}

describe("Modrinth plugin catalog", () => {
    it("searches compatible Paper plugins by downloads with bounded pagination", async () => {
        const { catalog, fetcher } = queued([
            {
                hits: [searchHit()],
                offset: 20,
                limit: 20,
                total_hits: 55,
            },
        ]);

        await expect(
            catalog.search({ query: "   ", offset: 20, limit: 20 }, paper),
        ).resolves.toEqual({
            projects: [
                {
                    projectId: "project-id",
                    title: "Plugin",
                    author: "Author",
                    description: "Description",
                    downloads: 123,
                },
            ],
            offset: 20,
            limit: 20,
            total: 55,
        });

        const url = new URL(String(fetcher.mock.calls[0]?.[0]));
        expect(url.pathname).toBe("/v2/search");
        expect(url.searchParams.get("query")).toBe("");
        expect(url.searchParams.get("index")).toBe("downloads");
        expect(url.searchParams.get("offset")).toBe("20");
        expect(url.searchParams.get("limit")).toBe("20");
        expect(JSON.parse(url.searchParams.get("facets") ?? "null")).toEqual([
            ["project_type:plugin"],
            ["categories:paper", "categories:spigot", "categories:bukkit"],
            ["versions:1.21.4"],
        ]);
    });

    it("uses relevance and only the Velocity loader for a text query", async () => {
        const { catalog, fetcher } = queued([
            { hits: [], offset: 0, limit: 20, total_hits: 0 },
        ]);
        await catalog.search(
            { query: "proxy", offset: 0, limit: 20 },
            {
                serverKind: "velocity",
                // A proxy version is not a Minecraft game-version facet.
                minecraftVersion: "3.4.0",
            },
        );
        const url = new URL(String(fetcher.mock.calls[0]?.[0]));
        expect(url.searchParams.get("index")).toBe("relevance");
        expect(JSON.parse(url.searchParams.get("facets") ?? "null")).toEqual([
            ["project_type:plugin"],
            ["categories:velocity"],
        ]);
    });

    it("lists exact compatible version IDs in newest-first order", async () => {
        const { catalog, fetcher } = queued([
            [
                version({
                    id: "older-release",
                    date_published: "2025-01-01T00:00:00Z",
                }),
                version({
                    id: "new-beta",
                    version_number: "2.0-beta.1",
                    version_type: "beta",
                    date_published: "2026-02-01T00:00:00Z",
                    loaders: ["spigot"],
                }),
                version({ id: "wrong-loader", loaders: ["fabric"] }),
                version({
                    id: "wrong-game",
                    game_versions: ["1.20.6"],
                }),
            ],
        ]);

        await expect(catalog.versions("project/id", paper)).resolves.toEqual([
            {
                versionId: "new-beta",
                label: "2.0-beta.1",
                type: "beta",
                publishedAt: "2026-02-01T00:00:00Z",
            },
            {
                versionId: "older-release",
                label: "1.0",
                type: "release",
                publishedAt: "2025-01-01T00:00:00Z",
            },
        ]);

        const url = new URL(String(fetcher.mock.calls[0]?.[0]));
        expect(url.pathname).toBe("/v2/project/project%2Fid/version");
        expect(JSON.parse(url.searchParams.get("loaders") ?? "null")).toEqual([
            "paper",
            "spigot",
            "bukkit",
        ]);
        expect(
            JSON.parse(url.searchParams.get("game_versions") ?? "null"),
        ).toEqual(["1.21.4"]);
        expect(url.searchParams.get("include_changelog")).toBe("false");
    });

    it.each([
        [{ hits: [{ broken: true }], offset: 0, limit: 20, total_hits: 1 }],
        [[version({ date_published: "not-a-date" })]],
        [[version({ version_type: "snapshot" })]],
    ])("rejects malformed provider metadata", async (payload) => {
        const { catalog } = queued([payload]);
        const result = Array.isArray(payload)
            ? catalog.versions("project-id", paper)
            : catalog.search({ query: "x", offset: 0, limit: 20 }, paper);
        await expect(result).rejects.toMatchObject({
            code: "PROVIDER_METADATA_INVALID",
        });
    });

    it("preserves offline, cancellation, and rate-limit errors", async () => {
        const fetcher = vi.fn<typeof fetch>();
        const catalog = new NodePluginCatalog({ fetch: fetcher });
        await expect(
            catalog.search(
                { query: "", offset: 0, limit: 20 },
                { ...paper, offline: true },
            ),
        ).rejects.toMatchObject({ code: "OFFLINE_MISS" });
        await expect(
            catalog.versions("project-id", {
                ...paper,
                signal: AbortSignal.abort(),
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(fetcher).not.toHaveBeenCalled();

        const limited = queued([new Response(null, { status: 429 })]);
        await expect(
            limited.catalog.search({ query: "", offset: 0, limit: 20 }, paper),
        ).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT" });
    });

    it.each([
        { query: "", offset: -1, limit: 20 },
        { query: "", offset: 0.5, limit: 20 },
        { query: "", offset: 0, limit: 0 },
        { query: "", offset: 0, limit: 101 },
    ])("rejects invalid search bounds", async (request) => {
        const { catalog, fetcher } = queued([]);
        await expect(catalog.search(request, paper)).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
