// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Secret tokens are deliberately literal fixture data, not JavaScript interpolation.
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    discoverConfigCandidates,
    NodeConfigManager,
    normalizeConfigRelative,
} from "../../packages/adapters/src/filesystem/config.js";
import * as io from "../../packages/adapters/src/filesystem/io.js";
import { listFiles } from "../../packages/adapters/src/filesystem/io.js";
import { loadConfigSecrets } from "../../packages/adapters/src/filesystem/secrets.js";
import { parseConfigDocument } from "../../packages/adapters/src/formats/config.js";

const roots: string[] = [];
const temporaryParent = await realpath(os.tmpdir());

async function fixture(files: Record<string, string> = {}): Promise<string> {
    const root = await mkdtemp(path.join(temporaryParent, "crafleet-config-"));
    roots.push(root);
    for (const [relative, text] of Object.entries(files))
        await put(root, relative, text);
    return root;
}

async function put(
    root: string,
    relative: string,
    text: string,
): Promise<void> {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
}

const get = (root: string, relative: string) =>
    readFile(path.join(root, relative), "utf8");

afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
        if (
            path.dirname(root) !== temporaryParent ||
            !path.basename(root).startsWith("crafleet-config-")
        )
            throw new Error("Invalid test cleanup root");
        await rm(root, { recursive: true, force: true });
    }
});

describe("configuration capture and deployment", () => {
    it("tracks and captures prototype-like filenames without prototype mutation or missing observations", async () => {
        const root = await fixture();
        const manager = new NodeConfigManager(root);
        const names = ["__proto__", "constructor", "prototype", "toString"];
        for (const name of names) {
            await put(root, `runtime/${name}`, "original\n");
            await manager.track(name);
            await put(root, `runtime/${name}`, "changed\n");
        }
        expect((await manager.capture()).captured.sort()).toEqual(
            [...names].sort(),
        );
        for (const name of names)
            expect(await get(root, `config/${name}`)).toBe("changed\n");
        const prepared = await manager.prepare();
        expect(Object.getPrototypeOf(prepared.state.files)).toBeNull();
        expect(Object.keys(prepared.state.files).sort()).toEqual(
            [...names].sort(),
        );
        expect({}).not.toHaveProperty("observed");
        await manager.apply(prepared);
        await manager.untrack("__proto__");
        expect(
            Object.hasOwn((await manager.prepare()).state.files, "__proto__"),
        ).toBe(false);
    });
    it("tracks by mirrored path, retains pending base edits, and updates the observed runtime independently", async () => {
        const root = await fixture({
            "runtime/plugins/Example/config.yml":
                "# Operator note\nport: 25565\nmotd: old\n",
        });
        const manager = new NodeConfigManager(root);
        expect(await manager.list()).toEqual([]);
        await manager.track("plugins/Example/config.yml");
        await put(
            root,
            "config/plugins/Example/config.yml",
            "# Operator note\nport: 25566\nmotd: old\n",
        );
        await put(
            root,
            "runtime/plugins/Example/config.yml",
            "port: 25565\nmotd: new\n",
        );
        expect(await manager.capture()).toEqual({
            captured: ["plugins/Example/config.yml"],
            unchanged: [],
            conflicts: [],
        });
        expect(await get(root, "config/plugins/Example/config.yml")).toContain(
            "# Operator note",
        );
        expect(
            parseConfigDocument(
                "a.yml",
                await get(root, "config/plugins/Example/config.yml"),
            ).value,
        ).toEqual({ port: 25566n, motd: "new" });
        const state = JSON.parse(
            await get(root, ".crafleet/config-state.json"),
        ) as { files: Record<string, { observed: string }> };
        expect(state.files["plugins/Example/config.yml"]?.observed).toContain(
            "port: 25565",
        );
        expect((await manager.prepare()).files[0]?.content).toContain(
            "port: 25566",
        );
        await manager.capture();
        expect(await get(root, "config/plugins/Example/config.yml")).toContain(
            "port: 25566",
        );
    });

    it("does not rewrite a YAML base when capture has no semantic changes", async () => {
        const original = "# keep exact\r\nvalue: 'text' # note\r\n";
        const root = await fixture({ "runtime/a.yml": original });
        const manager = new NodeConfigManager(root);
        await manager.track("a.yml");
        const before = await stat(path.join(root, "config/a.yml"));
        const observation = await get(root, ".crafleet/config-state.json");
        expect(await manager.capture()).toEqual({
            captured: [],
            unchanged: ["a.yml"],
            conflicts: [],
        });
        const after = await stat(path.join(root, "config/a.yml"));
        expect([after.mtimeMs, after.ino]).toEqual([
            before.mtimeMs,
            before.ino,
        ]);
        expect(await get(root, ".crafleet/config-state.json")).toBe(
            observation,
        );
        await put(root, "runtime/a.yml", "value: text\n");
        await manager.capture();
        expect(await get(root, "config/a.yml")).toBe(original);
    });

    it("does not commit any file when one file conflicts, and resolves explicitly", async () => {
        const root = await fixture({
            "runtime/a.json": '{"value":1}',
            "runtime/b.json": '{"value":1}',
        });
        const manager = new NodeConfigManager(root);
        await manager.track("a.json");
        await manager.track("b.json");
        await put(root, "config/a.json", '{"value":2}');
        await put(root, "runtime/a.json", '{"value":3}');
        await put(root, "runtime/b.json", '{"value":4}');
        const state = await get(root, ".crafleet/config-state.json");
        expect(
            (await manager.diff()).find((file) => file.relative === "a.json")
                ?.conflicts,
        ).toEqual(["/value"]);
        expect((await manager.capture()).conflicts).toEqual([
            { relative: "a.json", paths: ["/value"] },
        ]);
        expect(await get(root, "config/b.json")).toBe('{"value":1}');
        expect(await get(root, ".crafleet/config-state.json")).toBe(state);
        await expect(manager.prepare()).rejects.toMatchObject({
            code: "CONFIG_CONFLICT",
        });
        await manager.resolve("a.json", "base");
        expect(
            (await manager.prepare()).files.find(
                (file) => file.relative === "a.json",
            )?.content,
        ).toBe('{"value":2}');
        await manager.resolve("b.json", "runtime");
        expect(await get(root, "config/b.json")).toBe('{"value":4}');
        await manager.capture();
        expect(await get(root, "config/a.json")).toBe('{"value":2}');
    });

    it("requires review for delete/change and propagates an uncontested deletion", async () => {
        const root = await fixture({ "runtime/a.json": '{"value":1}' });
        const manager = new NodeConfigManager(root);
        await manager.track("a.json");
        await put(root, "config/a.json", '{"value":2}');
        await rm(path.join(root, "runtime/a.json"));
        expect((await manager.capture()).conflicts).toHaveLength(1);
        expect(await get(root, "config/a.json")).toBe('{"value":2}');
        await manager.resolve("a.json", "runtime");
        await expect(get(root, "config/a.json")).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect((await manager.list())[0]).toMatchObject({
            baseExists: false,
            runtimeExists: false,
            observed: true,
        });
        expect((await manager.prepare()).files[0]?.content).toBeNull();
    });

    it("prepares without writing and rejects stale base, runtime, observations and file sets", async () => {
        const root = await fixture({ "config/a.json": '{"value":1}' });
        const manager = new NodeConfigManager(root);
        const first = await manager.prepare();
        await expect(
            get(root, ".crafleet/config-state.json"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await manager.assertUnchanged(first);
        await put(root, "config/a.json", '{"value":2}');
        await expect(manager.apply(first)).rejects.toMatchObject({
            code: "CONFIG_CHANGED",
        });
        await expect(get(root, "runtime/a.json")).rejects.toMatchObject({
            code: "ENOENT",
        });
        const second = await manager.prepare();
        await put(root, "config/extra.yml", "value: true\n");
        await expect(manager.assertUnchanged(second)).rejects.toMatchObject({
            code: "CONFIG_CHANGED",
        });
        await rm(path.join(root, "config/extra.yml"));
        await manager.apply(second);
        const third = await manager.prepare();
        await put(root, "runtime/a.json", '{"value":3}');
        await expect(manager.assertUnchanged(third)).rejects.toMatchObject({
            code: "CONFIG_CHANGED",
        });
        await manager.capture();
        await expect(manager.assertUnchanged(third)).rejects.toMatchObject({
            code: "CONFIG_CHANGED",
        });
    });

    it("preserves uncaptured runtime changes over repeated applies and permits a subsequent source edit", async () => {
        const root = await fixture({
            "runtime/a.json": '{"port":1,"motd":"old"}',
        });
        const manager = new NodeConfigManager(root);
        await manager.track("a.json");
        await put(root, "config/a.json", '{"port":2,"motd":"old"}');
        await put(root, "runtime/a.json", '{"port":1,"motd":"new"}');
        await manager.apply(await manager.prepare());
        expect(JSON.parse(await get(root, "runtime/a.json"))).toEqual({
            port: 2,
            motd: "new",
        });
        expect(JSON.parse(await get(root, "config/a.json"))).toEqual({
            port: 2,
            motd: "old",
        });
        await manager.apply(await manager.prepare());
        expect(JSON.parse(await get(root, "runtime/a.json"))).toEqual({
            port: 2,
            motd: "new",
        });
        await put(root, "config/a.json", '{"port":3,"motd":"old"}');
        await manager.apply(await manager.prepare());
        expect(JSON.parse(await get(root, "runtime/a.json"))).toEqual({
            port: 3,
            motd: "new",
        });
        await manager.capture();
        expect(JSON.parse(await get(root, "config/a.json"))).toEqual({
            port: 3,
            motd: "new",
        });
        await put(root, "config/a.json", '{"port":1,"motd":"new"}');
        await manager.apply(await manager.prepare());
        expect(JSON.parse(await get(root, "runtime/a.json"))).toEqual({
            port: 1,
            motd: "new",
        });
    });

    it("restores tokenized originals and observations without changing authored base edits", async () => {
        const root = await fixture({ "runtime/a.json": '{"value":1}' });
        const manager = new NodeConfigManager(root);
        await manager.track("a.json");
        await put(root, "config/a.json", '{"value":2}');
        await put(root, "config/new.json", '{"created":true}');
        const originalState = await get(root, ".crafleet/config-state.json");
        const bundle = await manager.prepare();
        await manager.apply(bundle);
        await manager.restore(
            JSON.parse(JSON.stringify(bundle)) as typeof bundle,
        );
        expect(await get(root, "runtime/a.json")).toBe('{"value":1}');
        expect(await get(root, "config/a.json")).toBe('{"value":2}');
        expect(await get(root, ".crafleet/config-state.json")).toBe(
            originalState,
        );
        await expect(get(root, "runtime/new.json")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await manager.restore(bundle);
    });

    it("refuses recovery over runtime or observation changes outside the deployment", async () => {
        const root = await fixture({ "runtime/a.json": '{"value":1}' });
        const manager = new NodeConfigManager(root);
        await manager.track("a.json");
        await put(root, "config/a.json", '{"value":2}');
        const bundle = await manager.prepare();
        await manager.apply(bundle);
        await put(root, "runtime/a.json", '{"value":99}');
        await expect(manager.restore(bundle)).rejects.toMatchObject({
            code: "CONFIG_RECOVERY_REQUIRED",
        });
        expect(await get(root, "runtime/a.json")).toBe('{"value":99}');
        await put(root, "runtime/a.json", '{"value":2}');
        await manager.capture();
        await expect(manager.restore(bundle)).rejects.toMatchObject({
            code: "CONFIG_RECOVERY_REQUIRED",
        });
    });

    it("untracks without touching runtime and does not reset an existing observation on track", async () => {
        const root = await fixture({ "runtime/a.txt": "original" });
        const manager = new NodeConfigManager(root);
        await manager.track("a.txt");
        await put(root, "runtime/a.txt", "changed");
        await manager.track("a.txt");
        expect((await manager.diff())[0]?.runtimeChanged).toBe(true);
        await manager.untrack("a.txt");
        expect(await manager.list()).toEqual([]);
        expect(await get(root, "runtime/a.txt")).toBe("changed");
        await expect(manager.untrack("a.txt")).rejects.toMatchObject({
            code: "CONFIG_NOT_TRACKED",
        });
        await expect(manager.track("missing.txt")).rejects.toMatchObject({
            code: "CONFIG_NOT_FOUND",
        });
        await expect(
            manager.resolve("missing.txt", "base"),
        ).rejects.toMatchObject({ code: "CONFIG_NOT_TRACKED" });
    });

    it("discovers known existing files, leaves bans optional, and ignores arbitrary plugin YAML", async () => {
        const root = await fixture({
            "runtime/server.properties": "motd=hello\n",
            "runtime/config/paper-global.yml": "version: 1\n",
            "runtime/custom-level/dimensions/custom/moon/paper-world.yml":
                "version: 1\n",
            "runtime/ops.json": "[]",
            "runtime/whitelist.json": "[]",
            "runtime/banned-ips.json": "[]",
            "runtime/plugins/Foo/player-cache.yml": "data: private\n",
            "runtime/velocity.toml": 'bind = "127.0.0.1:25577"\n',
        });
        const candidates = await discoverConfigCandidates(
            path.join(root, "runtime"),
            "paper",
        );
        expect(
            candidates.find((file) => file.relative === "banned-ips.json")
                ?.selectedByDefault,
        ).toBe(false);
        expect(
            candidates.some((file) => file.relative.startsWith("plugins/")),
        ).toBe(false);
        const manager = new NodeConfigManager(root);
        const dry = await manager.capture({
            initial: true,
            kind: "paper",
            dryRun: true,
        });
        expect(dry.captured).toContain("server.properties");
        await expect(
            get(root, "config/server.properties"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await manager.capture({ initial: true, kind: "paper" });
        expect(await get(root, "config/config/paper-global.yml")).toBe(
            "version: 1\n",
        );
        expect(
            (await manager.list()).map((file) => file.relative),
        ).not.toContain("banned-ips.json");
        await manager.capture({
            initial: true,
            kind: "paper",
            includeBans: true,
        });
        expect((await manager.list()).map((file) => file.relative)).toContain(
            "banned-ips.json",
        );
        expect(
            await discoverConfigCandidates(
                path.join(root, "runtime"),
                "velocity",
            ),
        ).toEqual([
            {
                relative: "velocity.toml",
                category: "configuration",
                selectedByDefault: true,
            },
        ]);
        await expect(manager.capture({ initial: true })).rejects.toMatchObject({
            code: "CONFIG_KIND",
        });
    });

    it("captures an explicit subset and reports missing selections", async () => {
        const root = await fixture({
            "runtime/a.txt": "a",
            "runtime/b.txt": "b",
        });
        const manager = new NodeConfigManager(root);
        await manager.track("a.txt");
        await manager.track("b.txt");
        await put(root, "runtime/a.txt", "A");
        await put(root, "runtime/b.txt", "B");
        await manager.capture({ paths: ["a.txt"] });
        expect(await get(root, "config/a.txt")).toBe("A");
        expect(await get(root, "config/b.txt")).toBe("b");
        await expect(
            manager.capture({ paths: ["missing.txt"] }),
        ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
    });

    it("reverts completed base writes if a later capture write fails", async () => {
        const root = await fixture({
            "runtime/a.txt": "old-a",
            "runtime/b.txt": "old-b",
        });
        const manager = new NodeConfigManager(root);
        await manager.track("a.txt");
        await manager.track("b.txt");
        const state = await get(root, ".crafleet/config-state.json");
        await put(root, "runtime/a.txt", "new-a");
        await put(root, "runtime/b.txt", "new-b");
        const write = io.atomicWrite;
        vi.spyOn(io, "atomicWrite").mockImplementation(
            async (file, content, mode) => {
                if (file === path.join(root, "config/b.txt"))
                    throw new Error("private backend details");
                return write(file, content, mode);
            },
        );
        await expect(manager.capture()).rejects.toMatchObject({
            code: "CONFIG_CAPTURE_FAILED",
        });
        expect(await get(root, "config/a.txt")).toBe("old-a");
        expect(await get(root, "config/b.txt")).toBe("old-b");
        expect(await get(root, ".crafleet/config-state.json")).toBe(state);
        expect(await get(root, "runtime/a.txt")).toBe("new-a");
    });

    it("does not overwrite an external edit during capture recovery", async () => {
        const root = await fixture({
            "runtime/a.txt": "old-a",
            "runtime/b.txt": "old-b",
        });
        const manager = new NodeConfigManager(root);
        await manager.track("a.txt");
        await manager.track("b.txt");
        await put(root, "runtime/a.txt", "new-a");
        await put(root, "runtime/b.txt", "new-b");
        const write = io.atomicWrite;
        vi.spyOn(io, "atomicWrite").mockImplementation(
            async (file, content, mode) => {
                if (file === path.join(root, "config/b.txt")) {
                    await put(root, "config/a.txt", "operator edit");
                    throw new Error("simulated failure");
                }
                return write(file, content, mode);
            },
        );
        await expect(manager.capture()).rejects.toMatchObject({
            code: "CONFIG_RECOVERY_REQUIRED",
        });
        expect(await get(root, "config/a.txt")).toBe("operator edit");
    });

    it("recovers a state write that committed before reporting failure", async () => {
        const root = await fixture({ "runtime/a.txt": "old" });
        const manager = new NodeConfigManager(root);
        await manager.track("a.txt");
        const state = await get(root, ".crafleet/config-state.json");
        await put(root, "runtime/a.txt", "new");
        const write = io.atomicWrite;
        let failed = false;
        vi.spyOn(io, "atomicWrite").mockImplementation(
            async (file, content, mode) => {
                await write(file, content, mode);
                if (
                    !failed &&
                    file === path.join(root, ".crafleet/config-state.json")
                ) {
                    failed = true;
                    throw new Error("post-commit failure");
                }
            },
        );
        await expect(manager.capture()).rejects.toMatchObject({
            code: "CONFIG_CAPTURE_FAILED",
        });
        expect(await get(root, "config/a.txt")).toBe("old");
        expect(await get(root, ".crafleet/config-state.json")).toBe(state);
    });

    it("can restore an interrupted runtime apply before any replacement process starts", async () => {
        const root = await fixture({
            "runtime/a.txt": "old-a",
            "runtime/b.txt": "old-b",
        });
        const manager = new NodeConfigManager(root);
        await manager.track("a.txt");
        await manager.track("b.txt");
        const state = await get(root, ".crafleet/config-state.json");
        await put(root, "config/a.txt", "new-a");
        await put(root, "config/b.txt", "new-b");
        const bundle = await manager.prepare();
        const write = io.atomicWrite;
        const fault = vi
            .spyOn(io, "atomicWrite")
            .mockImplementation(async (file, content, mode) => {
                if (file === path.join(root, "runtime/b.txt"))
                    throw new Error("write failed");
                return write(file, content, mode);
            });
        await expect(manager.apply(bundle)).rejects.toThrow();
        expect(await get(root, "runtime/a.txt")).toBe("new-a");
        expect(await get(root, "runtime/b.txt")).toBe("old-b");
        fault.mockRestore();
        await manager.restore(bundle);
        expect(await get(root, "runtime/a.txt")).toBe("old-a");
        expect(await get(root, "runtime/b.txt")).toBe("old-b");
        expect(await get(root, ".crafleet/config-state.json")).toBe(state);
    });

    it("does not turn a failed untrack into a runtime deletion", async () => {
        const root = await fixture({ "runtime/a.txt": "keep" });
        const manager = new NodeConfigManager(root);
        await manager.track("a.txt");
        const write = io.atomicWrite;
        const fault = vi
            .spyOn(io, "atomicWrite")
            .mockImplementation(async (file, content, mode) => {
                if (file === path.join(root, ".crafleet/config-state.json"))
                    throw new Error("state write failed");
                return write(file, content, mode);
            });
        await expect(manager.untrack("a.txt")).rejects.toThrow();
        fault.mockRestore();
        expect((await manager.prepare()).files[0]?.content).toBe("keep");
        expect(await get(root, "config/a.txt")).toBe("keep");
        expect(await get(root, "runtime/a.txt")).toBe("keep");
    });
});

describe("configuration security", () => {
    it("keeps secrets out of captured files, observations, bundles, and conflicts", async () => {
        const secret = 'fixture-secret:quote"\\newline\nend';
        const root = await fixture({
            ".secrets/password": `${secret}\n`,
            "runtime/settings.json": JSON.stringify({
                password: secret,
                port: 1,
            }),
        });
        const manager = new NodeConfigManager(root, {
            AUTH: { file: ".secrets/password" },
        });
        await manager.track("settings.json");
        await put(
            root,
            "config/settings.json",
            JSON.stringify({ password: "${secret:AUTH}", port: 2 }),
        );
        const bundle = await manager.prepare();
        expect(JSON.stringify(bundle)).not.toContain("fixture-secret");
        await manager.apply(bundle);
        expect(JSON.parse(await get(root, "runtime/settings.json"))).toEqual({
            password: secret,
            port: 2,
        });
        await manager.restore(bundle);
        expect(JSON.parse(await get(root, "runtime/settings.json"))).toEqual({
            password: secret,
            port: 1,
        });
        for (const relative of await listFiles(path.join(root, ".crafleet")))
            expect(await get(root, `.crafleet/${relative}`)).not.toContain(
                "fixture-secret",
            );
        expect(await get(root, "config/settings.json")).toContain(
            "${secret:AUTH}",
        );
        await put(
            root,
            "runtime/settings.json",
            JSON.stringify({ elsewhere: secret, port: 1 }),
        );
        await expect(manager.capture()).rejects.toMatchObject({
            code: "SECRET_LOCATION",
        });
        expect(await get(root, "config/settings.json")).not.toContain(
            "fixture-secret",
        );
    });

    it("rejects bad persisted state and forged bundles without leaking their contents", async () => {
        const root = await fixture({ "config/a.txt": "safe" });
        const manager = new NodeConfigManager(root);
        const bundle = await manager.prepare();
        const other = new NodeConfigManager(await fixture());
        await expect(other.assertUnchanged(bundle)).rejects.toMatchObject({
            code: "CONFIG_BUNDLE_INVALID",
        });
        await expect(
            manager.assertUnchanged({
                ...bundle,
                stateFingerprint: "f".repeat(64),
            }),
        ).rejects.toMatchObject({ code: "CONFIG_BUNDLE_INVALID" });
        await expect(
            manager.assertUnchanged({
                ...bundle,
                files: [...bundle.files, ...bundle.files],
            }),
        ).rejects.toMatchObject({ code: "CONFIG_BUNDLE_INVALID" });
        await expect(
            manager.assertUnchanged({
                ...bundle,
                files: bundle.files.map((file) => ({
                    ...file,
                    content: "forged",
                })),
            }),
        ).rejects.toMatchObject({ code: "CONFIG_BUNDLE_INVALID" });
        await put(
            root,
            ".crafleet/config-state.json",
            '{"do-not-print-credential"',
        );
        await expect(manager.list()).rejects.toMatchObject({
            code: "CONFIG_STATE_INVALID",
        });
        try {
            await manager.list();
        } catch (error) {
            expect(String(error)).not.toContain("do-not-print-credential");
        }
        await put(
            root,
            ".crafleet/config-state.json",
            JSON.stringify({
                schemaVersion: 1,
                files: {
                    "../outside.txt": { observed: "do-not-print-credential" },
                },
            }),
        );
        await expect(manager.list()).rejects.toMatchObject({
            code: "CONFIG_PATH",
        });
    });

    it.each([
        "../secret",
        "/absolute",
        "C:/absolute",
        "a/../b",
        "a//b",
        "a:stream",
        "NUL.txt",
        "dir/file.",
        "plugin.JAR",
        "",
    ])("rejects nonportable or escaping path %s", async (relative) => {
        expect(() => normalizeConfigRelative(relative)).toThrow();
    });

    it("normalizes Windows separators but refuses links in either managed tree", async () => {
        expect(normalizeConfigRelative("plugins\\Example\\config.yml")).toBe(
            "plugins/Example/config.yml",
        );
        const root = await fixture({
            "outside/a.txt": "do not touch",
            "config/linked/a.txt": "desired",
        });
        await mkdir(path.join(root, "runtime"));
        await symlink(
            path.join(root, "outside"),
            path.join(root, "runtime/linked"),
            process.platform === "win32" ? "junction" : "dir",
        );
        const manager = new NodeConfigManager(root);
        await expect(manager.prepare()).rejects.toMatchObject({
            code: "SYMLINK_UNSAFE",
        });
        expect(await get(root, "outside/a.txt")).toBe("do not touch");
        const base = await fixture({ "outside/a.txt": "data" });
        await symlink(
            path.join(base, "outside"),
            path.join(base, "config"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(new NodeConfigManager(base).list()).rejects.toMatchObject({
            code: "SYMLINK_UNSAFE",
        });
    });

    it("reads bounded secret files, rejects escaping references, and preserves meaningful spaces", async () => {
        const root = await fixture({
            ".secrets/value": " fixture-password \r\n",
            ".secrets/invalid": "",
        });
        const secrets = await loadConfigSecrets(root, {
            AUTH: { file: ".secrets/value" },
        });
        expect(secrets.inject("a.txt", "${secret:AUTH}")).toBe(
            " fixture-password ",
        );
        await expect(
            loadConfigSecrets(root, { AUTH: { file: "../outside" } }),
        ).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
        await expect(
            loadConfigSecrets(root, { AUTH: { file: ".secrets/missing" } }),
        ).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
        await expect(
            loadConfigSecrets(root, { AUTH: { file: ".secrets/invalid" } }),
        ).rejects.toMatchObject({ code: "SECRET_AMBIGUOUS" });
    });

    it("rejects invalid UTF-8 and non-file runtime targets without showing bytes", async () => {
        const root = await fixture({ "config/a.txt": "safe" });
        await writeFile(
            path.join(root, "config/a.txt"),
            Buffer.from([0xc3, 0x28]),
        );
        await expect(
            new NodeConfigManager(root).prepare(),
        ).rejects.toMatchObject({ code: "CONFIG_UNREADABLE" });
        await put(root, "config/a.txt", "safe");
        await mkdir(path.join(root, "runtime/a.txt"), { recursive: true });
        await expect(
            new NodeConfigManager(root).prepare(),
        ).rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });
    });
});
