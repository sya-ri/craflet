import { describe, expect, it } from "vitest";
import type { RuntimeStatus } from "../domain/deployment.js";
import { coldGroupBackup, type GroupBackupMember } from "./group-backup.js";

function scenario(states: RuntimeStatus[] = ["running", "running"]) {
    const events: string[] = [];
    const members: GroupBackupMember[] = states.map((initial, index) => {
        let status = initial;
        return {
            name: `server-${index}`,
            status: async () => ({ status }),
            stop: async () => {
                events.push(`stop-${index}`);
                status = "stopped";
                return { status };
            },
            startActive: async () => {
                events.push(`active-${index}`);
                status = "running";
                return { status };
            },
        };
    });
    const prepare = async () => {
        events.push("prepare");
    };
    const create = async () => {
        events.push("snapshot");
        return "snapshot-id";
    };
    return { events, members, prepare, create };
}
describe("cold recovery group", () => {
    it("stops every writer before the first snapshot and resumes the same active", async () => {
        const s = scenario();
        expect(await coldGroupBackup(s.members, s.prepare, s.create)).toEqual({
            backup: "snapshot-id",
            resumed: ["server-0", "server-1"],
        });
        expect(s.events).toEqual([
            "prepare",
            "stop-0",
            "stop-1",
            "snapshot",
            "active-0",
            "active-1",
        ]);
    });
    it.each([true, false])(
        "does not start previously stopped members; leaveStopped=%s",
        async (leaveStopped) => {
            const s = scenario(["stopped", "running"]);
            const result = await coldGroupBackup(
                s.members,
                s.prepare,
                s.create,
                leaveStopped,
            );
            expect(result.resumed).toEqual(leaveStopped ? [] : ["server-1"]);
            expect(s.events).not.toContain("active-0");
        },
    );
    it.each(["starting", "stopping", "unknown"] as RuntimeStatus[])(
        "rejects %s before preparation or stop",
        async (state) => {
            const s = scenario(["running", state]);
            await expect(
                coldGroupBackup(s.members, s.prepare, s.create),
            ).rejects.toThrow();
            expect(s.events).toEqual([]);
        },
    );
    it("rejects an empty selection", async () => {
        await expect(
            coldGroupBackup(
                [],
                async () => {},
                async () => "x",
            ),
        ).rejects.toMatchObject({ code: "EMPTY_SELECTION" });
    });
    it("never stops after a failed preflight", async () => {
        const s = scenario();
        await expect(
            coldGroupBackup(
                s.members,
                async () => {
                    throw new Error("unmounted");
                },
                s.create,
            ),
        ).rejects.toThrow("unmounted");
        expect(s.events).toEqual([]);
    });
    it("does not snapshot or resume after an unconfirmed stop", async () => {
        const s = scenario();
        const second = s.members[1];
        if (!second) throw new Error("Missing fixture member");
        second.stop = async () => ({ status: "stopping" });
        await expect(
            coldGroupBackup(s.members, s.prepare, s.create),
        ).rejects.toThrow();
        expect(s.events).toEqual(["prepare", "stop-0"]);
    });
    it("rechecks all members immediately before saving", async () => {
        const s = scenario(["stopped"]);
        let checks = 0;
        const first = s.members[0];
        if (!first) throw new Error("Missing fixture member");
        first.status = async () => ({
            status: ++checks === 1 ? "stopped" : "running",
        });
        await expect(
            coldGroupBackup(s.members, s.prepare, s.create),
        ).rejects.toThrow();
        expect(s.events).toEqual(["prepare"]);
    });
    it("keeps the group stopped after a failed snapshot", async () => {
        const s = scenario();
        await expect(
            coldGroupBackup(s.members, s.prepare, async () => {
                throw new Error("disk full");
            }),
        ).rejects.toThrow("disk full");
        expect(s.events).toEqual(["prepare", "stop-0", "stop-1"]);
    });
    it.each([true, false])(
        "distinguishes a saved backup from restart failure (throws=%s)",
        async (throws) => {
            const s = scenario();
            const second = s.members[1];
            if (!second) throw new Error("Missing fixture member");
            second.startActive = async () => {
                if (throws) throw new Error("startup");
                return { status: "unknown" };
            };
            await expect(
                coldGroupBackup(s.members, s.prepare, s.create),
            ).rejects.toMatchObject({
                code: "BACKUP_SAVED_RESTART_FAILED",
                exitCode: 4,
            });
            expect(s.events).toContain("snapshot");
        },
    );
});
