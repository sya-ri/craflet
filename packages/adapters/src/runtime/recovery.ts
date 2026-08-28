import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { CrafletError } from "@craflet/core";
import { type } from "arktype";
import {
    assertNoSymlinks,
    exists,
    withMutex,
    writeJson,
} from "../filesystem/io.js";
import type { ProjectContext } from "../filesystem/projects.js";
import { NodeServerController } from "./controller.js";

const OwnerSchema = type({
    "+": "reject",
    pid: "number.integer > 0",
    "token?": "string.uuid",
    "started?": "string",
});
export function processDefinitelyExited(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
}
export async function recoverProcessLocks(
    project: ProjectContext,
    dryRun = false,
): Promise<void> {
    const perform = async () => {
        const recordFile = await assertNoSymlinks(
            project.dir,
            ".craflet/runner.json",
        );
        if (
            (await exists(recordFile)) &&
            (!(await lstat(recordFile)).isFile() ||
                (await lstat(recordFile)).size > 64 * 1024)
        )
            throw new CrafletError(
                "UNKNOWN_PROCESS",
                "The runner ownership record is invalid; no locks were removed.",
                4,
            );
        const controller = new NodeServerController(project.dir, project.home);
        const status = await controller.status();
        if (status.status !== "stopped" && status.status !== "unknown")
            throw new CrafletError(
                "RECOVERY_RUNNING",
                "The authenticated server must stop before lock recovery.",
                3,
            );
        const record = await controller.record();
        if (!record && (await exists(recordFile)))
            throw new CrafletError(
                "UNKNOWN_PROCESS",
                "The runner ownership record is unreadable; no locks were removed.",
                4,
            );
        const removals: {
            directory: string;
            file: string;
            raw: string;
            pid: number;
        }[] = [];
        const owner = async (directory: string) => {
            const invalid = () =>
                new CrafletError(
                    "LOCK_OWNER",
                    "The lock owner is alive or unidentifiable; all locks were retained.",
                    4,
                );
            if (
                !(await lstat(directory)).isDirectory() ||
                (await readdir(directory)).some(
                    (entry) => entry !== "owner.json",
                )
            )
                throw invalid();
            const file = await assertNoSymlinks(directory, "owner.json");
            if (
                !(await exists(file)) ||
                !(await lstat(file)).isFile() ||
                (await lstat(file)).size > 64 * 1024
            )
                throw invalid();
            const raw = await readFile(file, "utf8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw invalid();
            }
            const value = OwnerSchema(parsed);
            if (
                value instanceof type.errors ||
                !processDefinitelyExited(value.pid)
            )
                throw invalid();
            removals.push({ directory, file, raw, pid: value.pid });
            return value;
        };
        const guard = await assertNoSymlinks(
            project.dir,
            ".craflet/process.lock",
        );
        const hasGuard = await exists(guard);
        if (hasGuard) {
            const value = await owner(guard);
            if (
                !record ||
                record.token !== value.token ||
                record.pid !== value.pid ||
                (!record.javaPid && record.phase !== "stopped")
            )
                throw new CrafletError(
                    "UNKNOWN_PROCESS",
                    "Cannot prove that no Java process remains. Inspect the server manually; this ambiguous guard was retained.",
                    4,
                );
            if (record.javaPid && !processDefinitelyExited(record.javaPid))
                throw new CrafletError(
                    "UNKNOWN_PROCESS",
                    "The recorded Java PID is alive or reused; refusing to modify its ownership records.",
                    4,
                );
        } else if (record && record.phase !== "stopped") {
            throw new CrafletError(
                "UNKNOWN_PROCESS",
                "Runner state is incomplete and cannot be recovered automatically.",
                4,
            );
        }
        const lock = await assertNoSymlinks(
            project.lockRoot,
            ".craflet/operation.lock",
        );
        if (await exists(lock)) await owner(lock);
        if (dryRun) return;
        for (const removal of removals) {
            await assertNoSymlinks(removal.directory, "owner.json");
            if (
                (await readFile(removal.file, "utf8")) !== removal.raw ||
                !processDefinitelyExited(removal.pid)
            )
                throw new CrafletError(
                    "LOCK_CHANGED",
                    "Lock ownership changed during recovery; nothing was removed.",
                    4,
                );
        }
        if (
            JSON.stringify(await controller.record()) !==
                JSON.stringify(record) ||
            (hasGuard &&
                record?.javaPid &&
                !processDefinitelyExited(record.javaPid))
        )
            throw new CrafletError(
                "LOCK_CHANGED",
                "Runner ownership changed during recovery; nothing was removed.",
                4,
            );
        if (hasGuard && record)
            await writeJson(recordFile, {
                ...record,
                phase: "stopped",
                clean: false,
            });
        for (const removal of removals) {
            await rm(removal.file);
            await rmdir(removal.directory);
        }
    };
    if (dryRun) return perform();
    return withMutex(
        path.join(project.lockRoot, ".craflet/recovery.lock"),
        perform,
    );
}
