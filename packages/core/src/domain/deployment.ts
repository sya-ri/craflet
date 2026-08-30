import { CrafleetError } from "./errors.js";

export type RuntimeStatus =
    | "stopped"
    | "starting"
    | "running"
    | "stopping"
    | "unknown";
export function assertStopped(status: RuntimeStatus): void {
    if (status !== "stopped")
        throw new CrafleetError(
            "NOT_STOPPED",
            `Server is ${status}; no runtime files were changed.`,
            3,
            "Run crafleet stop and confirm termination first.",
        );
}

export function shouldResumeBackup(
    wasRunning: boolean,
    backupSucceeded: boolean,
    leaveStopped: boolean,
): boolean {
    return wasRunning && backupSucceeded && !leaveStopped;
}

export function mayRollback(
    phase: "prepared" | "applying" | "applied" | "spawned",
): boolean {
    return phase !== "spawned";
}
