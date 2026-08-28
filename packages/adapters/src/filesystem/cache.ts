import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { CrafletError, type LockedArtifact } from "@craflet/core";
import { type } from "arktype";
import {
    assertNoSymlinks,
    exists,
    readJson,
    withMutex,
    writeJson,
} from "./io.js";
import { loadProject, readLock } from "./projects.js";
import { readState } from "./state.js";

const RegistrySchema = type({
    "+": "reject",
    schemaVersion: "1",
    projects: "string[]",
});
async function registry(home: string): Promise<string[]> {
    const file = await assertNoSymlinks(home, "cache/projects.json");
    if (!(await exists(file))) return [];
    const invalid = () =>
        new CrafletError(
            "CACHE_REGISTRY",
            "The cache project registry is invalid; pruning is disabled.",
            3,
        );
    if ((await lstat(file)).size > 2 * 1024 * 1024) throw invalid();
    let raw: unknown;
    try {
        raw = await readJson<unknown>(file);
    } catch {
        throw invalid();
    }
    const value = RegistrySchema(raw);
    if (
        value instanceof type.errors ||
        value.projects.length > 10000 ||
        value.projects.some((dir) => !path.isAbsolute(dir))
    )
        throw invalid();
    return value.projects;
}
export async function registerCacheProject(
    home: string,
    projectDir: string,
): Promise<void> {
    await assertNoSymlinks(home, "cache");
    await withMutex(path.join(home, "cache/registry.lock"), async () => {
        const projects = await registry(home);
        const directory = path.resolve(projectDir);
        if (projects.some((existing) => key(existing) === key(directory)))
            return;
        await writeJson(path.join(home, "cache/projects.json"), {
            schemaVersion: 1,
            projects: [...projects, directory].sort(),
        });
    });
}
export interface CacheEntry {
    sha256: string;
    bytes: number;
    modifiedAt: string;
    valid?: boolean;
}
function key(directory: string): string {
    return process.platform === "linux"
        ? path.resolve(directory)
        : path.resolve(directory).toLowerCase();
}
export async function inspectArtifactCache(
    home: string,
    verify: boolean,
): Promise<{
    directory: string;
    bytes: number;
    entries: CacheEntry[];
    ignored: string[];
}> {
    const directory = await assertNoSymlinks(home, "cache/artifacts/sha256");
    if (!(await exists(directory)))
        return { directory, bytes: 0, entries: [], ignored: [] };
    const entries: CacheEntry[] = [];
    const ignored: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
            !/^[a-f0-9]{64}$/.test(entry.name) ||
            !entry.isDirectory() ||
            entry.isSymbolicLink()
        ) {
            ignored.push(entry.name);
            continue;
        }
        const file = await assertNoSymlinks(
            directory,
            `${entry.name}/artifact.jar`,
        );
        if (!(await exists(file))) {
            ignored.push(entry.name);
            continue;
        }
        const info = await lstat(file);
        if (!info.isFile()) {
            ignored.push(entry.name);
            continue;
        }
        let valid: boolean | undefined;
        if (verify) {
            const hash = createHash("sha256");
            for await (const chunk of createReadStream(file))
                hash.update(chunk);
            valid = hash.digest("hex") === entry.name;
        }
        entries.push({
            sha256: entry.name,
            bytes: info.size,
            modifiedAt: info.mtime.toISOString(),
            ...(valid !== undefined ? { valid } : {}),
        });
    }
    entries.sort((a, b) => a.sha256.localeCompare(b.sha256));
    return {
        directory,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        entries,
        ignored,
    };
}
export async function pruneArtifactCache(
    home: string,
    apply: boolean,
): Promise<{
    applied: boolean;
    candidates: CacheEntry[];
    retained: number;
    warnings: string[];
}> {
    const perform = async (ownedLocks: ReadonlySet<string> = new Set()) => {
        const cache = await inspectArtifactCache(home, false);
        const referenced = new Set<string>();
        const warnings: string[] = [];
        const retain = (artifacts: LockedArtifact[]) => {
            for (const artifact of artifacts) referenced.add(artifact.sha256);
        };
        for (const dir of await registry(home)) {
            try {
                const project = await loadProject(dir, home);
                const operationLock = path.join(
                    project.lockRoot,
                    ".craflet/operation.lock",
                );
                if (
                    (!ownedLocks.has(key(operationLock)) &&
                        (await exists(operationLock))) ||
                    (await exists(path.join(dir, ".craflet/deploy.json"))) ||
                    (await exists(path.join(dir, ".craflet/restore.json"))) ||
                    (await exists(
                        path.join(dir, ".craflet/import-incomplete.json"),
                    )) ||
                    (await exists(
                        path.join(
                            project.lockRoot,
                            ".craflet/manifest-transaction.json",
                        ),
                    )) ||
                    (await exists(
                        path.join(
                            project.lockRoot,
                            ".craflet/group-operation.json",
                        ),
                    )) ||
                    (await exists(
                        path.join(
                            project.lockRoot,
                            ".craflet/group-restore.json",
                        ),
                    ))
                )
                    throw new CrafletError(
                        "CACHE_BUSY",
                        "A registered project has an operation in progress or awaiting recovery.",
                        4,
                    );
                const locked = (await readLock(project.lockRoot)).projects[
                    project.lockKey
                ];
                if (locked)
                    retain([locked.server, ...Object.values(locked.plugins)]);
                const state = await readState(dir);
                for (const installation of [state.active, state.pending])
                    if (installation)
                        retain([
                            installation.lock.server,
                            ...Object.values(installation.lock.plugins),
                        ]);
            } catch (error) {
                if (
                    error instanceof CrafletError &&
                    error.code === "CACHE_BUSY"
                )
                    throw error;
                warnings.push(
                    "A registered project is missing or unreadable; no cache objects will be removed.",
                );
            }
        }
        // A grace period also protects objects being inspected before their first project registration.
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const candidates = warnings.length
            ? []
            : cache.entries.filter(
                  (entry) =>
                      !referenced.has(entry.sha256) &&
                      Date.parse(entry.modifiedAt) < cutoff,
              );
        if (apply) {
            // Check every deletion before removing the first cache object.
            const deletions: {
                directory: string;
                file: string;
                entry: CacheEntry;
            }[] = [];
            for (const entry of candidates) {
                const directory = await assertNoSymlinks(
                    cache.directory,
                    entry.sha256,
                );
                const children = await readdir(directory);
                if (children.some((child) => child !== "artifact.jar"))
                    throw new CrafletError(
                        "CACHE_UNEXPECTED",
                        "Unexpected files in a cache object; it was not removed.",
                        3,
                    );
                const file = await assertNoSymlinks(directory, "artifact.jar");
                const info = await lstat(file);
                if (
                    !info.isFile() ||
                    info.size !== entry.bytes ||
                    info.mtime.toISOString() !== entry.modifiedAt
                )
                    throw new CrafletError(
                        "CACHE_CHANGED",
                        "A cache object changed during prune planning; nothing was removed.",
                        3,
                    );
                deletions.push({ directory, file, entry });
            }
            for (const deletion of deletions) {
                await assertNoSymlinks(deletion.directory, "artifact.jar");
                const info = await lstat(deletion.file);
                if (
                    !info.isFile() ||
                    info.size !== deletion.entry.bytes ||
                    info.mtime.toISOString() !== deletion.entry.modifiedAt
                )
                    throw new CrafletError(
                        "CACHE_CHANGED",
                        "A cache object changed during pruning; remaining objects were retained.",
                        3,
                    );
                await rm(deletion.file);
                // Never recursively remove a directory that gained an unrecognized file.
                await rmdir(deletion.directory);
            }
        }
        return {
            applied: apply,
            candidates,
            retained: cache.entries.length - candidates.length,
            warnings,
        };
    };
    if (!apply) return perform();
    return withMutex(path.join(home, "cache/registry.lock"), async () => {
        const locks = new Map<string, string>();
        for (const dir of await registry(home)) {
            try {
                const project = await loadProject(dir, home);
                const lock = path.join(
                    project.lockRoot,
                    ".craflet/operation.lock",
                );
                locks.set(key(lock), lock);
            } catch {
                /* perform() will retain all objects if any registry entry is unreadable. */
            }
        }
        const values = [...locks.values()].sort();
        const owned = new Set<string>();
        const locked = async (
            index: number,
        ): Promise<Awaited<ReturnType<typeof perform>>> => {
            const file = values[index];
            if (!file) return perform(owned);
            try {
                return await withMutex(file, async () => {
                    owned.add(key(file));
                    return locked(index + 1);
                });
            } catch (error) {
                if (error instanceof CrafletError && error.code === "BUSY")
                    throw new CrafletError(
                        "CACHE_BUSY",
                        "A registered workspace is busy; no cache objects were removed.",
                        4,
                    );
                throw error;
            }
        };
        return locked(0);
    });
}
