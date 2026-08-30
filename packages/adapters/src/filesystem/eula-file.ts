import { CrafleetError, isConfigRecord } from "@crafleet/core";
import { type ConfigDocument, parseConfigDocument } from "../formats/config.js";
import {
    atomicWrite,
    type BoundedFileFailure,
    readBoundedRegularFile,
} from "./io.js";

export const EULA_URL = "https://www.minecraft.net/eula";
const MAX_EULA_BYTES = 64 * 1024;

export interface EulaDocument {
    path: string;
    text: string;
    url: string;
}

function changed(): never {
    throw new CrafleetError(
        "EULA_CHANGED",
        "The EULA file changed while it was being inspected. Review it and retry.",
        3,
    );
}

function readFailure(reason: BoundedFileFailure): never {
    if (reason === "changed") changed();
    if (reason === "unsafe")
        throw new CrafleetError(
            "EULA_UNSAFE",
            "The EULA target must be a regular file without symbolic or hard links.",
            3,
        );
    if (reason === "too-large")
        throw new CrafleetError(
            "EULA_SIZE",
            "The EULA file exceeds the 64 KiB safety limit.",
            3,
        );
    throw new CrafleetError(
        "EULA_UNREADABLE",
        "The EULA file cannot be read safely. Inspect it locally; its contents are omitted.",
        3,
    );
}

/** Never follow links or read an unbounded file. */
export async function readEulaText(
    file: string,
    signal?: AbortSignal,
): Promise<string | null> {
    const snapshot = await readBoundedRegularFile(file, {
        maxBytes: MAX_EULA_BYTES,
        ...(signal ? { signal } : {}),
        failure: readFailure,
    });
    if (snapshot === null) return null;
    try {
        // Preserve a BOM so properties parsing cannot silently treat it as absent.
        return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
        }).decode(snapshot.bytes);
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof CrafleetError) throw error;
        return readFailure("unreadable");
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
        throw new CrafleetError(
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
        throw new CrafleetError("EULA_INVALID", "Invalid EULA properties.", 3);
    let updated = document.render({ ...document.value, eula: "true" });
    if (!text.includes("\n") && text.includes("\r"))
        updated = updated.replaceAll("\n", "\r");
    if ((await readEulaText(file, signal)) !== expected) changed();
    signal?.throwIfAborted();
    await atomicWrite(file, updated);
    return true;
}
