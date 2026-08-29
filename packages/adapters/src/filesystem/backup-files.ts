import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
    lstat,
    mkdir,
    mkdtemp,
    open,
    readdir,
    realpath,
    rm,
    statfs,
    utimes,
} from "node:fs/promises";
import path from "node:path";
import {
    type BackupFile,
    type BackupMetadata,
    type BackupPlan,
    type BackupRoot,
    CrafletError,
    createBackupSelector,
    parseBackupRules,
} from "@craflet/core";
import {
    assertNoSymlinks,
    containedPath,
    exists,
    pathContains,
    pathsOverlap,
} from "./io.js";
import { ensurePrivateDirectory } from "./private.js";

export { pathsOverlap } from "./io.js";

function rootId(source: string): string {
    return `external-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

export async function planBackupFiles(
    runtime: string,
    patterns: readonly string[],
    forbiddenPaths: readonly string[] = [],
    patternBase = runtime,
): Promise<BackupPlan> {
    await assertNoSymlinks(runtime);
    await assertNoSymlinks(patternBase);
    const canonicalRuntime = await realpath(runtime);
    const canonicalBase = await realpath(patternBase);
    if (!(await lstat(canonicalRuntime)).isDirectory()) {
        throw new CrafletError(
            "BACKUP_SOURCE",
            "The runtime backup source must be a directory.",
            3,
        );
    }
    const roots: BackupRoot[] = [
        {
            id: "runtime",
            path: canonicalRuntime,
            external: false,
            kind: "directory",
        },
    ];
    const rules = parseBackupRules(patterns);
    for (const rule of rules) {
        if (!rule.include || !rule.staticPrefix) continue;
        if (
            /^[a-zA-Z]:\//u.test(rule.staticPrefix) &&
            process.platform !== "win32"
        ) {
            throw new CrafletError(
                "BACKUP_SOURCE",
                "A Windows absolute backup path cannot be used on this host.",
                2,
            );
        }
        const prefix = path.resolve(canonicalBase, rule.staticPrefix);
        if (pathContains(canonicalRuntime, prefix)) continue;
        await assertNoSymlinks(prefix);
        if (!(await exists(prefix))) {
            throw new CrafletError(
                "BACKUP_SOURCE_MISSING",
                `Explicit backup source is missing: ${prefix}`,
                3,
            );
        }
        const canonical = await realpath(prefix);
        const details = await lstat(canonical);
        if (!details.isFile() && !details.isDirectory()) {
            throw new CrafletError(
                "BACKUP_SOURCE",
                `Backup sources must be regular files or directories: ${canonical}`,
                3,
            );
        }
        if (pathContains(canonicalRuntime, canonical)) continue;
        if (
            details.isDirectory() &&
            (pathContains(canonical, canonicalRuntime) ||
                canonical === path.parse(canonical).root)
        ) {
            throw new CrafletError(
                "BACKUP_SOURCE_OVERLAP",
                "External directory rules must not include the project runtime or an entire filesystem root.",
                3,
            );
        }
        if (!roots.some((root) => root.path === canonical)) {
            roots.push({
                id: rootId(canonical),
                path: canonical,
                external: true,
                kind: details.isFile() ? "file" : "directory",
            });
        }
    }
    for (const root of roots) {
        for (const forbidden of forbiddenPaths) {
            await assertNoSymlinks(forbidden);
            if (pathsOverlap(root.path, forbidden)) {
                throw new CrafletError(
                    "BACKUP_SELF_INCLUSION",
                    `Backup source overlaps a repository or Craflet working directory: ${root.path}`,
                    3,
                );
            }
        }
    }
    const select = createBackupSelector(patterns);
    const files: BackupFile[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    async function visit(source: string, root: BackupRoot): Promise<void> {
        const details = await lstat(source);
        if (details.isSymbolicLink()) {
            throw new CrafletError(
                "BACKUP_SYMLINK",
                `Backup traversal does not follow symbolic links or junctions: ${source}`,
                3,
            );
        }
        if (details.isDirectory()) {
            const children = await readdir(source);
            children.sort();
            for (const child of children)
                await visit(path.join(source, child), root);
            return;
        }
        const relative = path
            .relative(canonicalBase, source)
            .split(path.sep)
            .join("/");
        const selection = select(relative, source.split(path.sep).join("/"));
        if (!selection.included || seen.has(source)) return;
        if (!details.isFile()) {
            throw new CrafletError(
                "BACKUP_SPECIAL_FILE",
                `Only regular files can be backed up: ${source}`,
                3,
            );
        }
        if (!Number.isSafeInteger(details.size)) {
            throw new CrafletError(
                "BACKUP_FILE_SIZE",
                "A backup file exceeds the supported exact integer size.",
                3,
            );
        }
        seen.add(source);
        const suffix =
            root.kind === "file"
                ? path.basename(source)
                : path.relative(root.path, source);
        const destination = root.external
            ? `data/external/${root.id}/${suffix.split(path.sep).join("/")}`
            : `data/runtime/${suffix.split(path.sep).join("/")}`;
        files.push({
            source,
            destination,
            rootId: root.id,
            size: details.size,
            mtimeMs: details.mtimeMs,
            ctimeMs: details.ctimeMs,
            device: details.dev,
            inode: details.ino,
            mode: details.mode & 0o777,
            matchedRule: selection.matchedRule,
        });
    }
    roots.sort(
        (first, second) =>
            first.path.length - second.path.length ||
            first.path.localeCompare(second.path, "en"),
    );
    for (const root of roots) {
        if (root.external)
            warnings.push(`Explicit external source: ${root.path}`);
        await visit(root.path, root);
    }
    files.sort((first, second) =>
        first.destination.localeCompare(second.destination, "en"),
    );
    const bytes = files.reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(bytes))
        throw new CrafletError(
            "BACKUP_FILE_SIZE",
            "The selected backup size is too large.",
            3,
        );
    return {
        roots,
        files,
        bytes,
        stagingBytes: bytes,
        databaseIds: [],
        warnings,
    };
}

export async function privateBackupDirectory(
    parent: string,
    prefix: string,
): Promise<string> {
    await assertNoSymlinks(parent);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(parent, prefix));
    try {
        await ensurePrivateDirectory(directory);
    } catch (error) {
        await removePrivateBackupDirectory(parent, directory);
        throw error;
    }
    return directory;
}

export async function removePrivateBackupDirectory(
    parent: string,
    directory: string,
): Promise<void> {
    const relative = path.relative(
        path.resolve(parent),
        path.resolve(directory),
    );
    if (!relative || !pathContains(parent, directory)) {
        throw new CrafletError(
            "BACKUP_CLEANUP",
            "Refusing to remove a directory outside the backup temporary directory.",
            3,
        );
    }
    await assertNoSymlinks(parent, relative);
    await rm(directory, { recursive: true, force: true });
}

export async function checkBackupSpace(
    directory: string,
    requiredBytes: number,
): Promise<void> {
    let existing = path.resolve(directory);
    while (!(await exists(existing))) existing = path.dirname(existing);
    const info = await statfs(existing, { bigint: true });
    const available = info.bavail * info.bsize;
    if (available < BigInt(requiredBytes) + 16n * 1024n * 1024n) {
        throw new CrafletError(
            "BACKUP_SPACE",
            "Insufficient free space for the selected files and backup working data.",
            3,
        );
    }
}

export async function stageBackupPlan(
    plan: BackupPlan,
    directory: string,
    signal?: AbortSignal,
): Promise<BackupMetadata["files"]> {
    const manifest: BackupMetadata["files"] = [];
    for (const file of plan.files) {
        signal?.throwIfAborted();
        await assertNoSymlinks(file.source);
        const source = await open(
            file.source,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        let target: Awaited<ReturnType<typeof open>> | undefined;
        try {
            const before = await source.stat();
            if (
                !before.isFile() ||
                before.dev !== file.device ||
                before.ino !== file.inode ||
                before.size !== file.size ||
                before.mtimeMs !== file.mtimeMs ||
                before.ctimeMs !== file.ctimeMs
            ) {
                throw new CrafletError(
                    "BACKUP_SOURCE_CHANGED",
                    `Selected file changed after planning: ${file.source}`,
                    3,
                );
            }
            const destination = containedPath(directory, file.destination);
            await assertNoSymlinks(directory, file.destination);
            await mkdir(path.dirname(destination), {
                recursive: true,
                mode: 0o700,
            });
            target = await open(destination, "wx", 0o600);
            const hash = createHash("sha256");
            const chunk = Buffer.allocUnsafe(1024 * 1024);
            let bytes = 0;
            while (true) {
                signal?.throwIfAborted();
                const { bytesRead } = await source.read(
                    chunk,
                    0,
                    chunk.length,
                    null,
                );
                if (!bytesRead) break;
                bytes += bytesRead;
                if (bytes > file.size)
                    throw new CrafletError(
                        "BACKUP_SOURCE_CHANGED",
                        "A source file grew during staging.",
                        3,
                    );
                const data = chunk.subarray(0, bytesRead);
                hash.update(data);
                let offset = 0;
                while (offset < data.length) {
                    const written = await target.write(
                        data,
                        offset,
                        data.length - offset,
                        null,
                    );
                    if (written.bytesWritten === 0)
                        throw new CrafletError(
                            "BACKUP_WRITE",
                            "Could not write backup staging data.",
                            3,
                        );
                    offset += written.bytesWritten;
                }
            }
            const after = await source.stat();
            await assertNoSymlinks(file.source);
            const named = await lstat(file.source);
            if (
                bytes !== file.size ||
                before.mtimeMs !== after.mtimeMs ||
                before.ctimeMs !== after.ctimeMs ||
                named.ino !== before.ino ||
                named.dev !== before.dev
            ) {
                throw new CrafletError(
                    "BACKUP_SOURCE_CHANGED",
                    `Selected file changed while being copied: ${file.source}`,
                    3,
                );
            }
            await target.sync();
            await target.close();
            target = undefined;
            await utimes(
                destination,
                new Date(file.mtimeMs),
                new Date(file.mtimeMs),
            );
            manifest.push({
                destination: file.destination,
                sha256: hash.digest("hex"),
                size: bytes,
                mode: file.mode,
            });
        } finally {
            await target?.close();
            await source.close();
        }
    }
    return manifest;
}

export async function hashBackupFile(
    file: string,
): Promise<{ sha256: string; bytes: number }> {
    await assertNoSymlinks(file);
    const handle = await open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
        if (!(await handle.stat()).isFile())
            throw new CrafletError(
                "BACKUP_FILE",
                "Expected a regular backup file.",
                3,
            );
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of handle.createReadStream({
            autoClose: false,
        })) {
            hash.update(chunk);
            bytes += chunk.length;
        }
        return { sha256: hash.digest("hex"), bytes };
    } finally {
        await handle.close();
    }
}
