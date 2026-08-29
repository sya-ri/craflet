import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { CrafletError, isConfigRecord } from "@craflet/core";
import { type ConfigDocument, parseConfigDocument } from "../formats/config.js";
import { assertNoSymlinks, atomicWrite } from "./io.js";

export const EULA_URL = "https://www.minecraft.net/eula";
const MAX_EULA_BYTES = 64 * 1024;

export interface EulaDocument {
    path: string;
    text: string;
    url: string;
}

function changed(): never {
    throw new CrafletError(
        "EULA_CHANGED",
        "The EULA file changed while it was being inspected. Review it and retry.",
        3,
    );
}

function assertRegular(info: Stats): void {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new CrafletError(
            "EULA_UNSAFE",
            "The EULA target must be a regular file without symbolic or hard links.",
            3,
        );
    if (info.size > MAX_EULA_BYTES)
        throw new CrafletError(
            "EULA_SIZE",
            "The EULA file exceeds the 64 KiB safety limit.",
            3,
        );
}

function sameFile(before: Stats, after: Stats): boolean {
    return (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.nlink === after.nlink
    );
}

/** Never follow links or read an unbounded file. */
export async function readEulaText(
    file: string,
    signal?: AbortSignal,
): Promise<string | null> {
    signal?.throwIfAborted();
    await assertNoSymlinks(file);
    let before: Stats;
    try {
        before = await lstat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    assertRegular(before);
    let handle: FileHandle | undefined;
    try {
        const noFollow =
            process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
        const nonblock =
            process.platform === "win32" ? 0 : constants.O_NONBLOCK;
        handle = await open(file, constants.O_RDONLY | noFollow | nonblock);
        const opened = await handle.stat();
        assertRegular(opened);
        if (!sameFile(before, opened)) changed();
        const buffer = Buffer.alloc(MAX_EULA_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(
                buffer,
                size,
                buffer.length - size,
                size,
            );
            if (bytesRead === 0) break;
            size += bytesRead;
        }
        if (size > MAX_EULA_BYTES)
            throw new CrafletError(
                "EULA_SIZE",
                "The EULA file exceeds the 64 KiB safety limit.",
                3,
            );
        await assertNoSymlinks(file);
        const after = await lstat(file);
        assertRegular(after);
        if (
            size !== before.size ||
            !sameFile(before, after) ||
            !sameFile(before, await handle.stat())
        )
            changed();
        signal?.throwIfAborted();
        // Preserve a BOM so properties parsing cannot silently treat it as absent.
        return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
        }).decode(buffer.subarray(0, size));
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof CrafletError) throw error;
        throw new CrafletError(
            "EULA_UNREADABLE",
            "The EULA file cannot be read safely. Inspect it locally; its contents are omitted.",
            3,
        );
    } finally {
        await handle?.close();
    }
}

function parseEulaDocument(text: string): ConfigDocument {
    try {
        if (
            Buffer.byteLength(text, "utf8") > MAX_EULA_BYTES ||
            text.startsWith("\uFEFF")
        )
            throw new Error("Unsupported EULA encoding or size");
        // eula.txt uses Java properties despite its .txt extension.
        return parseConfigDocument("eula.properties", text);
    } catch {
        throw new CrafletError(
            "EULA_INVALID",
            "The EULA file is not an unambiguous Java properties document. Inspect it locally before retrying.",
            3,
        );
    }
}

export function hasAcceptedEula(text: string): boolean {
    const value = parseEulaDocument(text).value;
    return (
        isConfigRecord(value) &&
        typeof value.eula === "string" &&
        value.eula.toLowerCase() === "true"
    );
}

export function proposedEulaDocument(file: string): EulaDocument {
    return {
        path: file,
        text: `# No EULA file exists yet. This preview has not been saved.\n# Minecraft EULA: ${EULA_URL}\neula=false\n`,
        url: EULA_URL,
    };
}

export async function readEulaDocumentAt(
    file: string,
    signal?: AbortSignal,
): Promise<EulaDocument> {
    const text = await readEulaText(file, signal);
    return text === null
        ? proposedEulaDocument(file)
        : { path: file, text, url: EULA_URL };
}

/** The caller must own the applicable operation lock. */
export async function writeAcceptedEula(
    file: string,
    expected: string | null,
    signal?: AbortSignal,
): Promise<boolean> {
    const text = expected ?? "";
    if (hasAcceptedEula(text)) return false;
    const document = parseEulaDocument(text);
    if (!isConfigRecord(document.value))
        throw new CrafletError("EULA_INVALID", "Invalid EULA properties.", 3);
    let updated = document.render({ ...document.value, eula: "true" });
    if (!text.includes("\n") && text.includes("\r"))
        updated = updated.replaceAll("\n", "\r");
    if ((await readEulaText(file, signal)) !== expected) changed();
    signal?.throwIfAborted();
    await atomicWrite(file, updated);
    return true;
}
