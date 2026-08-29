import { createHash } from "node:crypto";
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeArtifactStore } from "../../packages/adapters/src/filesystem/artifact-store.js";
import type {
    ArtifactContext,
    LockedArtifact,
} from "../../packages/core/src/domain/artifacts.js";
import { artifactJar, artifactZip } from "./artifacts-fixture.js";

describe("artifact resolution and immutable cache", () => {
    let directory: string;
    let context: ArtifactContext;
    let home: string;
    beforeEach(async () => {
        directory = await realpath(
            await mkdtemp(path.join(os.tmpdir(), "craflet-artifacts-store-")),
        );
        home = path.join(directory, "home");
        context = {
            projectDir: directory,
            serverKind: "paper",
            minecraftVersion: "1.21.4",
        };
    });
    afterEach(async () => {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    function sha256(bytes: Buffer) {
        return createHash("sha256").update(bytes).digest("hex");
    }
    function locked(bytes: Buffer): LockedArtifact {
        return {
            source: {
                provider: "github",
                owner: "u",
                repo: "r",
                version: "v1",
                asset: "Plugin.jar",
            },
            version: "v1",
            sha256: sha256(bytes),
            size: bytes.length,
            url: "https://github.com/u/r/releases/download/v1/Plugin.jar",
        };
    }
    async function noTemps(store: NodeArtifactStore) {
        const entries = await readdir(store.cacheDirectory).catch(() => []);
        expect(entries.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    }

    it("keeps old locked local bytes while only resolve observes source changes", async () => {
        const original = artifactJar("Example", "1.0");
        await writeFile(path.join(directory, "Plugin.jar"), original);
        const store = new NodeArtifactStore(home, {
            fetch: vi.fn<typeof fetch>(),
        });
        const first = await store.resolve("file:Plugin.jar", context);
        expect(first).toMatchObject({
            sha256: sha256(original),
            size: original.length,
            version: "1.0",
            identity: { id: "Example" },
        });
        const oldPath = await store.ensure(first, context);
        const replacement = artifactJar("Example", "2.0");
        await writeFile(path.join(directory, "Plugin.jar"), replacement);
        expect(
            await readFile(
                await store.ensure(first, { ...context, offline: true }),
            ),
        ).toEqual(original);
        expect(
            await store.latest("file:Plugin.jar", {
                ...context,
                offline: true,
            }),
        ).toEqual({
            source: { provider: "file", path: "Plugin.jar" },
            version: "local",
        });
        const updated = await store.resolve("file:Plugin.jar", context);
        expect(updated.sha256).not.toBe(first.sha256);
        expect(updated.version).toBe("2.0");
        expect((await store.inspect(oldPath)).version).toBe("1.0");
        await noTemps(store);
    });

    it("rehydrates local locks offline only if the original bytes are supplied", async () => {
        const original = artifactJar("Example", "1.0");
        await writeFile(path.join(directory, "Plugin.jar"), original);
        const artifact = await new NodeArtifactStore(home).resolve(
            "file:Plugin.jar",
            context,
        );
        const restore = new NodeArtifactStore(path.join(directory, "restore"));
        await writeFile(
            path.join(directory, "Plugin.jar"),
            artifactJar("Example", "2.0"),
        );
        await expect(
            restore.ensure(artifact, { ...context, offline: true }),
        ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
        await noTemps(restore);
        await writeFile(path.join(directory, "Plugin.jar"), original);
        expect(
            await readFile(
                await restore.ensure(artifact, { ...context, offline: true }),
            ),
        ).toEqual(original);
    });

    it("requires exactly one file for local globs and rejects missing/non-JAR sources", async () => {
        await mkdir(path.join(directory, "build"));
        await writeFile(
            path.join(directory, "build", "one.jar"),
            artifactJar(),
        );
        const store = new NodeArtifactStore(home);
        expect(
            (await store.resolve("file:build/*.jar", context)).identity?.id,
        ).toBe("Example");
        await writeFile(
            path.join(directory, "build", "two.jar"),
            artifactJar("Other"),
        );
        await expect(
            store.resolve("file:build/*.jar", context),
        ).rejects.toMatchObject({ code: "LOCAL_GLOB_AMBIGUOUS" });
        await expect(
            store.resolve("file:absent/*.jar", context),
        ).rejects.toMatchObject({ code: "LOCAL_SOURCE_MISSING" });
        await expect(
            store.resolve("file:build/*.zip", context),
        ).rejects.toMatchObject({ code: "LOCAL_SOURCE_MISSING" });
        await expect(
            store.resolve("file:missing.jar", context),
        ).rejects.toMatchObject({ code: "LOCAL_SOURCE_MISSING" });
        await expect(
            store.resolve("file:build", context),
        ).rejects.toMatchObject({ code: "LOCAL_SOURCE_MISSING" });
        await expect(
            new NodeArtifactStore(home, { maxGlobEntries: 0 }).resolve(
                "file:build/*.jar",
                context,
            ),
        ).rejects.toMatchObject({ code: "LOCAL_GLOB_LIMIT" });
        await expect(
            new NodeArtifactStore(home, { maxArtifactBytes: 1 }).resolve(
                "file:build/one.jar",
                context,
            ),
        ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    });

    it("publishes identical bytes concurrently without overwriting or leaving temporary files", async () => {
        await writeFile(path.join(directory, "Plugin.jar"), artifactJar());
        const store = new NodeArtifactStore(home);
        const other = new NodeArtifactStore(home);
        const [first, second] = await Promise.all([
            store.resolve("file:Plugin.jar", context),
            other.resolve("file:Plugin.jar", context),
        ]);
        expect(first.sha256).toBe(second.sha256);
        expect(await store.ensure(first, context)).toBe(
            await other.ensure(second, context),
        );
        expect(await readdir(store.cacheDirectory)).toEqual([first.sha256]);
    });

    it("resolves public Modrinth metadata, verifies its SHA-512, and records SHA-256", async () => {
        const bytes = artifactJar();
        const metadata = {
            id: "version-id",
            project_id: "project-id",
            version_number: "v1",
            version_type: "release",
            date_published: "2026-01-01",
            loaders: ["paper"],
            game_versions: ["1.21.4"],
            files: [
                {
                    filename: "Plugin.jar",
                    primary: true,
                    size: bytes.length,
                    url: "https://cdn.modrinth.com/plugin.jar",
                    hashes: {
                        sha512: createHash("sha512")
                            .update(bytes)
                            .digest("hex"),
                    },
                },
            ],
        };
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            String(url).includes("api.modrinth.com")
                ? new Response(
                      JSON.stringify(
                          String(url).includes("?") ? [metadata] : metadata,
                      ),
                  )
                : new Response(bytes),
        );
        const store = new NodeArtifactStore(home, { fetch: fetcher });
        const result = await store.resolve("modrinth:slug@v1", context);
        expect(result).toMatchObject({
            source: {
                provider: "modrinth",
                project: "project-id",
                version: "version-id",
            },
            sha256: sha256(bytes),
            identity: { id: "Example" },
        });
        expect(await store.latest("modrinth:slug@v1", context)).toEqual({
            source: {
                provider: "modrinth",
                project: "project-id",
                version: "version-id",
            },
            version: "v1",
        });
        expect(fetcher).toHaveBeenCalledTimes(3);
        const missingSourceStore = new NodeArtifactStore(home, {
            fetch: vi.fn<typeof fetch>(),
        });
        expect(
            await readFile(
                await missingSourceStore.ensure(result, {
                    ...context,
                    offline: true,
                }),
            ),
        ).toEqual(bytes);
    });

    it("rehydrates remote locks directly by exact URL, without version resolution", async () => {
        const bytes = artifactJar();
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(bytes));
        const store = new NodeArtifactStore(home, { fetch: fetcher });
        expect(
            await readFile(await store.ensure(locked(bytes), context)),
        ).toEqual(bytes);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0]?.[0]).toBe(locked(bytes).url);
    });

    it("never requests the network offline, and never silently invents a missing lock URL", async () => {
        const fetcher = vi.fn<typeof fetch>();
        const store = new NodeArtifactStore(home, { fetch: fetcher });
        const artifact = locked(artifactJar());
        await expect(
            store.ensure(artifact, { ...context, offline: true }),
        ).rejects.toMatchObject({ code: "OFFLINE_MISS" });
        await expect(
            store.resolve("modrinth:slug@v1", { ...context, offline: true }),
        ).rejects.toMatchObject({ code: "OFFLINE_MISS" });
        await expect(
            store.latest("github:u/r@v1#Plugin.jar", {
                ...context,
                offline: true,
            }),
        ).rejects.toMatchObject({ code: "OFFLINE_MISS" });
        const { url: _url, ...missingUrl } = artifact;
        await expect(store.ensure(missingUrl, context)).rejects.toMatchObject({
            code: "LOCKED_URL_MISSING",
        });
        expect(fetcher).not.toHaveBeenCalled();
        await noTemps(store);
    });

    it.each(["hash", "short", "long", "limit", "empty", "stream-error"])(
        "cleans partial downloads after %s failure",
        async (failure) => {
            const bytes = artifactJar();
            const artifact = locked(bytes);
            let response: Response;
            if (failure === "empty") response = new Response(null);
            else if (failure === "stream-error")
                response = new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.error(new Error("connection dropped"));
                        },
                    }),
                );
            else
                response = new Response(
                    failure === "hash"
                        ? artifactJar("Changed")
                        : failure === "short"
                          ? bytes.subarray(0, bytes.length - 1)
                          : failure === "long"
                            ? Buffer.concat([bytes, Buffer.from("extra")])
                            : bytes,
                );
            const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
            const store = new NodeArtifactStore(home, {
                fetch: fetcher,
                ...(failure === "limit" ? { maxArtifactBytes: 1 } : {}),
            });
            await expect(
                store.ensure(artifact, context),
            ).rejects.toBeInstanceOf(Error);
            await noTemps(store);
        },
    );

    it("detects same-size cache tampering and unsafe lock keys", async () => {
        const bytes = artifactJar();
        await writeFile(path.join(directory, "Plugin.jar"), bytes);
        const store = new NodeArtifactStore(home);
        const artifact = await store.resolve("file:Plugin.jar", context);
        const file = await store.ensure(artifact, context);
        await chmod(file, 0o600);
        await writeFile(file, Buffer.alloc(bytes.length));
        await expect(store.ensure(artifact, context)).rejects.toMatchObject({
            code: "CACHE_CORRUPT",
        });
        await writeFile(file, "truncated");
        await expect(store.ensure(artifact, context)).rejects.toMatchObject({
            code: "CACHE_CORRUPT",
        });
        await expect(
            store.ensure({ ...artifact, sha256: "../escape" }, context),
        ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_LOCK" });
        await expect(
            store.ensure({ ...artifact, size: -1 }, context),
        ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_LOCK" });
    });

    it("refuses managed cache symlinks", async () => {
        const target = path.join(directory, "outside");
        await mkdir(target);
        await mkdir(path.join(home, "cache", "artifacts"), { recursive: true });
        await symlink(
            target,
            path.join(home, "cache", "artifacts", "sha256"),
            "junction",
        );
        await expect(
            new NodeArtifactStore(home).ensure(locked(artifactJar()), context),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
    });

    it("honors cancellation and releases partial streams", async () => {
        const controller = new AbortController();
        const cancelled = vi.fn();
        const bytes = artifactJar();
        const fetcher = vi.fn<typeof fetch>(
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        pull(stream) {
                            controller.abort();
                            stream.enqueue(bytes);
                        },
                        cancel: cancelled,
                    }),
                ),
        );
        const store = new NodeArtifactStore(home, { fetch: fetcher });
        await expect(
            store.ensure(locked(bytes), {
                ...context,
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(cancelled).toHaveBeenCalled();
        await noTemps(store);
    });

    it("allows server JARs without plugin metadata but refuses invalid JARs", async () => {
        await writeFile(
            path.join(directory, "server.jar"),
            artifactZip([
                { name: "Main.class", content: "fake class fixture" },
            ]),
        );
        const store = new NodeArtifactStore(home);
        expect(
            (await store.resolve("file:server.jar", context)).identity,
        ).toBeUndefined();
        await writeFile(path.join(directory, "server.jar"), "not a zip");
        await expect(
            store.resolve("file:server.jar", context),
        ).rejects.toMatchObject({ code: "INVALID_JAR" });
        await noTemps(store);
    });

    it("resolves latest into an exact source without downloading any JAR", async () => {
        const bytes = artifactJar();
        const build = {
            id: 10,
            channel: "STABLE",
            downloads: {
                "server:default": {
                    url: "https://fill-data.papermc.io/server.jar",
                    size: bytes.length,
                    checksums: { sha256: sha256(bytes) },
                },
            },
        };
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            String(url).includes("/builds")
                ? new Response(JSON.stringify([build]))
                : new Response(bytes),
        );
        const store = new NodeArtifactStore(home, { fetch: fetcher });
        expect(await store.latest("paper:1.21.4@1", context)).toEqual({
            source: {
                provider: "paper",
                project: "paper",
                version: "1.21.4",
                build: "10",
            },
            version: "10",
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await store.resolve("paper:1.21.4@10", context);
        const before = fetcher.mock.calls.length;
        await store.resolve("paper:1.21.4@10", context);
        expect(fetcher.mock.calls.length - before).toBe(1);
    });
});
