import { isIP } from "node:net";
import {
    type ArtifactContext,
    CrafletError,
    type SourceSpec,
} from "@craflet/core";

export interface DownloadSpec {
    source: SourceSpec;
    version: string;
    url: string;
    upstreamId?: string;
    size?: number;
    hashes?: Partial<Record<"sha256" | "sha512" | "sha1", string>>;
}

export interface ProviderOptions {
    fetch?: typeof globalThis.fetch;
    userAgent?: string;
    timeoutMs?: number;
    maxMetadataBytes?: number;
}

export function safeDownloadUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new CrafletError(
            "UNSAFE_DOWNLOAD_URL",
            "The provider returned an invalid download URL.",
            3,
        );
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    const parts = host.split(".").map(Number);
    const privateIpv4 =
        isIP(host) === 4 &&
        (parts[0] === 0 ||
            parts[0] === 10 ||
            parts[0] === 127 ||
            (parts[0] ?? 0) >= 224 ||
            (parts[0] === 169 && parts[1] === 254) ||
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 172 &&
                (parts[1] ?? 0) >= 16 &&
                (parts[1] ?? 0) <= 31));
    const privateIpv6 =
        isIP(host) === 6 &&
        (host === "::" ||
            host === "::1" ||
            /^(fc|fd|fe[89ab]|::ffff:)/u.test(host));
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        host === "localhost" ||
        host.endsWith(".localhost") ||
        privateIpv4 ||
        privateIpv6
    ) {
        throw new CrafletError(
            "UNSAFE_DOWNLOAD_URL",
            "Downloads require a public HTTPS URL without credentials or fragments.",
            3,
        );
    }
    return url;
}

export function validated<T>(
    schema: { assert(value: unknown): T },
    value: unknown,
): T {
    try {
        return schema.assert(value);
    } catch {
        throw new CrafletError(
            "PROVIDER_METADATA_INVALID",
            "The provider returned an unexpected metadata format.",
            3,
        );
    }
}

export function noVersion(): never {
    throw new CrafletError(
        "VERSION_NOT_FOUND",
        "No matching release is available for the requested version and platform.",
        3,
        "Choose an explicit compatible version; Craflet does not silently change Minecraft versions.",
    );
}

export function manualDownload(reason: string): never {
    throw new CrafletError(
        "MANUAL_DOWNLOAD_REQUIRED",
        reason,
        3,
        "Download the authorized JAR yourself and use a file: source.",
    );
}

export class ProviderHttp {
    private readonly fetcher: typeof globalThis.fetch;
    private readonly userAgent: string;
    private readonly timeoutMs: number;
    private readonly maxMetadataBytes: number;

    constructor(options: ProviderOptions = {}) {
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.userAgent =
            options.userAgent ??
            "craflet/0.1.0 (https://github.com/sya-ri/craflet)";
        this.timeoutMs = options.timeoutMs ?? 120_000;
        this.maxMetadataBytes = options.maxMetadataBytes ?? 8 * 1024 * 1024;
    }

    async open(
        value: string,
        context: ArtifactContext,
        accept = "application/octet-stream",
    ): Promise<Response> {
        if (context.offline)
            throw new CrafletError(
                "OFFLINE_MISS",
                "This artifact is not available locally. Offline mode forbids network requests.",
                3,
            );
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const signal = context.signal
            ? AbortSignal.any([context.signal, timeout])
            : timeout;
        signal.throwIfAborted();
        let url = safeDownloadUrl(value);
        for (let redirects = 0; redirects <= 5; redirects++) {
            const headers: Record<string, string> = {
                "User-Agent": this.userAgent,
                Accept: accept,
            };
            if (url.hostname === "api.github.com")
                headers["X-GitHub-Api-Version"] = "2022-11-28";
            const response = await this.fetcher(url.href, {
                headers,
                signal,
                redirect: "manual",
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel();
                const location = response.headers.get("location");
                if (!location)
                    throw new CrafletError(
                        "DOWNLOAD_REDIRECT",
                        "Download redirect has no destination.",
                        3,
                    );
                url = safeDownloadUrl(new URL(location, url).href);
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel();
                if (
                    response.status === 429 ||
                    (response.status === 403 &&
                        response.headers.get("x-ratelimit-remaining") === "0")
                ) {
                    throw new CrafletError(
                        "PROVIDER_RATE_LIMIT",
                        `The provider ${url.hostname} rate-limited this request. Retry later.`,
                        3,
                    );
                }
                throw new CrafletError(
                    "DOWNLOAD_HTTP",
                    `The provider ${url.hostname} returned HTTP ${response.status}.`,
                    3,
                    "Only public downloads are supported; private, paid, or external resources may need a file: source.",
                );
            }
            return response;
        }
        throw new CrafletError(
            "DOWNLOAD_REDIRECT",
            "The download exceeded the redirect limit.",
            3,
        );
    }

    async json(url: string, context: ArtifactContext): Promise<unknown> {
        const response = await this.open(url, context, "application/json");
        if (!response.body)
            throw new CrafletError(
                "PROVIDER_METADATA_INVALID",
                "The provider returned no metadata.",
                3,
            );
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                context.signal?.throwIfAborted();
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > this.maxMetadataBytes)
                    throw new CrafletError(
                        "PROVIDER_METADATA_TOO_LARGE",
                        "The metadata response exceeds the size limit.",
                        3,
                    );
                chunks.push(chunk.value);
            }
            try {
                return JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
                throw new CrafletError(
                    "PROVIDER_METADATA_INVALID",
                    "The provider did not return valid JSON.",
                    3,
                );
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
}
