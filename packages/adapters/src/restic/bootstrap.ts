import { createHash } from "node:crypto";
import { chmod, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
    type BackupPrepareOptions,
    CrafletError,
    type PreparedBackupTool,
} from "@craflet/core";
import bunzip from "seek-bzip";
import { openPromise } from "yauzl";
import { hashBackupFile } from "../filesystem/backup-files.js";
import {
    assertNoSymlinks,
    atomicWrite,
    exists,
    readJson,
    withMutex,
    writeJson,
} from "../filesystem/io.js";
import {
    MAX_RESTIC_BINARY_BYTES,
    RESTIC_ASSETS,
    RESTIC_VERSION,
    type ResticAsset,
} from "./manifest.js";
import {
    type BackupProcessRunner,
    runBackupProcess,
    sanitizedBackupEnvironment,
} from "./process.js";

export interface ResticBootstrapDependencies {
    fetch?: typeof globalThis.fetch;
    runner?: BackupProcessRunner;
    platform?: string;
    architecture?: string;
}

interface CachedResticReceipt {
    archiveSha256: string;
    binarySha256: string;
    binaryBytes: number;
    version: string;
}

export function verifyResticArchive(
    bytes: Uint8Array,
    asset: ResticAsset,
): void {
    if (
        bytes.length !== asset.size ||
        createHash("sha256").update(bytes).digest("hex") !== asset.sha256
    ) {
        throw new CrafletError(
            "RESTIC_CHECKSUM",
            "The restic archive does not match its pinned official size and SHA256.",
            3,
        );
    }
}

export function decodeVerifiedResticBzip(
    bytes: Uint8Array,
    asset: ResticAsset,
    maximum = MAX_RESTIC_BINARY_BYTES,
): Buffer {
    verifyResticArchive(bytes, asset);
    if (asset.compression !== "bz2")
        throw new CrafletError(
            "RESTIC_ARCHIVE",
            "Expected the official bzip2 restic archive.",
            3,
        );
    const output = Buffer.allocUnsafe(maximum);
    let offset = 0;
    const deadline = Date.now() + 30000;
    try {
        bunzip.decode(Buffer.from(bytes), {
            writeByte(value: number) {
                if (offset >= maximum)
                    throw new Error("Restic binary size limit");
                if ((offset & 0xffff) === 0 && Date.now() > deadline)
                    throw new Error("Restic decode time limit");
                output[offset++] = value;
            },
        });
    } catch {
        throw new CrafletError(
            "RESTIC_ARCHIVE",
            "Could not decode the verified restic archive within its resource limits.",
            3,
        );
    }
    if (offset === 0)
        throw new CrafletError(
            "RESTIC_ARCHIVE",
            "The restic archive contained an empty executable.",
            3,
        );
    return output.subarray(0, offset);
}

export async function extractVerifiedResticZip(
    archive: string,
    asset: ResticAsset,
): Promise<Buffer> {
    const archiveBytes = await readFile(archive);
    verifyResticArchive(archiveBytes, asset);
    const zip = await openPromise(archive, {
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
    });
    try {
        let executable: Buffer | undefined;
        let entries = 0;
        for await (const entry of zip.eachEntry()) {
            if (++entries > 16)
                throw new CrafletError(
                    "RESTIC_ARCHIVE",
                    "The restic archive contains too many entries.",
                    3,
                );
            if (entry.fileName.endsWith("/")) continue;
            const expected = asset.name.replace(/\.zip$/u, ".exe");
            if (
                entry.fileName !== expected ||
                executable ||
                entry.uncompressedSize > MAX_RESTIC_BINARY_BYTES ||
                entry.uncompressedSize === 0 ||
                (entry.generalPurposeBitFlag & 1) !== 0
            ) {
                throw new CrafletError(
                    "RESTIC_ARCHIVE",
                    "Unexpected content in the official restic ZIP archive.",
                    3,
                );
            }
            const stream = await zip.openReadStreamPromise(entry);
            const chunks: Buffer[] = [];
            let size = 0;
            try {
                for await (const chunk of stream) {
                    size += chunk.length;
                    if (size > MAX_RESTIC_BINARY_BYTES)
                        throw new CrafletError(
                            "RESTIC_ARCHIVE",
                            "Restic executable exceeds its size limit.",
                            3,
                        );
                    chunks.push(Buffer.from(chunk));
                }
            } finally {
                stream.destroy();
            }
            executable = Buffer.concat(chunks);
        }
        if (!executable)
            throw new CrafletError(
                "RESTIC_ARCHIVE",
                "The restic archive has no executable.",
                3,
            );
        return executable;
    } finally {
        zip.close();
    }
}

export class ResticBootstrap {
    private readonly fetcher: typeof globalThis.fetch;
    private readonly runner: BackupProcessRunner;
    private readonly target: string;

    constructor(
        private readonly home: string,
        dependencies: ResticBootstrapDependencies = {},
    ) {
        this.fetcher = dependencies.fetch ?? globalThis.fetch;
        this.runner = dependencies.runner ?? runBackupProcess;
        this.target = `${dependencies.platform ?? process.platform}-${dependencies.architecture ?? process.arch}`;
    }

    async prepare(
        options: BackupPrepareOptions = {},
    ): Promise<PreparedBackupTool> {
        options.signal?.throwIfAborted();
        if (options.binaryPath) {
            if (!path.isAbsolute(options.binaryPath))
                throw new CrafletError(
                    "RESTIC_PATH",
                    "An explicit restic executable path must be absolute.",
                    2,
                );
            await assertNoSymlinks(options.binaryPath);
            if (!(await lstat(options.binaryPath)).isFile())
                throw new CrafletError(
                    "RESTIC_PATH",
                    "The explicit restic executable is not a regular file.",
                    3,
                );
            await this.verifyVersion(options.binaryPath, options.signal);
            return { path: options.binaryPath, version: RESTIC_VERSION };
        }
        const asset = RESTIC_ASSETS[this.target];
        if (!asset) {
            throw new CrafletError(
                "RESTIC_PLATFORM",
                "There is no pinned official restic binary for this OS/CPU. Restic-backed backup operations are unavailable on this platform in this release.",
                3,
            );
        }
        const directory = path.join(
            this.home,
            "tools",
            "restic",
            RESTIC_VERSION,
            this.target,
        );
        const executable = path.join(
            directory,
            this.target.startsWith("win32-") ? "restic.exe" : "restic",
        );
        const receiptPath = path.join(directory, "receipt.json");
        const archive = path.join(directory, asset.name);
        await assertNoSymlinks(directory);
        await withMutex(path.join(directory, ".prepare-lock"), async () => {
            if (await this.validCache(executable, receiptPath, asset)) return;
            let archiveBytes: Buffer;
            if (await exists(archive)) {
                await assertNoSymlinks(archive);
                archiveBytes = await readFile(archive);
                verifyResticArchive(archiveBytes, asset);
            } else {
                if (options.offline)
                    throw new CrafletError(
                        "RESTIC_OFFLINE",
                        "The pinned restic binary is not cached. Run craflet tools prepare restic while online first.",
                        3,
                    );
                archiveBytes = await this.download(asset, options.signal);
                await atomicWrite(archive, archiveBytes);
            }
            options.signal?.throwIfAborted();
            const binary =
                asset.compression === "bz2"
                    ? decodeVerifiedResticBzip(archiveBytes, asset)
                    : await extractVerifiedResticZip(archive, asset);
            options.signal?.throwIfAborted();
            await atomicWrite(executable, binary, 0o700);
            await chmod(executable, 0o700);
            await this.verifyVersion(executable, options.signal);
            await writeJson(receiptPath, {
                archiveSha256: asset.sha256,
                binarySha256: createHash("sha256").update(binary).digest("hex"),
                binaryBytes: binary.length,
                version: RESTIC_VERSION,
            } satisfies CachedResticReceipt);
        });
        await this.verifyVersion(executable, options.signal);
        return { path: executable, version: RESTIC_VERSION };
    }

    private async validCache(
        executable: string,
        receiptPath: string,
        asset: ResticAsset,
    ): Promise<boolean> {
        if (!(await exists(executable)) || !(await exists(receiptPath)))
            return false;
        await assertNoSymlinks(receiptPath);
        const receipt = await readJson<Partial<CachedResticReceipt>>(
            receiptPath,
        ).catch(() => undefined);
        if (
            receipt?.version !== RESTIC_VERSION ||
            receipt.archiveSha256 !== asset.sha256
        )
            return false;
        const actual = await hashBackupFile(executable);
        return (
            actual.sha256 === receipt.binarySha256 &&
            actual.bytes === receipt.binaryBytes
        );
    }

    private async verifyVersion(
        executable: string,
        signal?: AbortSignal,
    ): Promise<void> {
        const result = await this.runner({
            executable,
            args: ["version", "--json"],
            env: sanitizedBackupEnvironment(),
            timeoutMs: 10000,
            maxOutputBytes: 8192,
            ...(signal ? { signal } : {}),
        });
        let parsed: unknown;
        try {
            parsed = JSON.parse(result.stdout);
        } catch {
            parsed = undefined;
        }
        if (
            result.exitCode !== 0 ||
            !parsed ||
            typeof parsed !== "object" ||
            !("version" in parsed) ||
            parsed.version !== RESTIC_VERSION
        ) {
            throw new CrafletError(
                "RESTIC_VERSION",
                `Craflet requires the pinned restic version ${RESTIC_VERSION}.`,
                3,
            );
        }
    }

    private async download(
        asset: ResticAsset,
        signal?: AbortSignal,
    ): Promise<Buffer> {
        let url = `https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${asset.name}`;
        const abort = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
            : AbortSignal.timeout(120000);
        for (let redirects = 0; redirects < 5; redirects++) {
            const location = new URL(url);
            if (
                location.protocol !== "https:" ||
                location.username ||
                location.password ||
                ![
                    "github.com",
                    "release-assets.githubusercontent.com",
                    "objects.githubusercontent.com",
                ].includes(location.hostname)
            ) {
                throw new CrafletError(
                    "RESTIC_DOWNLOAD",
                    "The official restic download redirected to an unapproved origin.",
                    3,
                );
            }
            const response = await this.fetcher(url, {
                redirect: "manual",
                signal: abort,
                headers: {
                    "User-Agent": "craflet/restic-bootstrap",
                    Accept: "application/octet-stream",
                },
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const target = response.headers.get("location");
                await response.body?.cancel();
                if (!target)
                    throw new CrafletError(
                        "RESTIC_DOWNLOAD",
                        "The official restic redirect has no location.",
                        3,
                    );
                url = new URL(target, url).href;
                continue;
            }
            if (!response.ok || !response.body)
                throw new CrafletError(
                    "RESTIC_DOWNLOAD",
                    `Could not download the pinned restic archive (HTTP ${response.status}).`,
                    3,
                );
            const declared = response.headers.get("content-length");
            if (declared !== null && Number(declared) !== asset.size) {
                await response.body.cancel();
                throw new CrafletError(
                    "RESTIC_CHECKSUM",
                    "The restic archive has an unexpected declared size.",
                    3,
                );
            }
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let size = 0;
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    size += next.value.length;
                    if (size > asset.size)
                        throw new CrafletError(
                            "RESTIC_CHECKSUM",
                            "The restic archive exceeds its pinned size.",
                            3,
                        );
                    chunks.push(Buffer.from(next.value));
                }
            } finally {
                await reader.cancel();
                reader.releaseLock();
            }
            const bytes = Buffer.concat(chunks);
            verifyResticArchive(bytes, asset);
            return bytes;
        }
        throw new CrafletError(
            "RESTIC_DOWNLOAD",
            "The official restic download exceeded its redirect limit.",
            3,
        );
    }
}
