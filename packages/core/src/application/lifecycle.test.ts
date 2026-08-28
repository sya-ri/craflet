import { describe, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "../domain/deployment.js";
import type { ServerStatus } from "../ports/runtime.js";
import { coldBackup, restartServer, startServer } from "./lifecycle.js";

function lifecycle(status: RuntimeStatus = "stopped", pending = true) {
    const events: string[] = [];
    const ports = {
        status: vi.fn(async (): Promise<ServerStatus> => {
            events.push("status");
            return { status };
        }),
        hasPending: vi.fn(async () => {
            events.push("pending");
            return pending;
        }),
        preflight: vi.fn(async (apply: boolean) => {
            events.push(`preflight:${apply}`);
        }),
        stop: vi.fn(async (): Promise<ServerStatus> => {
            events.push("stop");
            return { status: "stopped", clean: true };
        }),
        verifyConfig: vi.fn(async () => {
            events.push("verify");
        }),
        backup: vi.fn(async () => {
            events.push("backup");
            return { snapshot: "saved" };
        }),
        apply: vi.fn(async () => {
            events.push("apply");
        }),
        spawn: vi.fn(async (activeOnly: boolean): Promise<ServerStatus> => {
            events.push(`spawn:${activeOnly}`);
            return { status: "running", activeId: "active" };
        }),
    };
    return { ports, events };
}

describe("start lifecycle", () => {
    it("backs up and applies only after preflight and configuration verification", async () => {
        const { ports, events } = lifecycle();
        await expect(startServer(ports)).resolves.toMatchObject({
            status: "running",
        });
        expect(events).toEqual([
            "status",
            "pending",
            "preflight:true",
            "verify",
            "backup",
            "apply",
            "spawn:false",
        ]);
        expect(ports.stop).not.toHaveBeenCalled();
    });

    it("returns an already running server without applying pending updates", async () => {
        const { ports, events } = lifecycle("running");
        await expect(startServer(ports)).resolves.toEqual({
            status: "running",
        });
        expect(events).toEqual(["status"]);
    });

    it.each(["unknown", "starting", "stopping"] as const)(
        "does not start over %s state",
        async (status) => {
            const { ports, events } = lifecycle(status);
            await expect(startServer(ports)).rejects.toMatchObject({
                code: "NOT_STOPPED",
            });
            expect(events).toEqual(["status"]);
        },
    );

    it("uses the active installation when explicitly requested", async () => {
        const { ports, events } = lifecycle();
        await startServer(ports, true);
        expect(events).toEqual(["status", "preflight:false", "spawn:true"]);
        expect(ports.hasPending).not.toHaveBeenCalled();
    });

    it("does not create an update backup when no deployment is pending", async () => {
        const { ports, events } = lifecycle("stopped", false);
        await startServer(ports);
        expect(events).toEqual([
            "status",
            "pending",
            "preflight:false",
            "spawn:false",
        ]);
    });

    it.each(["preflight", "verifyConfig", "backup", "apply"] as const)(
        "does not spawn after %s fails",
        async (stage) => {
            const { ports } = lifecycle();
            const failure = new Error(`${stage} failed`);
            ports[stage].mockRejectedValue(failure);
            await expect(startServer(ports)).rejects.toBe(failure);
            expect(ports.spawn).not.toHaveBeenCalled();
            if (stage !== "apply") expect(ports.apply).not.toHaveBeenCalled();
            if (stage === "preflight" || stage === "verifyConfig")
                expect(ports.backup).not.toHaveBeenCalled();
        },
    );
});

describe("restart lifecycle", () => {
    it("checks prerequisites before stopping and verifies stopped configuration before backup", async () => {
        const { ports, events } = lifecycle("running");
        await restartServer(ports);
        expect(events).toEqual([
            "status",
            "pending",
            "preflight:true",
            "stop",
            "verify",
            "backup",
            "apply",
            "spawn:false",
        ]);
    });

    it("leaves the server running when preflight fails", async () => {
        const { ports } = lifecycle("running");
        ports.preflight.mockRejectedValue(new Error("backup unavailable"));
        await expect(restartServer(ports)).rejects.toThrow(
            "backup unavailable",
        );
        expect(ports.stop).not.toHaveBeenCalled();
        expect(ports.apply).not.toHaveBeenCalled();
        expect(ports.spawn).not.toHaveBeenCalled();
    });

    it("rejects an unidentified process before any preflight or stop", async () => {
        const { ports, events } = lifecycle("unknown");
        await expect(restartServer(ports)).rejects.toMatchObject({
            code: "UNKNOWN_PROCESS",
        });
        expect(events).toEqual(["status"]);
    });

    it.each(["starting", "running", "stopping", "unknown"] as const)(
        "does not apply when stop reports %s",
        async (status) => {
            const { ports } = lifecycle("running");
            ports.stop.mockResolvedValue({ status });
            await expect(restartServer(ports)).rejects.toMatchObject({
                code: "NOT_STOPPED",
            });
            expect(ports.verifyConfig).not.toHaveBeenCalled();
            expect(ports.backup).not.toHaveBeenCalled();
            expect(ports.apply).not.toHaveBeenCalled();
            expect(ports.spawn).not.toHaveBeenCalled();
        },
    );

    it.each(["stop", "verifyConfig", "backup", "apply"] as const)(
        "does not proceed after %s rejects",
        async (stage) => {
            const { ports } = lifecycle("running");
            const failure = new Error(`${stage} failed`);
            ports[stage].mockRejectedValue(failure);
            await expect(restartServer(ports)).rejects.toBe(failure);
            expect(ports.spawn).not.toHaveBeenCalled();
            if (stage !== "apply") expect(ports.apply).not.toHaveBeenCalled();
        },
    );

    it("can restart the active version without consuming pending changes", async () => {
        const { ports, events } = lifecycle("running");
        await restartServer(ports, true);
        expect(events).toEqual([
            "status",
            "preflight:false",
            "stop",
            "spawn:true",
        ]);
    });

    it("can restart a stopped server without inventing a pending deployment", async () => {
        const { ports, events } = lifecycle("stopped", false);
        await restartServer(ports);
        expect(events).toEqual([
            "status",
            "pending",
            "preflight:false",
            "stop",
            "spawn:false",
        ]);
    });
});

describe("cold backup lifecycle", () => {
    function backup(status: RuntimeStatus = "running") {
        const fixture = lifecycle(status);
        const ports = {
            ...fixture.ports,
            preflight: vi.fn(async () => {
                fixture.events.push("backup-preflight");
            }),
            create: vi.fn(async () => {
                fixture.events.push("create");
                return { snapshot: "completed" };
            }),
        };
        return { ...fixture, ports };
    }

    it("resumes only the original active installation, never pending updates", async () => {
        const { ports, events } = backup();
        expect(await coldBackup(ports)).toEqual({
            backup: { snapshot: "completed" },
            resumed: true,
        });
        expect(events).toEqual([
            "status",
            "backup-preflight",
            "stop",
            "create",
            "spawn:true",
        ]);
        expect(ports.hasPending).not.toHaveBeenCalled();
        expect(ports.apply).not.toHaveBeenCalled();
        expect(ports.verifyConfig).not.toHaveBeenCalled();
    });

    it.each([
        ["stopped", false],
        ["running", true],
    ] as const)(
        "does not resume for %s / leaveStopped=%s",
        async (status, leaveStopped) => {
            const { ports } = backup(status);
            expect((await coldBackup(ports, leaveStopped)).resumed).toBe(false);
            expect(ports.spawn).not.toHaveBeenCalled();
        },
    );

    it.each(["unknown", "starting", "stopping"] as const)(
        "rejects %s state before preflight",
        async (status) => {
            const { ports, events } = backup(status);
            await expect(coldBackup(ports)).rejects.toMatchObject({
                code: "BACKUP_STATE",
            });
            expect(events).toEqual(["status"]);
        },
    );

    it("does not stop when backup prerequisites fail", async () => {
        const { ports } = backup();
        ports.preflight.mockRejectedValue(new Error("repository unavailable"));
        await expect(coldBackup(ports)).rejects.toThrow(
            "repository unavailable",
        );
        expect(ports.stop).not.toHaveBeenCalled();
        expect(ports.create).not.toHaveBeenCalled();
        expect(ports.spawn).not.toHaveBeenCalled();
    });

    it("does not back up or resume after stop fails", async () => {
        const { ports } = backup();
        ports.stop.mockRejectedValue(new Error("stop timeout"));
        await expect(coldBackup(ports)).rejects.toThrow("stop timeout");
        expect(ports.create).not.toHaveBeenCalled();
        expect(ports.spawn).not.toHaveBeenCalled();
    });

    it("does not back up without confirmed termination", async () => {
        const { ports } = backup();
        ports.stop.mockResolvedValue({ status: "stopping" });
        await expect(coldBackup(ports)).rejects.toMatchObject({
            code: "NOT_STOPPED",
        });
        expect(ports.create).not.toHaveBeenCalled();
    });

    it("leaves the server stopped when creating the backup fails", async () => {
        const { ports } = backup();
        ports.create.mockRejectedValue(new Error("dump failed"));
        await expect(coldBackup(ports)).rejects.toThrow("dump failed");
        expect(ports.spawn).not.toHaveBeenCalled();
        expect(ports.apply).not.toHaveBeenCalled();
    });

    it("distinguishes a saved backup from a failed restart", async () => {
        const { ports } = backup();
        ports.spawn.mockRejectedValue(new Error("start failed"));
        await expect(coldBackup(ports)).rejects.toMatchObject({
            code: "BACKUP_SAVED_RESTART_FAILED",
        });
        expect(ports.create).toHaveBeenCalledOnce();
        expect(ports.apply).not.toHaveBeenCalled();
    });

    it.each(["unknown", "starting", "stopping", "stopped"] as const)(
        "does not report resumed when spawn reports %s",
        async (status) => {
            const { ports } = backup();
            ports.spawn.mockResolvedValue({ status });
            await expect(coldBackup(ports)).rejects.toMatchObject({
                code: "BACKUP_SAVED_RESTART_FAILED",
            });
            expect(ports.create).toHaveBeenCalledOnce();
            expect(ports.apply).not.toHaveBeenCalled();
        },
    );
});
