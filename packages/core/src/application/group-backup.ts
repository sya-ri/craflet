import { assertStopped } from "../domain/deployment.js";
import { CrafletError } from "../domain/errors.js";
import type { ServerStatus } from "../ports/runtime.js";

export interface GroupBackupMember {
    name: string;
    status(): Promise<ServerStatus>;
    stop(): Promise<ServerStatus>;
    startActive(): Promise<ServerStatus>;
}
export async function coldGroupBackup<T>(
    members: readonly GroupBackupMember[],
    prepare: () => Promise<void>,
    create: () => Promise<T>,
    leaveStopped = false,
): Promise<{ backup: T; resumed: string[] }> {
    if (!members.length)
        throw new CrafletError(
            "EMPTY_SELECTION",
            "A recovery group must contain at least one server.",
            2,
        );
    const running = new Set<string>();
    for (const member of members) {
        const status = await member.status();
        if (status.status === "running") running.add(member.name);
        else assertStopped(status.status);
    }
    await prepare();
    for (const member of members)
        if (running.has(member.name))
            assertStopped((await member.stop()).status);
    for (const member of members) assertStopped((await member.status()).status);
    const backup = await create();
    const resumed: string[] = [];
    if (!leaveStopped) {
        for (const member of members) {
            if (!running.has(member.name)) continue;
            try {
                if ((await member.startActive()).status !== "running")
                    throw new Error("Not ready");
                resumed.push(member.name);
            } catch {
                throw new CrafletError(
                    "BACKUP_SAVED_RESTART_FAILED",
                    `The complete group snapshot was saved, but ${member.name} did not become ready. Already resumed: ${resumed.join(", ") || "none"}. Pending was not applied.`,
                    4,
                );
            }
        }
    }
    return { backup, resumed };
}
