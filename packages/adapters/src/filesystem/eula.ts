import { createHash, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import path from "node:path";
import { assertStopped, CrafletError } from "@craflet/core";
import { NodeServerController } from "../runtime/controller.js";
import { NodeConfigManager } from "./config.js";
import {
    ensureUserEulaConsent,
    type RequestEulaConsent,
} from "./eula-consent.js";
import {
    EULA_URL,
    type EulaDocument,
    hasAcceptedEula,
    readEulaDocumentAt,
    readEulaText,
    writeAcceptedEula,
} from "./eula-file.js";
import { assertNoSymlinks, exists } from "./io.js";
import {
    loadProject,
    type ProjectContext,
    recoveryJournalPaths,
} from "./projects.js";
import { readState } from "./state.js";

export interface OwnedEulaOperationJournal {
    path: string;
    byteLength: number;
    sha256: string;
}

export function createOwnedEulaOperationJournal(
    file: string,
    content: string,
): OwnedEulaOperationJournal {
    const bytes = Buffer.from(content, "utf8");
    return {
        path: file,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}

function sameJournalFile(before: Stats, after: Stats): boolean {
    return (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.nlink === after.nlink
    );
}

async function matchesOwnedJournal(
    file: string,
    expected: OwnedEulaOperationJournal,
    signal?: AbortSignal,
): Promise<boolean> {
    if (
        !Number.isSafeInteger(expected.byteLength) ||
        expected.byteLength < 0 ||
        !/^[a-f0-9]{64}$/u.test(expected.sha256)
    )
        return false;
    let handle: FileHandle | undefined;
    try {
        signal?.throwIfAborted();
        const before = await lstat(file);
        if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1 ||
            before.size !== expected.byteLength
        )
            return false;
        const noFollow =
            process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
        const nonblock =
            process.platform === "win32" ? 0 : constants.O_NONBLOCK;
        handle = await open(file, constants.O_RDONLY | noFollow | nonblock);
        const opened = await handle.stat();
        if (!sameJournalFile(before, opened)) return false;
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let size = 0;
        while (size <= expected.byteLength) {
            signal?.throwIfAborted();
            const length = Math.min(
                buffer.byteLength,
                expected.byteLength + 1 - size,
            );
            const { bytesRead } = await handle.read(buffer, 0, length, size);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            size += bytesRead;
        }
        if (size !== expected.byteLength) return false;
        await assertNoSymlinks(file);
        if (
            !sameJournalFile(before, await lstat(file)) ||
            !sameJournalFile(before, await handle.stat())
        )
            return false;
        const actual = hash.digest();
        return timingSafeEqual(actual, Buffer.from(expected.sha256, "hex"));
    } catch {
        signal?.throwIfAborted();
        return false;
    } finally {
        await handle?.close();
    }
}

function assertPaper(project: ProjectContext): void {
    if (project.manifest.server.type !== "paper")
        throw new CrafletError(
            "EULA_NOT_APPLICABLE",
            "Minecraft EULA acceptance is only applicable to Paper projects, not Velocity.",
            2,
        );
}

export async function readEulaDocument(
    project: ProjectContext,
    signal?: AbortSignal,
): Promise<EulaDocument> {
    assertPaper(project);
    return readEulaDocumentAt(
        path.join(project.dir, "runtime/eula.txt"),
        signal,
    );
}

async function guard(
    project: ProjectContext,
    signal: AbortSignal | undefined,
    allowRunning: boolean,
    allowManaged: boolean,
    ownedJournal?: OwnedEulaOperationJournal,
): Promise<ProjectContext> {
    signal?.throwIfAborted();
    const declared = await loadProject(project.dir, project.home);
    assertPaper(project);
    if (
        declared.lockRoot !== project.lockRoot ||
        declared.manifestText !== project.manifestText
    )
        throw new CrafletError(
            "EULA_CONTEXT_CHANGED",
            "Workspace membership changed. Reload the project and retry EULA acceptance.",
            3,
        );
    const current = { ...declared, manifest: project.manifest };
    const groupOperationJournal = path.resolve(
        project.lockRoot,
        ".craflet/group-operation.json",
    );
    for (const file of recoveryJournalPaths(project)) {
        signal?.throwIfAborted();
        const safe = await assertNoSymlinks(file);
        if (!(await exists(safe))) continue;
        if (
            ownedJournal !== undefined &&
            path.resolve(safe) === groupOperationJournal &&
            path.resolve(ownedJournal.path) === groupOperationJournal &&
            (await matchesOwnedJournal(safe, ownedJournal, signal))
        )
            continue;
        throw new CrafletError(
            "RECOVERY_REQUIRED",
            "Recover the interrupted operation before changing EULA acceptance.",
            4,
            "Run craflet recover after confirming the server is stopped.",
        );
    }
    for (const relative of [".craflet/config-mutex", ".craflet/recovery.lock"])
        if (await exists(await assertNoSymlinks(project.dir, relative)))
            throw new CrafletError(
                "BUSY",
                "A configuration or recovery operation is active; retry after it finishes.",
                4,
            );
    const controller = new NodeServerController(
        current.dir,
        current.home,
        undefined,
        signal,
    );
    const status = (await controller.status()).status;
    if (!allowRunning || status !== "running") assertStopped(status);
    const state = await readState(current.dir);
    const managed = await new NodeConfigManager(
        current.dir,
        current.manifest.secrets,
    ).list();
    if (
        !allowManaged &&
        (managed.some((file) => file.relative.toLowerCase() === "eula.txt") ||
            state.pending?.config.files.some(
                (file) => file.relative.toLowerCase() === "eula.txt",
            ))
    )
        throw new CrafletError(
            "EULA_MANAGED",
            "EULA consent is managed by a configuration template or pending installation. No declarations or pending files were changed.",
            3,
            "Review config/eula.txt and explicitly manage consent there, then run craflet install; or untrack/remove that template and rebuild pending before retrying the launch.",
        );
    signal?.throwIfAborted();
    return current;
}

/** Called only while the project or workspace operation lock is already held. */
export async function ensureRuntimeEulaConsent(
    project: ProjectContext,
    requestConsent?: RequestEulaConsent,
    signal?: AbortSignal,
    materialize = true,
    ownedJournal?: OwnedEulaOperationJournal,
): Promise<boolean> {
    assertPaper(project);
    const file = path.join(project.dir, "runtime/eula.txt");
    const original = await readEulaText(file, signal);
    const accepted = hasAcceptedEula(original ?? "");
    const current = await guard(
        project,
        signal,
        !materialize,
        accepted,
        ownedJournal,
    );
    if (accepted) return false;
    const document =
        original === null
            ? await readEulaDocument(current, signal)
            : { path: file, text: original, url: EULA_URL };
    await ensureUserEulaConsent(
        current.home,
        requestConsent ??
            (async () => {
                throw new CrafletError(
                    "EULA_REQUIRED",
                    "Explicit Minecraft EULA consent is required before launching Paper.",
                    3,
                    "Run the launch command interactively, or pass --yes to that command after reading https://www.minecraft.net/eula.",
                );
            }),
        { document, ...(signal ? { signal } : {}) },
    );
    await guard(project, signal, !materialize, false, ownedJournal);
    if (!materialize) return false;
    if ((await readEulaText(file, signal)) !== original)
        throw new CrafletError(
            "EULA_CHANGED",
            "The EULA file changed while consent was being recorded. Review it and retry the launch.",
            3,
        );
    return writeAcceptedEula(file, original, signal);
}

export {
    type EulaDocument,
    hasAcceptedEula,
    readEulaText,
} from "./eula-file.js";
