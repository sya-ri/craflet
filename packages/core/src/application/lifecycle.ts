import { assertStopped, shouldResumeBackup } from "../domain/deployment.js";
import { CrafletError } from "../domain/errors.js";
import type { ServerStatus } from "../ports/runtime.js";

export interface LifecyclePorts {
    status(): Promise<ServerStatus>;
    hasPending(): Promise<boolean>;
    preflight(applyPending: boolean): Promise<void>;
    stop(): Promise<ServerStatus>;
    verifyConfig(): Promise<void>;
    backup(): Promise<unknown>;
    apply(): Promise<void>;
    spawn(activeOnly: boolean): Promise<ServerStatus>;
}

export async function startServer(
    ports: LifecyclePorts,
    activeOnly = false,
): Promise<ServerStatus> {
    const status = await ports.status();
    if (status.status === "running") return status;
    assertStopped(status.status);
    const pending = !activeOnly && (await ports.hasPending());
    await ports.preflight(pending);
    if (pending) {
        await ports.verifyConfig();
        await ports.backup();
        await ports.apply();
    }
    return ports.spawn(activeOnly);
}

export async function restartServer(
    ports: LifecyclePorts,
    activeOnly = false,
): Promise<ServerStatus> {
    const before = await ports.status();
    if (before.status === "unknown")
        throw new CrafletError(
            "UNKNOWN_PROCESS",
            "Cannot restart an unidentified process.",
            3,
        );
    const pending = !activeOnly && (await ports.hasPending());
    await ports.preflight(pending);
    assertStopped((await ports.stop()).status);
    if (pending) {
        await ports.verifyConfig();
        await ports.backup();
        await ports.apply();
    }
    return ports.spawn(activeOnly);
}

export async function coldBackup<T>(
    ports: Pick<LifecyclePorts, "status" | "stop" | "spawn"> & {
        preflight(): Promise<void>;
        create(): Promise<T>;
    },
    leaveStopped = false,
): Promise<{ backup: T; resumed: boolean }> {
    const before = await ports.status();
    if (!["stopped", "running"].includes(before.status))
        throw new CrafletError(
            "BACKUP_STATE",
            `Cannot back up a server in ${before.status} state.`,
            3,
        );
    await ports.preflight();
    assertStopped((await ports.stop()).status);
    const backup = await ports.create();
    const resumed = shouldResumeBackup(
        before.status === "running",
        true,
        leaveStopped,
    );
    if (resumed) {
        try {
            if ((await ports.spawn(true)).status !== "running")
                throw new Error(
                    "The original server is not confirmed running.",
                );
        } catch {
            throw new CrafletError(
                "BACKUP_SAVED_RESTART_FAILED",
                "The backup was saved, but restarting the original active configuration failed.",
                1,
                "Inspect craflet status and logs; the snapshot is available in backup list.",
            );
        }
    }
    return { backup, resumed };
}
