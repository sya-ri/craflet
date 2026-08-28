import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readdir,
    realpath,
    rename,
    rm,
    stat,
} from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactContext,
    type ArtifactStore,
    CrafletError,
    type LockedArtifact,
    type PluginIdentity,
    parseSource,
    type SourceInput,
    type SourceSpec,
} from "@craflet/core";
import picomatch from "picomatch";
import { inspectOptionalPluginJar, inspectPluginJar } from "../formats/jar.js";
import {
    type DownloadSpec,
    manualDownload,
    ProviderHttp,
    type ProviderOptions,
} from "../providers/http.js";
import { resolveRemote } from "../providers/index.js";
import { assertNoSymlinks, exists } from "./io.js";

export interface ArtifactStoreOptions extends ProviderOptions {
    maxArtifactBytes?: number;
    maxGlobEntries?: number;
}

interface StoredBytes {
    sha256: string;
    size: number;
    file: string;
    identity?: PluginIdentity;
}

function verifyLock(artifact: Pick<LockedArtifact, "sha256" | "size">): void {
    if (
        !/^[a-f\d]{64}$/u.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 0
    ) {
        throw new CrafletError(
            "INVALID_ARTIFACT_LOCK",
            "The artifact lock needs a lowercase SHA-256 and a non-negative safe byte size.",
            3,
        );
    }
}

function verifyHashes(hashes: NonNullable<DownloadSpec["hashes"]>): void {
    for (const [algorithm, value] of Object.entries(hashes)) {
        const length = { sha256: 64, sha512: 128, sha1: 40 }[algorithm];
        if (!length || !new RegExp(`^[a-f\\d]{${length}}$`, "iu").test(value)) {
            throw new CrafletError(
                "PROVIDER_METADATA_INVALID",
                "The published checksum is invalid.",
                3,
            );
        }
    }
}

async function* responseBytes(response: Response): AsyncGenerator<Uint8Array> {
    if (!response.body)
        throw new CrafletError(
            "DOWNLOAD_EMPTY",
            "The provider returned no JAR data.",
            3,
        );
    const reader = response.body.getReader();
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            yield chunk.value;
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export class NodeArtifactStore implements ArtifactStore {
    readonly cacheDirectory: string;
    private readonly http: ProviderHttp;
    private readonly maximum: number;
    private readonly maximumGlobEntries: number;

    constructor(home: string, options: ArtifactStoreOptions = {}) {
        this.cacheDirectory = path.resolve(
            home,
            "cache",
            "artifacts",
            "sha256",
        );
        this.http = new ProviderHttp(options);
        this.maximum = options.maxArtifactBytes ?? 512 * 1024 * 1024;
        this.maximumGlobEntries = options.maxGlobEntries ?? 20_000;
    }

    private cachePath(sha256: string): string {
        if (!/^[a-f\d]{64}$/u.test(sha256))
            throw new CrafletError(
                "INVALID_ARTIFACT_LOCK",
                "Invalid SHA-256 cache key.",
                3,
            );
        return path.join(this.cacheDirectory, sha256, "artifact.jar");
    }

    private async cached(
        artifact: Pick<LockedArtifact, "sha256" | "size">,
        context: ArtifactContext,
    ): Promise<string | undefined> {
        verifyLock(artifact);
        context.signal?.throwIfAborted();
        const file = this.cachePath(artifact.sha256);
        await assertNoSymlinks(
            this.cacheDirectory,
            `${artifact.sha256}/artifact.jar`,
        );
        if (!(await exists(file))) return undefined;
        const info = await lstat(file);
        if (!info.isFile() || info.size !== artifact.size)
            throw new CrafletError(
                "CACHE_CORRUPT",
                "A cached artifact has an unexpected size or file type.",
                3,
            );
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(
            file,
            context.signal ? { signal: context.signal } : {},
        ))
            hash.update(chunk);
        if (hash.digest("hex") !== artifact.sha256)
            throw new CrafletError(
                "CACHE_CORRUPT",
                "A cached artifact failed SHA-256 verification.",
                3,
                "Quarantine the corrupted cache entry before retrying; the lock must not be changed to match it.",
            );
        return file;
    }

    private async localFile(
        reference: string,
        context: ArtifactContext,
    ): Promise<string> {
        const absolute = path.resolve(context.projectDir, reference);
        const normalized = absolute.replaceAll("\\", "/");
        const scan = picomatch.scan(normalized);
        let selected = absolute;
        if (scan.isGlob) {
            const matcher = picomatch(normalized, {
                dot: true,
                nocase: process.platform === "win32",
            });
            const matches: string[] = [];
            let visited = 0;
            const walk = async (
                directory: string,
                depth: number,
            ): Promise<void> => {
                if (depth > 64)
                    throw new CrafletError(
                        "LOCAL_GLOB_LIMIT",
                        "The local source glob is too broad.",
                        3,
                    );
                const entries = await readdir(directory, {
                    withFileTypes: true,
                });
                for (const entry of entries) {
                    context.signal?.throwIfAborted();
                    if (++visited > this.maximumGlobEntries)
                        throw new CrafletError(
                            "LOCAL_GLOB_LIMIT",
                            "The local source glob is too broad.",
                            3,
                        );
                    const candidate = path.join(directory, entry.name);
                    if (entry.isSymbolicLink()) continue;
                    if (entry.isDirectory()) await walk(candidate, depth + 1);
                    else if (
                        entry.isFile() &&
                        matcher(candidate.replaceAll("\\", "/"))
                    ) {
                        matches.push(candidate);
                        if (matches.length > 1)
                            throw new CrafletError(
                                "LOCAL_GLOB_AMBIGUOUS",
                                "A local JAR glob must match exactly one file.",
                                3,
                            );
                    }
                }
            };
            const root = scan.base || path.parse(absolute).root;
            if (await exists(root)) await walk(root, 0);
            if (matches.length !== 1 || !matches[0])
                throw new CrafletError(
                    "LOCAL_SOURCE_MISSING",
                    "The local JAR glob matched no files.",
                    3,
                );
            selected = matches[0];
        }
        if (
            !/\.jar$/iu.test(selected) ||
            !(await exists(selected)) ||
            !(await stat(selected)).isFile()
        ) {
            throw new CrafletError(
                "LOCAL_SOURCE_MISSING",
                "The local source must be an existing JAR file.",
                3,
            );
        }
        const canonical = await realpath(selected);
        if ((await stat(canonical)).size > this.maximum)
            throw new CrafletError(
                "ARTIFACT_TOO_LARGE",
                "The local JAR exceeds the artifact size limit.",
                3,
            );
        return canonical;
    }

    private async storeBytes(
        load: () => Promise<AsyncIterable<Uint8Array>>,
        context: ArtifactContext,
        expected: { size?: number; hashes?: DownloadSpec["hashes"] },
        inspect: boolean,
    ): Promise<StoredBytes> {
        const expectedHashes = expected.hashes ?? {};
        verifyHashes(expectedHashes);
        if (expected.size !== undefined && expected.size > this.maximum)
            throw new CrafletError(
                "ARTIFACT_TOO_LARGE",
                "The artifact exceeds the configured size limit.",
                3,
            );
        if (expectedHashes.sha256 && expected.size !== undefined) {
            const file = await this.cached(
                {
                    sha256: expectedHashes.sha256.toLowerCase(),
                    size: expected.size,
                },
                context,
            );
            if (file) {
                const plugin = inspect
                    ? await inspectOptionalPluginJar(file, {
                          serverKind: context.serverKind,
                      })
                    : undefined;
                return {
                    sha256: expectedHashes.sha256.toLowerCase(),
                    size: expected.size,
                    file,
                    ...(plugin ? { identity: plugin } : {}),
                };
            }
        }
        await assertNoSymlinks(this.cacheDirectory);
        await mkdir(this.cacheDirectory, { recursive: true });
        const temporary = await mkdtemp(
            path.join(this.cacheDirectory, ".tmp-"),
        );
        const file = path.join(temporary, "artifact.jar");
        try {
            const handle = await open(file, "wx", 0o600);
            const hashes = {
                sha256: createHash("sha256"),
                sha512: createHash("sha512"),
                sha1: createHash("sha1"),
            };
            let size = 0;
            try {
                for await (const chunk of await load()) {
                    context.signal?.throwIfAborted();
                    size += chunk.byteLength;
                    if (
                        size > this.maximum ||
                        (expected.size !== undefined && size > expected.size)
                    )
                        throw new CrafletError(
                            "ARTIFACT_TOO_LARGE",
                            "The downloaded JAR exceeds its declared or configured size.",
                            3,
                        );
                    for (const hash of Object.values(hashes))
                        hash.update(chunk);
                    await handle.writeFile(chunk);
                }
                if (expected.size !== undefined && size !== expected.size)
                    throw new CrafletError(
                        "ARTIFACT_SIZE_MISMATCH",
                        "The JAR size differs from the locked or published size.",
                        3,
                    );
                await handle.sync();
            } finally {
                await handle.close();
            }
            const digests = {
                sha256: hashes.sha256.digest("hex"),
                sha512: hashes.sha512.digest("hex"),
                sha1: hashes.sha1.digest("hex"),
            };
            for (const [algorithm, value] of Object.entries(expectedHashes)) {
                if (
                    digests[algorithm as keyof typeof digests] !==
                    value.toLowerCase()
                )
                    throw new CrafletError(
                        "ARTIFACT_HASH_MISMATCH",
                        "The JAR differs from the locked or published checksum.",
                        3,
                    );
            }
            const plugin = inspect
                ? await inspectOptionalPluginJar(file, {
                      serverKind: context.serverKind,
                  })
                : undefined;
            const destination = this.cachePath(digests.sha256);
            await assertNoSymlinks(this.cacheDirectory, digests.sha256);
            await chmod(file, 0o444);
            try {
                await rename(temporary, path.dirname(destination));
            } catch (error) {
                // Directory publication cannot replace an existing nonempty generation.
                const existing = await this.cached(
                    { sha256: digests.sha256, size },
                    context,
                );
                if (!existing) throw error;
            }
            return {
                sha256: digests.sha256,
                size,
                file: destination,
                ...(plugin ? { identity: plugin } : {}),
            };
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }

    private async download(
        spec: DownloadSpec,
        context: ArtifactContext,
        inspect: boolean,
    ): Promise<StoredBytes> {
        try {
            return await this.storeBytes(
                async () => {
                    const response = await this.http.open(spec.url, context);
                    return responseBytes(response);
                },
                context,
                {
                    ...(spec.size === undefined ? {} : { size: spec.size }),
                    ...(spec.hashes ? { hashes: spec.hashes } : {}),
                },
                inspect,
            );
        } catch (error) {
            if (
                spec.source.provider === "spigotmc" &&
                error instanceof CrafletError &&
                ["DOWNLOAD_HTTP", "INVALID_JAR"].includes(error.code)
            )
                return manualDownload(
                    "Spiget cannot supply this archived JAR automatically.",
                );
            throw error;
        }
    }

    async resolve(
        input: SourceInput,
        context: ArtifactContext,
    ): Promise<LockedArtifact> {
        context.signal?.throwIfAborted();
        const source = parseSource(input);
        if (source.provider === "file") {
            const local = await this.localFile(source.path, context);
            const bytes = await this.storeBytes(
                async () =>
                    createReadStream(
                        local,
                        context.signal ? { signal: context.signal } : {},
                    ),
                context,
                {},
                true,
            );
            return {
                source,
                version: bytes.identity?.version ?? "local",
                sha256: bytes.sha256,
                size: bytes.size,
                ...(bytes.identity ? { identity: bytes.identity } : {}),
            };
        }
        const spec = await resolveRemote(this.http, source, context);
        const bytes = await this.download(spec, context, true);
        return {
            source: spec.source,
            version: spec.version,
            sha256: bytes.sha256,
            size: bytes.size,
            url: spec.url,
            ...(spec.upstreamId ? { upstreamId: spec.upstreamId } : {}),
            ...(bytes.identity ? { identity: bytes.identity } : {}),
        };
    }

    async ensure(
        artifact: LockedArtifact,
        context: ArtifactContext,
    ): Promise<string> {
        const cached = await this.cached(artifact, context);
        if (cached) return cached;
        const source = parseSource(artifact.source);
        if (source.provider === "file") {
            const file = await this.localFile(source.path, context);
            const bytes = await this.storeBytes(
                async () =>
                    createReadStream(
                        file,
                        context.signal ? { signal: context.signal } : {},
                    ),
                context,
                { size: artifact.size, hashes: { sha256: artifact.sha256 } },
                false,
            );
            return bytes.file;
        }
        if (!artifact.url)
            throw new CrafletError(
                "LOCKED_URL_MISSING",
                "This lock has no exact download URL. Resolve it online before deployment.",
                3,
            );
        // Never resolve the source again here: an upstream tag or latest release can move.
        return (
            await this.download(
                {
                    source,
                    version: artifact.version,
                    url: artifact.url,
                    size: artifact.size,
                    hashes: { sha256: artifact.sha256 },
                },
                context,
                false,
            )
        ).file;
    }

    inspect(file: string): Promise<PluginIdentity> {
        return inspectPluginJar(file);
    }

    async latest(
        input: SourceInput,
        context: ArtifactContext,
    ): Promise<SourceSpec> {
        const source = parseSource(input);
        if (source.provider === "file") return source;
        const requested =
            source.provider === "paper"
                ? { ...source, build: "latest" }
                : { ...source, version: "latest" };
        return (await resolveRemote(this.http, requested, context)).source;
    }
}
