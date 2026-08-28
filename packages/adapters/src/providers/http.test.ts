import type { ArtifactContext } from "@craflet/core";
import { describe, expect, it, vi } from "vitest";
import { ProviderHttp, safeDownloadUrl } from "./http.js";

const context: ArtifactContext = { projectDir: "/unused", serverKind: "paper" };

describe("provider HTTP boundary", () => {
    it.each([
        "not a url",
        "http://example.com/a",
        "https://user:secret@example.com/a",
        "https://example.com/a#fragment",
        "https://localhost/a",
        "https://a.localhost/a",
        "https://127.0.0.1/a",
        "https://10.1.2.3/a",
        "https://0.0.0.0/a",
        "https://169.254.169.254/a",
        "https://192.168.1.1/a",
        "https://172.16.0.1/a",
        "https://224.0.0.1/a",
        "https://[::1]/a",
        "https://[fd00::1]/a",
        "https://[fe80::1]/a",
        "https://[::ffff:127.0.0.1]/a",
    ])("rejects unsafe URL %s", (url) => {
        expect(() => safeDownloadUrl(url)).toThrowError(
            expect.objectContaining({ code: "UNSAFE_DOWNLOAD_URL" }),
        );
    });
    it("allows public HTTPS URLs", () => {
        expect(
            safeDownloadUrl("https://example.com/a?signature=test").hostname,
        ).toBe("example.com");
        expect(safeDownloadUrl("https://8.8.8.8/a").hostname).toBe("8.8.8.8");
        expect(safeDownloadUrl("https://[2606:4700::1111]/a").protocol).toBe(
            "https:",
        );
    });
    it("forbids every request in offline mode and honors an already aborted signal", async () => {
        const fetcher = vi.fn<typeof fetch>();
        const http = new ProviderHttp({ fetch: fetcher });
        await expect(
            http.json("https://example.com", { ...context, offline: true }),
        ).rejects.toMatchObject({ code: "OFFLINE_MISS" });
        await expect(
            http.open("https://example.com", {
                ...context,
                signal: AbortSignal.abort(),
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("validates each redirect and supplies a contact User-Agent", async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: "/next" },
                }),
            )
            .mockResolvedValueOnce(new Response("ok"));
        const http = new ProviderHttp({ fetch: fetcher });
        expect(
            await (
                await http.open("https://example.com/start", context)
            ).text(),
        ).toBe("ok");
        expect(fetcher.mock.calls[1]?.[0]).toBe("https://example.com/next");
        expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
            redirect: "manual",
            headers: {
                "User-Agent":
                    "craflet/0.1.0 (https://github.com/sya-ri/craflet)",
            },
        });
        const unsafe = new ProviderHttp({
            fetch: vi.fn<typeof fetch>().mockResolvedValue(
                new Response(null, {
                    status: 302,
                    headers: { location: "http://example.com" },
                }),
            ),
        });
        await expect(
            unsafe.open("https://example.com", context),
        ).rejects.toMatchObject({ code: "UNSAFE_DOWNLOAD_URL" });
    });
    it("bounds redirects and rejects missing destinations", async () => {
        const missing = new ProviderHttp({
            fetch: vi
                .fn<typeof fetch>()
                .mockResolvedValue(new Response(null, { status: 302 })),
        });
        await expect(
            missing.open("https://example.com", context),
        ).rejects.toMatchObject({ code: "DOWNLOAD_REDIRECT" });
        const fetcher = vi.fn<typeof fetch>(
            async () =>
                new Response(null, {
                    status: 307,
                    headers: { location: "/again" },
                }),
        );
        await expect(
            new ProviderHttp({ fetch: fetcher }).open(
                "https://example.com",
                context,
            ),
        ).rejects.toMatchObject({ code: "DOWNLOAD_REDIRECT" });
        expect(fetcher).toHaveBeenCalledTimes(6);
    });
    it.each([
        [429, {}, "PROVIDER_RATE_LIMIT"],
        [403, { "x-ratelimit-remaining": "0" }, "PROVIDER_RATE_LIMIT"],
        [403, {}, "DOWNLOAD_HTTP"],
        [404, {}, "DOWNLOAD_HTTP"],
        [500, {}, "DOWNLOAD_HTTP"],
    ] as Array<[number, Record<string, string>, string]>)(
        "reports HTTP %i without leaking URL query strings",
        async (status, headers, code) => {
            const http = new ProviderHttp({
                fetch: vi
                    .fn<typeof fetch>()
                    .mockResolvedValue(new Response(null, { status, headers })),
            });
            const result = http.open(
                "https://example.com/private?token=secret",
                context,
            );
            await expect(result).rejects.toMatchObject({ code });
            await expect(result).rejects.not.toThrow("secret");
        },
    );
    it("bounds and validates JSON responses", async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('{"ok":true}'))
            .mockResolvedValueOnce(new Response("<html>"))
            .mockResolvedValueOnce(new Response(null))
            .mockResolvedValueOnce(new Response("a".repeat(20)));
        const http = new ProviderHttp({
            fetch: fetcher,
            maxMetadataBytes: 16,
            userAgent: "test-suite/1",
        });
        expect(await http.json("https://example.com", context)).toEqual({
            ok: true,
        });
        await expect(
            http.json("https://example.com", context),
        ).rejects.toMatchObject({ code: "PROVIDER_METADATA_INVALID" });
        await expect(
            http.json("https://example.com", context),
        ).rejects.toMatchObject({ code: "PROVIDER_METADATA_INVALID" });
        await expect(
            http.json("https://example.com", context),
        ).rejects.toMatchObject({ code: "PROVIDER_METADATA_TOO_LARGE" });
    });
});
