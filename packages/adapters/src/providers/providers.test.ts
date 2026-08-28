import { type ArtifactContext, parseSource } from "@craflet/core";
import { describe, expect, it, vi } from "vitest";
import { ProviderHttp } from "./http.js";
import { resolveRemote } from "./index.js";

const context: ArtifactContext = {
    projectDir: "/unused",
    serverKind: "paper",
    minecraftVersion: "1.21.4",
};
const sha256 = "a".repeat(64);
const sha512 = "b".repeat(128);
function queued(values: unknown[]) {
    const fetcher = vi.fn<typeof fetch>(
        async () =>
            new Response(JSON.stringify(values.shift()), {
                headers: { "content-type": "application/json" },
            }),
    );
    return { http: new ProviderHttp({ fetch: fetcher }), fetcher };
}
function resolve(http: ProviderHttp, input: string, options = context) {
    const source = parseSource(input);
    if (source.provider === "file") throw new Error("Fixture must be remote");
    return resolveRemote(http, source, options);
}
function modrinth(extra: Record<string, unknown> = {}) {
    return {
        id: "fixed-id",
        project_id: "fixed-project",
        version_number: "1.0",
        version_type: "release",
        date_published: "2026-01-01",
        loaders: ["paper"],
        game_versions: ["1.21.4"],
        files: [
            {
                filename: "Plugin.jar",
                url: "https://cdn.modrinth.com/plugin.jar",
                primary: true,
                size: 100,
                hashes: { sha512 },
            },
        ],
        ...extra,
    };
}
function github(extra: Record<string, unknown> = {}) {
    return {
        id: 12,
        tag_name: "release/1",
        draft: false,
        prerelease: false,
        assets: [
            {
                id: 34,
                name: "Plugin.jar",
                size: 100,
                browser_download_url:
                    "https://github.com/u/r/releases/download/release%2F1/Plugin.jar",
                digest: `sha256:${sha256}`,
                state: "uploaded",
            },
        ],
        ...extra,
    };
}
function hangar(extra: Record<string, unknown> = {}) {
    return {
        id: 22,
        projectId: 11,
        name: "1.0",
        createdAt: "2026-01-01",
        channel: { name: "Release" },
        downloads: {
            PAPER: {
                downloadUrl: "https://hangarcdn.papermc.io/plugin.jar",
                externalUrl: null,
                fileInfo: {
                    name: "Plugin.jar",
                    sizeBytes: 100,
                    sha256Hash: sha256,
                },
            },
        },
        platformDependencies: { PAPER: ["1.21.4"], VELOCITY: ["3.4"] },
        ...extra,
    };
}
function build(id: number, channel = "STABLE") {
    return {
        id,
        channel,
        downloads: {
            "server:default": {
                url: "https://fill-data.papermc.io/server.jar",
                size: 100,
                checksums: { sha256 },
            },
        },
    };
}

describe("Modrinth provider", () => {
    it("pins stable project/version IDs and the selected primary JAR", async () => {
        const { http, fetcher } = queued([
            [
                modrinth({
                    id: "wrong-mc",
                    date_published: "2026-04-01",
                    game_versions: ["26.2"],
                }),
                modrinth({
                    id: "beta",
                    date_published: "2026-03-01",
                    version_type: "beta",
                }),
                modrinth({ id: "older", date_published: "2025-12-01" }),
                modrinth(),
            ],
        ]);
        expect(await resolve(http, "modrinth:slug@latest")).toMatchObject({
            source: {
                provider: "modrinth",
                project: "fixed-project",
                version: "fixed-id",
            },
            version: "1.0",
            hashes: { sha512 },
        });
        const url = new URL(String(fetcher.mock.calls[0]?.[0]));
        expect(
            JSON.parse(url.searchParams.get("game_versions") ?? "null"),
        ).toEqual(["1.21.4"]);
        expect(JSON.parse(url.searchParams.get("loaders") ?? "null")).toEqual([
            "paper",
            "spigot",
            "bukkit",
        ]);
    });
    it("fetches an explicit version without consulting latest", async () => {
        const { http, fetcher } = queued([modrinth({ loaders: ["velocity"] })]);
        await resolve(http, "modrinth:slug@v1", {
            projectDir: "/unused",
            serverKind: "velocity",
        });
        expect(String(fetcher.mock.calls[0]?.[0])).toBe(
            "https://api.modrinth.com/v2/project/slug/version/v1",
        );
    });
    it("allows a unique non-primary JAR but rejects multiple candidates", async () => {
        const jar = {
            filename: "plugin.jar",
            url: "https://cdn.modrinth.com/p.jar",
            primary: false,
            size: 5,
            hashes: { sha1: "c".repeat(40) },
        };
        await expect(
            resolve(queued([modrinth({ files: [jar] })]).http, "modrinth:p@v"),
        ).resolves.toMatchObject({ hashes: { sha1: "c".repeat(40) } });
        await expect(
            resolve(
                queued([
                    modrinth({
                        files: [jar, { ...jar, filename: "other.jar" }],
                    }),
                ]).http,
                "modrinth:p@v",
            ),
        ).rejects.toMatchObject({ code: "AMBIGUOUS_ARTIFACT" });
    });
    it.each([
        [modrinth({ loaders: ["fabric"] }), "VERSION_NOT_FOUND"],
        [modrinth({ game_versions: ["1.20"] }), "VERSION_NOT_FOUND"],
        [
            modrinth({
                files: [
                    {
                        filename: "a.jar",
                        url: "https://cdn.modrinth.com/a.jar",
                        primary: true,
                        size: 1,
                        hashes: {},
                    },
                ],
            }),
            "PROVIDER_METADATA_INVALID",
        ],
        [{ broken: true }, "PROVIDER_METADATA_INVALID"],
    ])("rejects unusable exact releases", async (value, code) => {
        await expect(
            resolve(queued([value]).http, "modrinth:p@v"),
        ).rejects.toMatchObject({ code });
    });
    it("does not upgrade to a different Minecraft version when none match", async () => {
        await expect(
            resolve(queued([[]]).http, "modrinth:p@latest"),
        ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    });
});

describe("GitHub provider", () => {
    it("encodes a tag containing slash and pins release/asset IDs", async () => {
        const { http, fetcher } = queued([github()]);
        expect(
            await resolve(http, "github:u/r@release/1#Plugin.jar"),
        ).toMatchObject({
            upstreamId: "12:34",
            version: "release/1",
            hashes: { sha256 },
        });
        expect(String(fetcher.mock.calls[0]?.[0])).toContain(
            "/tags/release%2F1",
        );
        expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
            "X-GitHub-Api-Version": "2022-11-28",
        });
    });
    it("supports historical assets without a publisher digest", async () => {
        const data = github();
        const { http } = queued([
            {
                ...data,
                assets: data.assets.map((asset) => ({
                    ...asset,
                    digest: null,
                })),
            },
        ]);
        expect(
            (await resolve(http, "github:u/r@latest#Plugin.jar")).hashes,
        ).toEqual({});
    });
    it.each([
        [github({ draft: true }), "VERSION_NOT_FOUND"],
        [github({ prerelease: true }), "VERSION_NOT_FOUND"],
        [github({ assets: [] }), "AMBIGUOUS_ARTIFACT"],
        [
            github({
                assets: github().assets.map((asset) => ({
                    ...asset,
                    digest: "md5:invalid",
                })),
            }),
            "PROVIDER_METADATA_INVALID",
        ],
    ])(
        "rejects missing, draft, prerelease, or malformed latest assets",
        async (value, code) => {
            await expect(
                resolve(queued([value]).http, "github:u/r@latest#Plugin.jar"),
            ).rejects.toMatchObject({ code });
        },
    );
});

describe("Hangar provider", () => {
    it("uses the current ownerless API and pins version ID/platform", async () => {
        const { http, fetcher } = queued([
            { id: 11, namespace: { owner: "Owner" } },
            { result: [hangar()] },
        ]);
        expect(await resolve(http, "hangar:Owner/Plugin@latest")).toMatchObject(
            {
                source: { provider: "hangar", project: "11", version: "22" },
                upstreamId: "22:PAPER",
                hashes: { sha256 },
            },
        );
        const url = new URL(String(fetcher.mock.calls[1]?.[0]));
        expect(url.pathname).toBe("/api/v1/projects/11/versions");
        expect(url.searchParams.get("platformVersion")).toBe("1.21.4");
        expect(url.searchParams.get("includeHiddenChannels")).toBe("false");
    });
    it("chooses the target platform without treating Minecraft version as Velocity version", async () => {
        const data = hangar();
        const { http } = queued([
            { ...data, downloads: { VELOCITY: data.downloads.PAPER } },
        ]);
        expect(
            (
                await resolve(http, "hangar:11@22", {
                    ...context,
                    serverKind: "velocity",
                })
            ).upstreamId,
        ).toBe("22:VELOCITY");
    });
    it.each([
        [hangar({ downloads: {} }), "VERSION_NOT_FOUND"],
        [
            hangar({ platformDependencies: { PAPER: ["1.20"] } }),
            "VERSION_NOT_FOUND",
        ],
        [
            hangar({
                downloads: { PAPER: { externalUrl: "https://example.com" } },
            }),
            "MANUAL_DOWNLOAD_REQUIRED",
        ],
        [
            hangar({
                downloads: {
                    PAPER: {
                        downloadUrl: "https://example.com/a.zip",
                        fileInfo: {
                            name: "a.zip",
                            sizeBytes: 1,
                            sha256Hash: sha256,
                        },
                    },
                },
            }),
            "MANUAL_DOWNLOAD_REQUIRED",
        ],
    ])(
        "rejects missing compatibility or automatic download",
        async (value, code) => {
            await expect(
                resolve(queued([value]).http, "hangar:11@22"),
            ).rejects.toMatchObject({ code });
        },
    );
    it("refuses wrong owners and unavailable release channels", async () => {
        await expect(
            resolve(
                queued([{ id: 11, namespace: { owner: "Other" } }]).http,
                "hangar:Owner/Plugin@v",
            ),
        ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
        await expect(
            resolve(queued([]).http, "hangar:a/b/c@v"),
        ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
        await expect(
            resolve(
                queued([{ result: [hangar({ channel: { name: "Beta" } })] }])
                    .http,
                "hangar:11@latest",
            ),
        ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    });
});

describe("SpigotMC via Spiget", () => {
    const resource = {
        id: 42,
        testedVersions: ["1.21"],
        file: { type: ".jar" },
    };
    it("uses the API latest order and never sorts opaque labels as SemVer", async () => {
        const { http } = queued([
            resource,
            {
                id: 90,
                uuid: "12345678-abcd-abcd-abcd-123456789abc",
                name: "final release (new)",
            },
        ]);
        expect(await resolve(http, "spigotmc:42@latest")).toMatchObject({
            source: {
                resource: "42",
                version: "12345678-abcd-abcd-abcd-123456789abc",
            },
            version: "final release (new)",
        });
    });
    it("pins numeric IDs and finds exact non-SemVer labels", async () => {
        const { http } = queued([resource, { id: 90, name: "opaque" }]);
        expect((await resolve(http, "spigotmc:42@90")).source).toEqual({
            provider: "spigotmc",
            resource: "42",
            version: "90",
        });
        const named = queued([
            resource,
            [
                { id: 90, name: "release-old" },
                { id: 91, name: "release-new" },
            ],
        ]);
        expect(
            (await resolve(named.http, "spigotmc:42@release-new")).upstreamId,
        ).toBe("91");
    });
    it.each([
        { ...resource, premium: true },
        { ...resource, external: true },
        { ...resource, file: { external: true } },
        { ...resource, file: { type: ".zip" } },
    ])("requires manual authorized download when needed", async (value) => {
        const { http, fetcher } = queued([value]);
        await expect(resolve(http, "spigotmc:42@90")).rejects.toMatchObject({
            code: "MANUAL_DOWNLOAD_REQUIRED",
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("does not pretend compatibility or label uniqueness is guaranteed", async () => {
        await expect(
            resolve(queued([{ id: 42 }]).http, "spigotmc:42@latest"),
        ).rejects.toMatchObject({ code: "COMPATIBILITY_UNVERIFIED" });
        await expect(
            resolve(
                queued([
                    resource,
                    [
                        { id: 1, name: "same" },
                        { id: 2, name: "same" },
                    ],
                ]).http,
                "spigotmc:42@same",
            ),
        ).rejects.toMatchObject({ code: "AMBIGUOUS_VERSION" });
        await expect(
            resolve(
                queued([resource, { name: "no-id" }]).http,
                "spigotmc:42@90",
            ),
        ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    });
    it("bounds label pagination and permits explicit versions without compatibility metadata", async () => {
        const page = Array.from({ length: 100 }, (_, id) => ({
            id,
            name: `release-${id}`,
        }));
        await expect(
            resolve(
                queued([resource, ...Array.from({ length: 10 }, () => page)])
                    .http,
                "spigotmc:42@absent",
            ),
        ).rejects.toMatchObject({ code: "VERSION_LOOKUP_LIMIT" });
        expect(
            (
                await resolve(
                    queued([{ id: 42 }, { id: 1, name: "v1" }]).http,
                    "spigotmc:42@latest",
                    { projectDir: "/unused", serverKind: "paper" },
                )
            ).version,
        ).toBe("v1");
    });
});

describe("Paper Fill v3 / Velocity", () => {
    it("selects the newest stable build within the current Minecraft version", async () => {
        const { http, fetcher } = queued([
            [build(5), build(6, "EXPERIMENTAL"), build(4)],
        ]);
        expect(await resolve(http, "paper:latest@latest")).toMatchObject({
            source: {
                provider: "paper",
                project: "paper",
                version: "1.21.4",
                build: "5",
            },
            hashes: { sha256 },
        });
        expect(String(fetcher.mock.calls[0]?.[0])).toContain(
            "/versions/1.21.4/builds",
        );
    });
    it("allows an intentionally pinned build and resolves Velocity stable software versions", async () => {
        expect(
            (
                await resolve(
                    queued([[build(6, "EXPERIMENTAL")]]).http,
                    "paper:1.21.4@6",
                )
            ).source,
        ).toMatchObject({ build: "6" });
        const { http, fetcher } = queued([
            { versions: { "4": ["4.2.0-SNAPSHOT", "4.1.1"] } },
            [build(10)],
        ]);
        expect(
            (
                await resolve(http, "velocity:latest@latest", {
                    projectDir: "/unused",
                    serverKind: "velocity",
                })
            ).source,
        ).toEqual({
            provider: "paper",
            project: "velocity",
            version: "4.1.1",
            build: "10",
        });
        expect(String(fetcher.mock.calls[1]?.[0])).toContain(
            "/versions/4.1.1/builds",
        );
    });
    it("does not silently move Minecraft versions when no stable build exists", async () => {
        await expect(
            resolve(
                queued([[build(3, "EXPERIMENTAL")]]).http,
                "paper:1.21.4@latest",
            ),
        ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
        await expect(
            resolve(queued([{ versions: {} }]).http, "velocity:latest@latest"),
        ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    });
});
