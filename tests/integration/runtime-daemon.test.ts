import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
    initProject,
    installProjects,
    loadProject,
    NodeArtifactStore,
    readState,
    saveState,
} from "@crafleet/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeServerController } from "../../packages/adapters/src/runtime/controller.js";
import { runServerDaemon } from "../../packages/adapters/src/runtime/daemon.js";
import {
    type RunnerRecord,
    runnerRequest,
} from "../../packages/adapters/src/runtime/protocol.js";
import { artifactZip } from "./artifacts-fixture.js";

const injected = vi.hoisted(() => ({ spawn: vi.fn(), ping: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
    ...(await original<typeof import("node:child_process")>()),
    spawn: injected.spawn,
}));
vi.mock("../../packages/adapters/src/runtime/status-ping.js", () => ({
    pingServer: injected.ping,
}));

let root: string;
const temporaryParent = await realpath(tmpdir());
let project: string;
let home: string;
let child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
};
let task: Promise<void> | undefined;
let token: string;
let commands: string;
const connected = new Set<net.Socket>();

beforeEach(async () => {
    root = await mkdtemp(path.join(temporaryParent, "crafleet-daemon-fault-"));
    project = path.join(root, "project");
    home = path.join(root, "home");
    commands = "";
    token = randomUUID();
    task = undefined;
    child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(),
        pid: process.pid + 1000,
    });
    child.stdin.on("data", (chunk) => {
        commands += String(chunk);
    });
    child.kill.mockImplementation(() => {
        setImmediate(() => close(null));
        return true;
    });
    injected.spawn.mockReset().mockReturnValue(child);
    injected.ping
        .mockReset()
        .mockRejectedValue(new Error("Fault-injected status refusal"));
    const source = path.join(root, "server.jar");
    await writeFile(
        source,
        artifactZip([
            {
                name: "META-INF/MANIFEST.MF",
                content: "Manifest-Version: 1.0\n",
            },
        ]),
    );
    const manifest = await initProject(project, {
        name: "faults",
        kind: "velocity",
        version: "4.1.1",
        source: `file:${source}`,
    });
    manifest.java = {
        command: process.execPath,
        args: ["argument with spaces"],
        startupTimeout: 1,
        stopTimeout: 1,
    };
    const context = { ...(await loadProject(project, home)), manifest };
    await installProjects([context], new NodeArtifactStore(home), {});
    const installation = (await readState(project)).pending;
    if (!installation) throw new Error("Fixture missing");
    await saveState(project, { schemaVersion: 1, active: installation });
    await writeFile(
        path.join(project, ".crafleet/runner-launch.json"),
        JSON.stringify({ protocol: 1, token, activeId: installation.id, home }),
    );
});
function close(code: number | null): void {
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
    child.emit("close", code);
}
afterEach(async () => {
    close(1);
    for (const socket of connected) socket.destroy();
    connected.clear();
    await task?.catch(() => {});
    vi.unstubAllEnvs();
    if (
        path.dirname(root) !== temporaryParent ||
        !path.basename(root).startsWith("crafleet-daemon-fault-")
    )
        throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
});
async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const value = await probe().catch(() => undefined);
        if (value !== undefined) return value;
        await delay(10);
    }
    throw new Error("Fault fixture control deadline exceeded");
}
async function begin(): Promise<RunnerRecord> {
    task = runServerDaemon(project);
    void task.catch(() => {});
    return waitFor(async () => {
        const controller = new NodeServerController(project, home);
        const value = await controller.record();
        if (value?.port) {
            const response = await runnerRequest(
                value,
                "status",
                undefined,
                100,
            );
            return response as RunnerRecord;
        }
        return undefined;
    });
}
async function raw(
    identity: RunnerRecord,
    body: string | Buffer,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({
            host: "127.0.0.1",
            port: identity.port,
        });
        connected.add(socket);
        let result = "";
        socket.once("connect", () => socket.write(body));
        socket.on("data", (chunk) => {
            result += chunk.toString();
        });
        socket.once("error", reject);
        socket.once("close", () => {
            connected.delete(socket);
            resolve(result);
        });
    });
}

// These are controlled process/protocol failure tests, not substitutes for the real Java E2E suite.
describe("runner failure injection", () => {
    it("never kills on stop timeout and retains a recoverable authenticated stopping state", async () => {
        const identity = await begin();
        await expect(
            runnerRequest(identity, "stop", undefined, 2500),
        ).rejects.toMatchObject({ code: "STOP_TIMEOUT" });
        expect(commands).toBe("end\n");
        expect(child.kill).not.toHaveBeenCalled();
        expect(
            await new NodeServerController(project, home).status(),
        ).toMatchObject({ status: "stopping" });
        await expect(
            runnerRequest(identity, "command", "say ignored"),
        ).rejects.toMatchObject({ code: "RUNNER_COMMAND" });
        await runnerRequest(identity, "force-stop", undefined, 2500);
        await task;
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
        expect(
            await new NodeServerController(project, home).status(),
        ).toMatchObject({ status: "stopped", clean: false });
    });
    it("waits for the child close event rather than acknowledging only the stop command", async () => {
        const identity = await begin();
        let settled = false;
        const stopping = runnerRequest(identity, "stop", undefined, 2500).then(
            () => {
                settled = true;
            },
        );
        await waitFor(async () =>
            commands.includes("end") ? true : undefined,
        );
        expect(settled).toBe(false);
        expect(
            (await new NodeServerController(project, home).status()).status,
        ).toBe("stopping");
        close(0);
        await stopping;
        await task;
        expect(
            await new NodeServerController(project, home).status(),
        ).toMatchObject({ status: "stopped", clean: true, exitCode: 0 });
    });
    it.each([
        "not json\n",
        `${JSON.stringify({ token: "wrong", command: "status" })}\n`,
        `${JSON.stringify({ token: randomUUID(), command: "status" })}\n`,
    ])(
        "rejects unauthorized or malformed input without returning the token",
        async (body) => {
            const identity = await begin();
            const response = await raw(identity, body);
            expect(JSON.parse(response)).toEqual({ ok: false });
            expect(response).not.toContain(token);
            expect(child.kill).not.toHaveBeenCalled();
        },
    );
    it("bounds unterminated control messages", async () => {
        const identity = await begin();
        expect(await raw(identity, "x".repeat(17000))).toBe("");
    });
    it("rejects command injection and accepts exactly one command while startup is incomplete", async () => {
        const identity = await begin();
        await expect(
            runnerRequest(identity, "command", "say one\nstop"),
        ).rejects.toMatchObject({ code: "RUNNER_COMMAND" });
        await expect(
            runnerRequest(identity, "command", ""),
        ).rejects.toMatchObject({ code: "RUNNER_COMMAND" });
        await runnerRequest(identity, "command", "say 日本語");
        expect(commands).toBe("say 日本語\n");
        expect(injected.spawn).toHaveBeenCalledWith(
            process.execPath,
            ["argument with spaces", "-jar", "server.jar"],
            expect.objectContaining({
                cwd: path.join(project, "runtime"),
                windowsHide: true,
            }),
        );
    });
    it("cannot promote a stopped process from a late successful status response", async () => {
        let complete: (value: object) => void = () => {};
        injected.ping.mockImplementation(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        await begin();
        child.stdout.write("Done (1.0s)!\n");
        await waitFor(async () =>
            injected.ping.mock.calls.length > 0 ? true : undefined,
        );
        close(1);
        await waitFor(async () =>
            (await new NodeServerController(project, home).status()).status ===
            "stopped"
                ? true
                : undefined,
        );
        complete({ version: {} });
        await task;
        expect(
            (await new NodeServerController(project, home).status()).status,
        ).toBe("stopped");
    });
    it("does not consider a readiness log alone sufficient", async () => {
        await begin();
        child.stdout.write("Done (1.5s)!\n");
        await waitFor(async () =>
            injected.ping.mock.calls.length > 0 ? true : undefined,
        );
        expect(
            (await new NodeServerController(project, home).status()).status,
        ).toBe("starting");
        child.stdin.emit("error", new Error("input gone"));
        close(1);
        await task;
        expect(
            await readFile(path.join(project, ".crafleet/server.log"), "utf8"),
        ).toContain("input is no longer writable");
    });
    it("records spawn errors even when close arrives immediately afterwards", async () => {
        await begin();
        child.emit("error", new Error("ENOENT"));
        close(1);
        await task;
        expect(
            (await new NodeServerController(project, home).status()).status,
        ).toBe("stopped");
        expect(
            await readFile(path.join(project, ".crafleet/server.log"), "utf8"),
        ).toContain("Java could not be spawned");
    });
    it("never overwrites another lifetime guard during finalization", async () => {
        await begin();
        await writeFile(
            path.join(project, ".crafleet/process.lock/owner.json"),
            JSON.stringify({ token: randomUUID(), pid: process.pid }),
        );
        close(0);
        await task;
        expect(
            (
                await stat(path.join(project, ".crafleet/process.lock"))
            ).isDirectory(),
        ).toBe(true);
        expect(
            (await new NodeServerController(project, home).status()).status,
        ).toBe("unknown");
    });
    it("finishes after a durable cleanup failure while retaining unknown state for manual recovery", async () => {
        await begin();
        await rm(path.join(project, ".crafleet/process.lock/owner.json"));
        close(0);
        await task;
        expect(
            (await new NodeServerController(project, home).status()).status,
        ).toBe("unknown");
        expect(
            await readFile(path.join(project, ".crafleet/server.log"), "utf8"),
        ).toContain("cleanup failed");
    });
    it("uses graceful stop for runner termination signals", async () => {
        await begin();
        process.emit("SIGTERM");
        await waitFor(async () =>
            commands.includes("end") ? true : undefined,
        );
        expect(child.kill).not.toHaveBeenCalled();
        close(0);
        await task;
    });
});
