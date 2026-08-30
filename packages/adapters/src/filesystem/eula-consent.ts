import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CrafleetError } from "@crafleet/core";
import { type } from "arktype";
import { processDefinitelyExited } from "../runtime/process.js";
import {
    EULA_URL,
    type EulaDocument,
    proposedEulaDocument,
    readEulaText,
} from "./eula-file.js";
import { assertNoSymlinks, atomicWrite, exists } from "./io.js";
import {
    assertPrivateFile,
    ensurePrivateDirectory,
    ensurePrivateFile,
} from "./private.js";

const UserEulaSchema = type({
    "+": "reject",
    schemaVersion: "1",
    url: "string",
    accepted: "true",
    acceptedAt: "string",
});

const EulaLockSchema = type({
    "+": "reject",
    schemaVersion: "1",
    pid: "number.integer > 0",
    startedAt: "string",
});

export type RequestEulaConsent = (document: EulaDocument) => Promise<void>;

export interface UserEulaConsentOptions {
    dryRun?: boolean;
    signal?: AbortSignal;
    document?: EulaDocument;
}

interface EulaLock {
    directory: string;
    owner: string;
    raw: string;
}

function invalidConsent(): never {
    throw new CrafleetError(
        "EULA_CONSENT_INVALID",
        "The saved host EULA consent record is invalid or unsafe; its contents are omitted.",
        3,
        "Inspect or remove CRAFLEET_HOME/eula.json, then confirm the EULA again.",
    );
}

function invalidLock(): never {
    throw new CrafleetError(
        "EULA_LOCK_INVALID",
        "The EULA consent lock is invalid or cannot be recovered safely.",
        4,
        "Inspect CRAFLEET_HOME/eula.lock locally. Remove it only after confirming that its Crafleet process has exited.",
    );
}

function busyLock(): never {
    throw new CrafleetError(
        "BUSY",
        "Another EULA confirmation is active, or its recorded process is still running.",
        4,
        "Wait for that confirmation to finish. Inspect CRAFLEET_HOME/eula.lock before any manual removal.",
    );
}

async function hasSavedConsent(
    home: string,
    signal?: AbortSignal,
): Promise<boolean> {
    signal?.throwIfAborted();
    const file = path.join(home, "eula.json");
    let text: string | null;
    try {
        const safe = await assertNoSymlinks(file);
        if (!(await exists(safe))) {
            signal?.throwIfAborted();
            return false;
        }
        await assertPrivateFile(file);
        text = await readEulaText(file, signal);
    } catch {
        signal?.throwIfAborted();
        invalidConsent();
    }
    if (text === null) return false;
    try {
        const input: unknown = JSON.parse(text);
        const record = UserEulaSchema(input);
        if (
            record instanceof type.errors ||
            record.url !== EULA_URL ||
            new Date(record.acceptedAt).toISOString() !== record.acceptedAt ||
            `${JSON.stringify(record, null, 4)}\n` !== text
        )
            invalidConsent();
    } catch (error) {
        if (error instanceof CrafleetError) throw error;
        invalidConsent();
    }
    return true;
}

async function recoverStaleLock(
    home: string,
    directory: string,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    if (!(await exists(directory))) return;
    let owner: string;
    let raw: string;
    let pid: number;
    try {
        await assertNoSymlinks(directory);
        if (!(await lstat(directory)).isDirectory()) invalidLock();
        const entries = await readdir(directory);
        if (entries.length !== 1 || entries[0] !== "owner.json") invalidLock();
        owner = await assertNoSymlinks(directory, "owner.json");
        const info = await lstat(owner);
        if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024)
            invalidLock();
        await assertPrivateFile(owner);
        const text = await readEulaText(owner, signal);
        if (text === null) invalidLock();
        raw = text;
        const parsed: unknown = JSON.parse(raw);
        const record = EulaLockSchema(parsed);
        if (
            record instanceof type.errors ||
            new Date(record.startedAt).toISOString() !== record.startedAt ||
            `${JSON.stringify(record, null, 4)}\n` !== raw
        )
            invalidLock();
        pid = record.pid;
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof CrafleetError) throw error;
        invalidLock();
    }
    if (!processDefinitelyExited(pid)) busyLock();
    if (
        (await readEulaText(owner, signal)) !== raw ||
        !processDefinitelyExited(pid)
    )
        invalidLock();
    const retired = await assertNoSymlinks(
        home,
        `.eula-lock-${randomUUID()}.stale`,
    );
    try {
        await rename(directory, retired);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        invalidLock();
    }
    await assertNoSymlinks(retired, "owner.json");
    await rm(retired, { recursive: true, force: true });
}

async function acquireEulaLock(
    home: string,
    signal?: AbortSignal,
): Promise<EulaLock> {
    const directory = await assertNoSymlinks(home, "eula.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        const pending = await assertNoSymlinks(
            home,
            `.eula-lock-${randomUUID()}.pending`,
        );
        await ensurePrivateDirectory(pending);
        const owner = await assertNoSymlinks(pending, "owner.json");
        const raw = `${JSON.stringify(
            {
                schemaVersion: 1,
                pid: process.pid,
                startedAt: new Date().toISOString(),
            },
            null,
            4,
        )}\n`;
        try {
            await atomicWrite(owner, raw);
            await ensurePrivateFile(owner);
            await rename(pending, directory);
            return {
                directory,
                owner: path.join(directory, "owner.json"),
                raw,
            };
        } catch (error) {
            await assertNoSymlinks(pending);
            await rm(pending, { recursive: true, force: true });
            if (await exists(directory)) {
                if (attempt === 0) {
                    await recoverStaleLock(home, directory, signal);
                    continue;
                }
                busyLock();
            }
            throw error;
        }
    }
    busyLock();
}

async function releaseEulaLock(home: string, lock: EulaLock): Promise<void> {
    const owner = await assertNoSymlinks(lock.directory, "owner.json");
    if ((await readEulaText(owner)) !== lock.raw) invalidLock();
    const retired = await assertNoSymlinks(
        home,
        `.eula-lock-${randomUUID()}.released`,
    );
    try {
        await rename(lock.directory, retired);
    } catch {
        invalidLock();
    }
    await assertNoSymlinks(retired, "owner.json");
    await rm(retired, { recursive: true, force: true });
}

async function withEulaLock<T>(
    home: string,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
): Promise<T> {
    const lock = await acquireEulaLock(home, signal);
    try {
        return await action();
    } finally {
        await releaseEulaLock(home, lock);
    }
}

/** Records explicit consent once for the current Crafleet home and OS user. */
export async function ensureUserEulaConsent(
    home: string,
    requestConsent: RequestEulaConsent,
    options: UserEulaConsentOptions = {},
): Promise<boolean> {
    options.signal?.throwIfAborted();
    const absolute = path.resolve(home);
    if (options.dryRun) {
        await hasSavedConsent(absolute, options.signal);
        return false;
    }
    try {
        const record = await assertNoSymlinks(absolute, "eula.json");
        if (await exists(record)) await assertPrivateFile(record);
    } catch {
        invalidConsent();
    }
    await ensurePrivateDirectory(absolute);
    options.signal?.throwIfAborted();
    if (await hasSavedConsent(absolute, options.signal)) return false;
    return withEulaLock(absolute, options.signal, async () => {
        if (await hasSavedConsent(absolute, options.signal)) return false;
        const document =
            options.document ??
            proposedEulaDocument(path.join(absolute, "eula.txt"));
        await requestConsent(document);
        options.signal?.throwIfAborted();
        const record = await assertNoSymlinks(absolute, "eula.json");
        await atomicWrite(
            record,
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    url: EULA_URL,
                    accepted: true,
                    acceptedAt: new Date().toISOString(),
                },
                null,
                4,
            )}\n`,
        );
        await ensurePrivateFile(record);
        return true;
    });
}
