import { createHash, randomUUID } from "node:crypto";
import {
    appendFile,
    mkdir,
    mkdtemp,
    open,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    truncate,
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
} from "@craflet/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeServerController } from "../../packages/adapters/src/runtime/controller.js";
import {
    runServerDaemon,
    runtimeEndpoint,
} from "../../packages/adapters/src/runtime/daemon.js";
import { javaExecutable } from "../../packages/adapters/src/runtime/java.js";
import {
    followServerLogsFrom,
    readOlderServerLogs,
    readRecentServerLogs,
    serverLogGeneration,
} from "../../packages/adapters/src/runtime/logs.js";
import { consumeLogLines } from "../../packages/adapters/src/runtime/output.js";
import {
    type RunnerRecord,
    runnerRequest,
} from "../../packages/adapters/src/runtime/protocol.js";
import { pingServer } from "../../packages/adapters/src/runtime/status-ping.js";
import { artifactZip } from "./artifacts-fixture.js";

let root: string;
const temporaryParent = await realpath(tmpdir());
let project: string;
let home: string;
const servers = new Set<net.Server>();
const sockets = new Set<net.Socket>();
const controllers: NodeServerController[] = [];
beforeEach(async () => {
    root = await mkdtemp(path.join(temporaryParent, "craflet-runtime-"));
    project = path.join(root, "server 日本語");
    home = path.join(root, "home");
    await mkdir(path.join(project, ".craflet"), { recursive: true });
    await mkdir(path.join(project, "runtime"));
});
afterEach(async () => {
    for (const controller of controllers.splice(0))
        await controller.stop().catch(() => {});
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const server of servers)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.clear();
    if (
        path.dirname(root) !== temporaryParent ||
        !path.basename(root).startsWith("craflet-runtime-")
    )
        throw new Error("Unsafe cleanup target");
    await rm(root, { recursive: true, force: true });
});
async function listen(handler: (socket: net.Socket) => void): Promise<number> {
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        handler(socket);
    });
    servers.add(server);
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    return (server.address() as net.AddressInfo).port;
}

async function shrinkAfterLogRead(file: string, readNumber: number) {
    const handle = await open(file, "r");
    const prototype = Object.getPrototypeOf(handle) as {
        read: (...args: unknown[]) => Promise<unknown>;
    };
    await handle.close();
    const original = prototype.read;
    let reads = 0;
    return vi.spyOn(prototype, "read").mockImplementation(async function (
        this: unknown,
        ...args: unknown[]
    ) {
        const result = await Reflect.apply(original, this, args);
        reads++;
        if (reads === readNumber) await truncate(file, 0);
        return result;
    });
}
function record(patch: Partial<RunnerRecord> = {}): RunnerRecord {
    return {
        protocol: 1,
        projectDir: project,
        token: randomUUID(),
        pid: process.pid,
        activeId: randomUUID(),
        port: 1,
        phase: "running",
        clean: true,
        startedAt: new Date().toISOString(),
        ...patch,
    };
}
async function putRecord(value: unknown): Promise<void> {
    await writeFile(
        path.join(project, ".craflet/runner.json"),
        JSON.stringify(value),
    );
}
async function active(timeout = 1) {
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
        name: "runtime",
        kind: "velocity",
        version: "4.1.1",
        source: `file:${source}`,
    });
    manifest.java = {
        command: process.execPath,
        args: [],
        startupTimeout: timeout,
        stopTimeout: 1,
    };
    const context = { ...(await loadProject(project, home)), manifest };
    await installProjects([context], new NodeArtifactStore(home), {});
    const state = await readState(project);
    if (!state.pending) throw new Error("Fixture installation missing");
    await saveState(project, { schemaVersion: 1, active: state.pending });
    return state.pending;
}
async function waitFor(
    predicate: () => Promise<boolean>,
    timeout = 3000,
): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
        if (Date.now() >= deadline)
            throw new Error("Fixture deadline exceeded");
        await delay(10);
    }
}

describe("bounded authenticated runner protocol over real loopback sockets", () => {
    it("transmits an authenticated command and preserves split UTF-8 responses", async () => {
        const identity = record();
        let request: unknown;
        identity.port = await listen((socket) =>
            socket.once("data", (data) => {
                request = JSON.parse(data.toString());
                const bytes = Buffer.from(
                    `${JSON.stringify({ ok: true, result: identity })}\n`,
                );
                const cut = bytes.indexOf(Buffer.from("日本語")) + 1;
                socket.write(bytes.subarray(0, cut));
                setImmediate(() => socket.end(bytes.subarray(cut)));
            }),
        );
        expect(await runnerRequest(identity, "command", "say 日本語")).toEqual(
            identity,
        );
        expect(request).toEqual({
            token: identity.token,
            command: "command",
            text: "say 日本語",
        });
    });
    it.each(
        ["not json\n", "null\n", "{}\n", '{"ok":"yes"}\n', '{"ok":true}\n'].map(
            (value) => ({ value }),
        ),
    )("rejects malformed envelopes: $value", async ({ value }) => {
        const identity = record({
            port: await listen((socket) =>
                socket.once("data", () => socket.end(value)),
            ),
        });
        await expect(runnerRequest(identity, "status")).rejects.toMatchObject({
            code: "RUNNER_PROTOCOL",
        });
    });
    it.each(["token", "pid", "activeId", "projectDir"] as const)(
        "rejects a changed %s before acknowledging success",
        async (field) => {
            const identity = record();
            const altered = {
                ...identity,
                [field]:
                    field === "pid"
                        ? process.pid + 1
                        : field === "projectDir"
                          ? "/another"
                          : randomUUID(),
            };
            identity.port = await listen((socket) =>
                socket.once("data", () =>
                    socket.end(
                        `${JSON.stringify({ ok: true, result: altered })}\n`,
                    ),
                ),
            );
            await expect(
                runnerRequest(identity, "status"),
            ).rejects.toMatchObject({ code: "RUNNER_PROTOCOL" });
        },
    );
    it("reports a rejected request without exposing server response data", async () => {
        const identity = record({
            port: await listen((socket) =>
                socket.once("data", () =>
                    socket.end('{"ok":false,"password":"hidden"}\n'),
                ),
            ),
        });
        await expect(runnerRequest(identity, "stop")).rejects.toMatchObject({
            code: "RUNNER_COMMAND",
        });
    });
    it.each(["timeout", "close", "oversize"])(
        "bounds incomplete response: %s",
        async (mode) => {
            const identity = record({
                port: await listen((socket) =>
                    socket.once("data", () => {
                        if (mode === "close") socket.end();
                        else if (mode === "oversize")
                            socket.end("x".repeat(70000));
                    }),
                ),
            });
            await expect(
                runnerRequest(identity, "status", undefined, 50),
            ).rejects.toMatchObject({ code: "RUNNER_UNREACHABLE" });
        },
    );
});

describe("server identity and control", () => {
    it("distinguishes no process, malformed state, and a stopped record with an uncleared lifetime guard", async () => {
        const controller = new NodeServerController(project, home);
        expect(await controller.status()).toEqual({ status: "stopped" });
        await putRecord({ token: "wrong" });
        expect(await controller.status()).toEqual({ status: "unknown" });
        await putRecord(
            record({ phase: "stopped", clean: false, exitCode: 1 }),
        );
        expect(await controller.status()).toEqual({
            status: "stopped",
            clean: false,
            exitCode: 1,
        });
        await mkdir(path.join(project, ".craflet/process.lock"));
        expect(await controller.status()).toEqual({ status: "unknown" });
        await expect(controller.stop(true)).rejects.toMatchObject({
            code: "UNKNOWN_PROCESS",
        });
        await expect(controller.start(randomUUID())).rejects.toMatchObject({
            code: "UNKNOWN_PROCESS",
        });
    });
    it.each([false, true])(
        "uses the same stopped guard and exit code for RPC responses (guard=%s)",
        async (guard) => {
            const identity = record();
            identity.port = await listen((socket) =>
                socket.once("data", () =>
                    socket.end(
                        `${JSON.stringify({
                            ok: true,
                            result: {
                                ...identity,
                                phase: "stopped",
                                clean: false,
                                exitCode: 17,
                            },
                        })}\n`,
                    ),
                ),
            );
            await putRecord(identity);
            if (guard) await mkdir(path.join(project, ".craflet/process.lock"));
            expect(
                await new NodeServerController(project, home).status(),
            ).toEqual(
                guard
                    ? { status: "unknown" }
                    : { status: "stopped", clean: false, exitCode: 17 },
            );
        },
    );
    it.each(["wrong-project", "oversize", "invalid-json", "unreachable"])(
        "never signals a process from %s state",
        async (mode) => {
            const identity = record(
                mode === "wrong-project" ? { projectDir: root } : {},
            );
            await putRecord(identity);
            if (mode === "oversize")
                await writeFile(
                    path.join(project, ".craflet/runner.json"),
                    "x".repeat(32769),
                );
            if (mode === "invalid-json")
                await writeFile(
                    path.join(project, ".craflet/runner.json"),
                    "{",
                );
            const controller = new NodeServerController(project, home);
            expect(await controller.status()).toEqual({ status: "unknown" });
            await expect(controller.stop()).rejects.toMatchObject({
                code: "UNKNOWN_PROCESS",
            });
        },
    );
    it.each([false, true])(
        "stops only through the recorded authenticated runner (force=%s)",
        async (force) => {
            let identity = record({ javaPid: process.pid + 1 });
            const requests: string[] = [];
            identity.port = await listen((socket) =>
                socket.once("data", (data) => {
                    void (async () => {
                        const request = JSON.parse(data.toString());
                        requests.push(request.command);
                        if (request.command.endsWith("stop")) {
                            identity = {
                                ...identity,
                                phase: "stopped",
                                exitCode: 0,
                            };
                            await putRecord(identity);
                        }
                        socket.end(
                            `${JSON.stringify({ ok: true, result: identity })}\n`,
                        );
                    })();
                }),
            );
            await putRecord(identity);
            const controller = new NodeServerController(project, home);
            expect(await controller.start(identity.activeId)).toMatchObject({
                status: "running",
                activeId: identity.activeId,
            });
            await expect(controller.start(randomUUID())).rejects.toMatchObject({
                code: "ACTIVE_MISMATCH",
            });
            await controller.command("say test");
            expect(await controller.stop(force)).toMatchObject({
                status: "stopped",
                exitCode: 0,
            });
            expect(requests).toContain(force ? "force-stop" : "stop");
            await expect(controller.command("say test")).rejects.toMatchObject({
                code: "NOT_RUNNING",
            });
        },
    );
    it.each(["", "a\nb", "a\rb", "a\0b", "a".repeat(8193)])(
        "rejects invalid command input",
        async (value) => {
            await expect(
                new NodeServerController(project, home).command(value),
            ).rejects.toMatchObject({ code: "COMMAND_INVALID" });
        },
    );
    it("refuses missing code and missing active state before spawning", async () => {
        await expect(
            new NodeServerController(project, home).start(randomUUID()),
        ).rejects.toMatchObject({ code: "RUNNER_MISSING" });
        await expect(
            new NodeServerController(project, home, "missing.mjs").start(
                randomUUID(),
            ),
        ).rejects.toMatchObject({ code: "ACTIVE_MISSING" });
        const aborted = new AbortController();
        aborted.abort(new Error("cancelled"));
        await expect(
            new NodeServerController(
                project,
                home,
                undefined,
                aborted.signal,
            ).start(randomUUID()),
        ).rejects.toThrow("cancelled");
    });
    it("reports early runner exit and rejects tampered cached runner code", async () => {
        const installation = await active();
        const entry = path.join(root, "entry.mjs");
        const source = "process.exit(1);\n";
        await writeFile(entry, source);
        const controller = new NodeServerController(project, home, entry);
        await expect(controller.start(installation.id)).rejects.toMatchObject({
            code: "RUNNER_EXITED",
        });
        const hash = createHash("sha256").update(source).digest("hex");
        const cached = path.join(home, "runners", "0.1.0", hash, "runner.mjs");
        expect(await readFile(cached, "utf8")).toBe(source);
        await writeFile(cached, "changed");
        await expect(controller.start(installation.id)).rejects.toMatchObject({
            code: "RUNNER_HASH",
        });
    });
});

function packet(text: string, id = 0): Buffer {
    const encode = (value: number) => {
        const bytes = [];
        do {
            const byte = value & 127;
            value >>>= 7;
            bytes.push(byte | (value ? 128 : 0));
        } while (value);
        return Buffer.from(bytes);
    };
    const json = Buffer.from(text);
    const body = Buffer.concat([encode(id), encode(json.length), json]);
    return Buffer.concat([encode(body.length), body]);
}
describe("Minecraft status framing and endpoint validation", () => {
    it("requires a real framed status response and accepts packet fragmentation", async () => {
        const value = {
            version: { name: "fixture", protocol: -1 },
            description: { text: "日本語" },
        };
        const bytes = packet(JSON.stringify(value));
        let handshake: Buffer | undefined;
        const port = await listen((socket) =>
            socket.once("data", (data) => {
                handshake = data;
                socket.write(bytes.subarray(0, 1));
                setImmediate(() => socket.end(bytes.subarray(1)));
            }),
        );
        expect(await pingServer("127.0.0.1", port)).toEqual(value);
        expect(handshake?.subarray(-2)).toEqual(Buffer.from([1, 0]));
    });
    it.each([
        { name: "not minecraft", bytes: packet("{}") },
        { name: "invalid JSON", bytes: packet("bad") },
        { name: "unexpected packet", bytes: packet('{"version":{}}', 1) },
        {
            name: "negative length",
            bytes: Buffer.from([255, 255, 255, 255, 15]),
        },
        {
            name: "invalid varint",
            bytes: Buffer.from([255, 255, 255, 255, 255, 1]),
        },
        { name: "empty packet", bytes: Buffer.from([1, 0]) },
        { name: "truncated json", bytes: Buffer.from([2, 0, 50]) },
        { name: "oversized", bytes: Buffer.alloc(1024 * 1024 + 1, 128) },
    ])("rejects $name", async ({ bytes }) => {
        const port = await listen((socket) => {
            socket.on("error", () => {});
            socket.once("data", () => socket.end(bytes));
        });
        await expect(pingServer("127.0.0.1", port, 200)).rejects.toThrow();
    });
    it("times out a listening port that is not a Minecraft server", async () => {
        const port = await listen(() => {});
        await expect(pingServer("127.0.0.1", port, 25)).rejects.toThrow(
            "timeout",
        );
    });
    it.each([
        {
            kind: "paper" as const,
            file: "server.properties",
            value: "server-ip=0.0.0.0\nserver-port=25566\n",
            expected: { host: "127.0.0.1", port: 25566 },
        },
        {
            kind: "paper" as const,
            file: "server.properties",
            value: "server-ip=192.0.2.1\n",
            expected: { host: "192.0.2.1", port: 25565 },
        },
        {
            kind: "velocity" as const,
            file: "velocity.toml",
            value: 'bind="[::]:25577"\n',
            expected: { host: "127.0.0.1", port: 25577 },
        },
        {
            kind: "velocity" as const,
            file: "velocity.toml",
            value: 'bind="localhost:25568"\n',
            expected: { host: "localhost", port: 25568 },
        },
        {
            kind: "velocity" as const,
            file: "velocity.toml",
            value: "# defaults\n",
            expected: { host: "127.0.0.1", port: 25565 },
        },
    ])(
        "reads $kind endpoint without shell interpretation",
        async ({ kind, file, value, expected }) => {
            expect(await runtimeEndpoint(project, kind)).toEqual({
                host: "127.0.0.1",
                port: 25565,
            });
            await writeFile(path.join(project, "runtime", file), value);
            expect(await runtimeEndpoint(project, kind)).toEqual(expected);
        },
    );
    it.each([
        {
            kind: "paper" as const,
            file: "server.properties",
            value: "server-port=0",
            code: "SERVER_PORT",
        },
        {
            kind: "velocity" as const,
            file: "velocity.toml",
            value: 'bind="no-port"',
            code: "SERVER_BIND",
        },
        {
            kind: "velocity" as const,
            file: "velocity.toml",
            value: 'bind="localhost:65536"',
            code: "SERVER_PORT",
        },
    ])(
        "rejects invalid $kind endpoint",
        async ({ kind, file, value, code }) => {
            await writeFile(path.join(project, "runtime", file), value);
            await expect(runtimeEndpoint(project, kind)).rejects.toMatchObject({
                code,
            });
        },
    );
});

describe("bounded logs and early daemon failures", () => {
    const recentText = async (lines = 100) =>
        (await readRecentServerLogs(project, lines)).text.trimEnd();

    it("keeps file identities above Number.MAX_SAFE_INTEGER exact", () => {
        const identity = { dev: 1n, birthtimeNs: 2n };
        expect(
            serverLogGeneration({
                ...identity,
                ino: 9_007_199_254_740_992n,
            }),
        ).not.toBe(
            serverLogGeneration({
                ...identity,
                ino: 9_007_199_254_740_993n,
            }),
        );
    });

    it("paginates complete UTF-8 and CRLF lines without gaps", async () => {
        const file = path.join(project, ".craflet/server.log");
        const boundary = `${"x".repeat(64 * 1024 - 3)}日本語`;
        await writeFile(file, `zero\r\n一\r\n\r\n${boundary}\r\nlast\n`);

        const recent = await readRecentServerLogs(project, 2);
        expect(recent.text).toBe(`${boundary}\nlast\n`);
        expect(recent.lineCount).toBe(2);
        expect(recent.older).not.toBeNull();
        if (!recent.older) throw new Error("Expected an older log page.");

        const middle = await readOlderServerLogs(project, recent.older, 2);
        expect(middle).toMatchObject({
            kind: "page",
            text: "一\n\n",
            lineCount: 2,
        });
        if (middle.kind !== "page" || !middle.older)
            throw new Error("Expected another older log page.");
        const oldest = await readOlderServerLogs(project, middle.older, 2);
        expect(oldest).toEqual({
            kind: "page",
            text: "zero\n",
            lineCount: 1,
            older: null,
        });
        if (oldest.kind !== "page")
            throw new Error("Expected the oldest log page.");
        expect(oldest.text + middle.text + recent.text).toBe(
            `zero\n一\n\n${boundary}\nlast\n`,
        );
    });
    it("walks backward through one oversized line with bounded pages", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, `old\n${"x".repeat(4 * 1024 * 1024)}`);

        const recent = await readRecentServerLogs(project, 2);
        expect(recent.text).toBe(
            "[craflet] Oversized server log line omitted.\n",
        );
        let cursor = recent.older;
        const pages: string[] = [];
        for (let index = 0; cursor && index < 5; index++) {
            const page = await readOlderServerLogs(project, cursor, 2);
            expect(page.kind).toBe("page");
            if (page.kind !== "page") break;
            pages.unshift(page.text);
            cursor = page.older;
        }
        expect(cursor).toBeNull();
        expect(pages.join("") + recent.text).toBe(
            "old\n[craflet] Oversized server log line omitted.\n",
        );
    });
    it("marks an older page stale after a same-length rewrite", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "old1\nold2\nlast\n");
        const recent = await readRecentServerLogs(project, 1);
        if (!recent.older) throw new Error("Expected an older log page.");
        const generation = serverLogGeneration(
            await stat(file, { bigint: true }),
        );

        await writeFile(file, "new1\nnew2\nlast\n");
        expect(serverLogGeneration(await stat(file, { bigint: true }))).toBe(
            generation,
        );

        expect(await readOlderServerLogs(project, recent.older, 1)).toEqual({
            kind: "stale",
        });
    });
    it("hands off the snapshot offset without losing concurrent appends", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "before\n");
        const recent = await readRecentServerLogs(project, 10);
        await appendFile(file, "between\n");

        const abort = new AbortController();
        const iterator = followServerLogsFrom(
            project,
            recent.follow,
            abort.signal,
        );
        expect(await iterator.next()).toEqual({
            done: false,
            value: {
                kind: "append",
                text: "between\n",
                lineCount: 1,
            },
        });
        abort.abort();
        expect((await iterator.next()).done).toBe(true);
    });
    it("resets follow after an observed prefix is rewritten at the same length", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "ready\n");
        const recent = await readRecentServerLogs(project, 1);
        const abort = new AbortController();
        const iterator = followServerLogsFrom(
            project,
            recent.follow,
            abort.signal,
        );

        await appendFile(file, "first\n");
        expect(await iterator.next()).toMatchObject({
            done: false,
            value: { kind: "append", text: "first\n" },
        });
        const generation = serverLogGeneration(
            await stat(file, { bigint: true }),
        );
        await writeFile(file, "ready\nother\n");
        expect(serverLogGeneration(await stat(file, { bigint: true }))).toBe(
            generation,
        );

        expect(await iterator.next()).toEqual({
            done: false,
            value: { kind: "reset" },
        });
        expect((await iterator.next()).done).toBe(true);
    });
    it("retries a recent snapshot if the open log shrinks after its page is read", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "one\ntwo\n");
        const fault = await shrinkAfterLogRead(file, 2);
        try {
            expect(await readRecentServerLogs(project, 10)).toMatchObject({
                text: "",
                lineCount: 0,
            });
        } finally {
            fault.mockRestore();
        }
    });
    it("marks an older page stale if the open log shrinks after reading", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "zero\none\ntwo\n");
        const recent = await readRecentServerLogs(project, 1);
        if (!recent.older) throw new Error("Expected an older log page.");
        const fault = await shrinkAfterLogRead(file, 1);
        try {
            expect(await readOlderServerLogs(project, recent.older, 1)).toEqual(
                { kind: "stale" },
            );
        } finally {
            fault.mockRestore();
        }
    });
    it("withholds an incomplete UTF-8 line until CRLF completes it", async () => {
        const file = path.join(project, ".craflet/server.log");
        const value = Buffer.from("日本語");
        await writeFile(
            file,
            Buffer.concat([Buffer.from("before\r\n"), value.subarray(0, 2)]),
        );
        const recent = await readRecentServerLogs(project, 10);
        expect(recent.text).toBe("before\n");

        const abort = new AbortController();
        const iterator = followServerLogsFrom(
            project,
            recent.follow,
            abort.signal,
        );
        const next = iterator.next();
        let settled = false;
        void next.then(() => {
            settled = true;
        });
        await appendFile(
            file,
            Buffer.concat([value.subarray(2), Buffer.from("\r")]),
        );
        await delay(200);
        expect(settled).toBe(false);
        await appendFile(file, "\n");
        expect(await next).toEqual({
            done: false,
            value: {
                kind: "append",
                text: "日本語\n",
                lineCount: 1,
            },
        });
        abort.abort();
        await iterator.next();
    });
    it("accepts a maximum-size line when CRLF crosses follow chunks", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "ready\n");
        const recent = await readRecentServerLogs(project, 1);
        const abort = new AbortController();
        const iterator = followServerLogsFrom(
            project,
            recent.follow,
            abort.signal,
        );
        const next = iterator.next();
        await appendFile(file, `${"x".repeat(256 * 1024)}\r`);
        await delay(200);
        await appendFile(file, "\n");
        const event = await next;
        expect(event.done).toBe(false);
        expect(event.value).toMatchObject({ kind: "append", lineCount: 1 });
        if (event.value?.kind === "append") {
            expect(event.value.text).toHaveLength(256 * 1024 + 1);
            expect(event.value.text).not.toContain("Oversized");
        }
        abort.abort();
        await iterator.next();
    });
    it("marks old cursors stale and closes follow after truncation", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "zero\none\ntwo\n");
        const recent = await readRecentServerLogs(project, 1);
        expect(recent.older).not.toBeNull();
        if (!recent.older) throw new Error("Expected an older log page.");
        await writeFile(file, "new\n");

        expect(await readOlderServerLogs(project, recent.older, 1)).toEqual({
            kind: "stale",
        });
        const iterator = followServerLogsFrom(
            project,
            recent.follow,
            new AbortController().signal,
        );
        expect(await iterator.next()).toEqual({
            done: false,
            value: { kind: "reset" },
        });
        expect((await iterator.next()).done).toBe(true);
    });
    it("stops checkpoint following promptly on abort", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "ready\n");
        const recent = await readRecentServerLogs(project);
        const abort = new AbortController();
        const iterator = followServerLogsFrom(
            project,
            recent.follow,
            abort.signal,
        );
        const waiting = iterator.next();
        abort.abort();
        expect((await waiting).done).toBe(true);
    });
    it("refuses an ancestor link when reading a log page", async () => {
        const linked = path.join(root, "linked-private");
        await mkdir(linked);
        await writeFile(path.join(linked, "server.log"), "outside\n");
        await rm(path.join(project, ".craflet"), {
            recursive: true,
            force: true,
        });
        await symlink(
            linked,
            path.join(project, ".craflet"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(readRecentServerLogs(project)).rejects.toMatchObject({
            code: "SYMLINK_UNSAFE",
        });
    });
    it("reads only requested tail lines and never splits oversized first lines", async () => {
        const file = path.join(project, ".craflet/server.log");
        expect(await recentText()).toBe("");
        await writeFile(
            file,
            `old\r\n${"x".repeat(4 * 1024 * 1024)}\r\nlast\r\n日本語\r\n`,
        );
        expect(await recentText(2)).toBe("last\n日本語");
        await writeFile(file, "x".repeat(4 * 1024 * 1024 + 1));
        expect(await recentText(2)).toBe(
            "[craflet] Oversized server log line omitted.",
        );
        await writeFile(file, "x".repeat(256 * 1024 + 2));
        expect(await recentText(2)).toBe(
            "[craflet] Oversized server log line omitted.",
        );
    });
    it("classifies incomplete lines exactly at the byte limit", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, "x".repeat(256 * 1024 + 1));
        expect(await recentText(1)).toBe(
            "[craflet] Oversized server log line omitted.",
        );

        await writeFile(file, `${"x".repeat(256 * 1024)}\r`);
        expect(await recentText(1)).toBe("");

        await writeFile(file, `old\n${"x".repeat(256 * 1024 + 1)}`);
        const recent = await readRecentServerLogs(project, 1);
        expect(recent.text).toBe(
            "[craflet] Oversized server log line omitted.\n",
        );
        expect(recent.older).not.toBeNull();
    });
    it("includes a bounded sentinel when an oversized line precedes the tail", async () => {
        const file = path.join(project, ".craflet/server.log");
        await writeFile(file, `${"x".repeat(2 * 1024 * 1024)}\nlast\n`);

        const recent = await readRecentServerLogs(project, 2);
        expect(recent).toMatchObject({
            text: "[craflet] Oversized server log line omitted.\nlast\n",
            lineCount: 2,
        });
        expect(recent.older).not.toBeNull();
        let cursor = recent.older;
        let pages = 0;
        while (cursor) {
            const page = await readOlderServerLogs(project, cursor, 2);
            expect(page).toMatchObject({
                kind: "page",
                text: "",
                lineCount: 0,
            });
            if (page.kind !== "page") break;
            cursor = page.older;
            pages++;
        }
        expect(pages).toBe(2);
    });
    it.each([0, 10001, -1, 1.5, Number.NaN])(
        "rejects unbounded log request %s",
        async (lines) => {
            await expect(recentText(lines)).rejects.toMatchObject({
                code: "LOG_LINES",
            });
        },
    );
    it("follows creation, split UTF-8 and truncation and stops promptly on abort", async () => {
        const file = path.join(project, ".craflet/server.log");
        const abort = new AbortController();
        const found: string[] = [];
        const reading = (async () => {
            let snapshot = await readRecentServerLogs(project, 1);
            while (!abort.signal.aborted) {
                let reset = false;
                for await (const event of followServerLogsFrom(
                    project,
                    snapshot.follow,
                    abort.signal,
                )) {
                    if (event.kind === "append") found.push(event.text);
                    else {
                        reset = true;
                        break;
                    }
                }
                if (!reset || abort.signal.aborted) return;
                snapshot = await readRecentServerLogs(project, 1);
                found.push(snapshot.text);
            }
        })();
        await delay(25);
        const japanese = Buffer.from("日本語\n");
        await writeFile(file, japanese.subarray(0, 2));
        await delay(200);
        await appendFile(file, japanese.subarray(2));
        await waitFor(async () => found.join("").includes("日本語"));
        await writeFile(file, "new\n");
        await waitFor(async () => found.join("").includes("new"));
        abort.abort();
        await reading;
        expect(found.join("")).not.toContain("�");
    });
    it("omits entire oversized lines so partial secret prefixes are not logged", async () => {
        const stream = new PassThrough();
        const lines: string[] = [];
        consumeLogLines(stream, (line) => lines.push(line), 8);
        stream.write("ok\r\nsecr");
        stream.write("et-too-long");
        stream.write("\nnext\n");
        stream.end("tail");
        await new Promise<void>((resolve) => stream.once("end", resolve));
        expect(lines).toEqual([
            "ok",
            "[craflet] Oversized server log line omitted.",
            "next",
            "tail",
        ]);
    });
    it("omits an oversized unterminated log line", async () => {
        const stream = new PassThrough();
        const lines: string[] = [];
        consumeLogLines(stream, (line) => lines.push(line), 2);
        stream.end("secret");
        await new Promise<void>((resolve) => stream.once("end", resolve));
        expect(lines).toEqual(["[craflet] Oversized server log line omitted."]);
    });
    it("refuses malformed launch requests and active mismatches without spawning", async () => {
        const file = path.join(project, ".craflet/runner-launch.json");
        await writeFile(file, "{}");
        await expect(runServerDaemon(project)).rejects.toMatchObject({
            code: "RUNNER_LAUNCH",
        });
        await writeFile(
            file,
            JSON.stringify({
                protocol: 1,
                token: randomUUID(),
                activeId: randomUUID(),
                home,
            }),
        );
        await expect(runServerDaemon(project)).rejects.toMatchObject({
            code: "RUNNER_ACTIVE",
        });
        await expect(
            stat(path.join(project, ".craflet/process.lock")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("records real executable failure and clears the owned guard without hanging", async () => {
        const installation = await active();
        await writeFile(
            path.join(project, ".craflet/runner-launch.json"),
            JSON.stringify({
                protocol: 1,
                token: randomUUID(),
                activeId: installation.id,
                home,
            }),
        );
        // The real Node process rejects Java's -jar argument. This is fault injection, not server E2E.
        await runServerDaemon(project);
        expect(
            await new NodeServerController(project, home).status(),
        ).toMatchObject({ status: "stopped", clean: false });
        await expect(
            stat(path.join(project, ".craflet/process.lock")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("does not replace another process lifetime guard", async () => {
        const installation = await active();
        await writeFile(
            path.join(project, ".craflet/runner-launch.json"),
            JSON.stringify({
                protocol: 1,
                token: randomUUID(),
                activeId: installation.id,
                home,
            }),
        );
        await mkdir(path.join(project, ".craflet/process.lock"));
        await expect(runServerDaemon(project)).rejects.toMatchObject({
            code: "RUNNER_GUARD",
        });
    });
    it("resolves an explicit executable and rejects relative command paths", async () => {
        expect(await javaExecutable(process.execPath)).toBe(process.execPath);
        await expect(javaExecutable("./java")).rejects.toMatchObject({
            code: "JAVA_PATH",
        });
        await expect(
            javaExecutable("craflet-test-java-not-installed"),
        ).rejects.toMatchObject({ code: "JAVA_MISSING" });
    });
});
