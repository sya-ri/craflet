import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    backupTestDirectory,
    cleanupBackupTestDirectories,
    writeBackupTestFile,
    backupZipFixture as zipFixture,
} from "../../../../tests/integration/backup-fixtures.js";
import {
    decodeVerifiedResticBzip,
    extractVerifiedResticZip,
    ResticBootstrap,
    verifyResticArchive,
} from "./bootstrap.js";
import { RESTIC_ASSETS, RESTIC_VERSION, type ResticAsset } from "./manifest.js";

afterEach(cleanupBackupTestDirectories);

function asset(
    bytes: Uint8Array,
    compression: "zip" | "bz2" = "bz2",
): ResticAsset {
    return {
        name:
            compression === "zip"
                ? "restic_0.19.1_windows_amd64.zip"
                : "fixture.bz2",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        compression,
    };
}

const fixtureBzip = Buffer.from(
    "QlpoOTFBWSZTWWhOGGgAAALRgAAQQAArJB5AIAAxANAA1NGTZA70jHQpP0DcULyc0XckU4UJBoThhoA=",
    "base64",
);
const versionRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ version: RESTIC_VERSION }),
    stderr: "",
});

describe("pinned restic bootstrap", () => {
    it("verifies compressed bytes before bounded bzip2 extraction", () => {
        const descriptor = asset(fixtureBzip);
        expect(
            decodeVerifiedResticBzip(fixtureBzip, descriptor).toString("utf8"),
        ).toBe("craflet restic fixture\n");
        expect(() =>
            verifyResticArchive(Buffer.from("bad"), descriptor),
        ).toThrow(/SHA256/u);
        expect(() =>
            verifyResticArchive(fixtureBzip, {
                ...descriptor,
                sha256: "0".repeat(64),
            }),
        ).toThrow();
        expect(() =>
            decodeVerifiedResticBzip(fixtureBzip, descriptor, 3),
        ).toThrow(/resource limits/u);
        expect(() =>
            decodeVerifiedResticBzip(fixtureBzip, {
                ...descriptor,
                compression: "zip",
            }),
        ).toThrow();
        const invalid = Buffer.from("invalid bzip2");
        expect(() =>
            decodeVerifiedResticBzip(invalid, asset(invalid)),
        ).toThrow();
    });

    it("extracts only the expected executable from a verified ZIP", async () => {
        const root = await backupTestDirectory();
        const bytes = zipFixture([
            {
                name: "restic_0.19.1_windows_amd64.exe",
                bytes: Buffer.from("fixture executable"),
            },
        ]);
        const file = await writeBackupTestFile(root, "restic.zip", bytes);
        expect(
            (
                await extractVerifiedResticZip(file, asset(bytes, "zip"))
            ).toString(),
        ).toBe("fixture executable");
        const wrong = zipFixture([
            { name: "unexpected.exe", bytes: Buffer.from("bad") },
        ]);
        await writeBackupTestFile(root, "bad.zip", wrong);
        await expect(
            extractVerifiedResticZip(
                path.join(root, "bad.zip"),
                asset(wrong, "zip"),
            ),
        ).rejects.toThrow(/Unexpected/u);
        const empty = zipFixture([{ name: "folder/", bytes: Buffer.alloc(0) }]);
        await writeBackupTestFile(root, "empty.zip", empty);
        await expect(
            extractVerifiedResticZip(
                path.join(root, "empty.zip"),
                asset(empty, "zip"),
            ),
        ).rejects.toThrow(/no executable/u);
        const tooMany = zipFixture(
            Array.from({ length: 17 }, (_, i) => ({
                name: `directory${i}/`,
                bytes: Buffer.alloc(0),
            })),
        );
        await writeBackupTestFile(root, "many.zip", tooMany);
        await expect(
            extractVerifiedResticZip(
                path.join(root, "many.zip"),
                asset(tooMany, "zip"),
            ),
        ).rejects.toThrow(/too many/u);
    });

    it("requires a supported platform or an explicitly supplied pinned-version binary", async () => {
        const root = await backupTestDirectory();
        const unsupported = new ResticBootstrap(root, {
            platform: "win32",
            architecture: "arm64",
            runner: versionRunner,
        });
        await expect(
            unsupported.prepare({ offline: true }),
        ).rejects.toMatchObject({ code: "RESTIC_PLATFORM" });
        await expect(
            unsupported.prepare({ binaryPath: "relative.exe" }),
        ).rejects.toMatchObject({ code: "RESTIC_PATH" });
        const binary = await writeBackupTestFile(
            root,
            "manual-restic",
            "fixture",
        );
        expect(await unsupported.prepare({ binaryPath: binary })).toEqual({
            path: binary,
            version: RESTIC_VERSION,
        });
        const wrong = new ResticBootstrap(root, {
            runner: async () => ({
                exitCode: 0,
                stdout: '{"version":"0.1.0"}',
                stderr: "",
            }),
        });
        await expect(
            wrong.prepare({ binaryPath: binary }),
        ).rejects.toMatchObject({ code: "RESTIC_VERSION" });
        await expect(
            unsupported.prepare({ signal: AbortSignal.abort() }),
        ).rejects.toThrow();
    });

    it("checks cached executable digests before offline reuse", async () => {
        const root = await backupTestDirectory();
        const descriptor = RESTIC_ASSETS["win32-x64"];
        if (!descriptor) throw new Error("missing descriptor");
        const relative = `tools/restic/${RESTIC_VERSION}/win32-x64`;
        const binary = await writeBackupTestFile(
            root,
            `${relative}/restic.exe`,
            "fixture executable",
        );
        await writeBackupTestFile(
            root,
            `${relative}/receipt.json`,
            JSON.stringify({
                version: RESTIC_VERSION,
                archiveSha256: descriptor.sha256,
                binarySha256: createHash("sha256")
                    .update("fixture executable")
                    .digest("hex"),
                binaryBytes: 18,
            }),
        );
        const bootstrap = new ResticBootstrap(root, {
            platform: "win32",
            architecture: "x64",
            runner: versionRunner,
        });
        expect((await bootstrap.prepare({ offline: true })).path).toBe(binary);
        await writeBackupTestFile(root, `${relative}/restic.exe`, "tampered");
        await expect(
            bootstrap.prepare({ offline: true }),
        ).rejects.toMatchObject({
            code: "RESTIC_OFFLINE",
            message: expect.stringContaining("craflet tools prepare restic"),
        });
        expect(await readFile(binary, "utf8")).toBe("tampered");
    });

    it.each([
        {
            name: "unapproved redirect",
            response: () =>
                new Response(null, {
                    status: 302,
                    headers: { location: "https://attacker.invalid/restic" },
                }),
            code: "RESTIC_DOWNLOAD",
        },
        {
            name: "missing redirect target",
            response: () => new Response(null, { status: 302 }),
            code: "RESTIC_DOWNLOAD",
        },
        {
            name: "HTTP error",
            response: () => new Response(null, { status: 503 }),
            code: "RESTIC_DOWNLOAD",
        },
        {
            name: "wrong content length",
            response: () =>
                new Response("bad", { headers: { "content-length": "3" } }),
            code: "RESTIC_CHECKSUM",
        },
        {
            name: "wrong body digest",
            response: () => new Response("bad"),
            code: "RESTIC_CHECKSUM",
        },
        {
            name: "too many redirects",
            response: () =>
                new Response(null, {
                    status: 302,
                    headers: { location: "/again" },
                }),
            code: "RESTIC_DOWNLOAD",
        },
    ])(
        "rejects $name before creating a runnable binary",
        async ({ response, code }) => {
            const root = await backupTestDirectory();
            const fetcher = vi.fn(async () =>
                response(),
            ) as unknown as typeof fetch;
            const bootstrap = new ResticBootstrap(root, {
                platform: "win32",
                architecture: "x64",
                runner: versionRunner,
                fetch: fetcher,
            });
            await expect(bootstrap.prepare()).rejects.toMatchObject({ code });
        },
    );
});
