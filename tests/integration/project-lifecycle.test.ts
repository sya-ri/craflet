import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    chmod,
    copyFile,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
    type ArtifactContext,
    type ArtifactStore,
    type BackupService,
    CrafleetError,
    type LockedArtifact,
    newProject,
    parseSource,
    type SourceInput,
    stableStringify,
} from "@crafleet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeArtifactStore } from "../../packages/adapters/src/filesystem/artifact-store.js";
import * as backupFiles from "../../packages/adapters/src/filesystem/backup-files.js";
import {
    inspectArtifactCache,
    pruneArtifactCache,
    registerCacheProject,
} from "../../packages/adapters/src/filesystem/cache.js";
import { NodeConfigManager } from "../../packages/adapters/src/filesystem/config.js";
import { NodeDeploymentManager } from "../../packages/adapters/src/filesystem/deployment.js";
import {
    hasAcceptedEula,
    readEulaDocument,
} from "../../packages/adapters/src/filesystem/eula.js";
import { ensureUserEulaConsent } from "../../packages/adapters/src/filesystem/eula-consent.js";
import { importProject } from "../../packages/adapters/src/filesystem/import.js";
import {
    assertManifestJournalLimits,
    installProjects,
    recoverManifests,
    validateInstallRequest,
} from "../../packages/adapters/src/filesystem/installations.js";
import * as io from "../../packages/adapters/src/filesystem/io.js";
import { addPlugins } from "../../packages/adapters/src/filesystem/plugin-commands.js";
import {
    ensurePrivateDirectory,
    ensurePrivateFile,
} from "../../packages/adapters/src/filesystem/private.js";
import {
    initProject,
    initWorkspace,
    loadProject,
    MAX_YAML_BYTES,
    type ProjectContext,
    readLock,
    readYaml,
    selectProjects,
    workspaceProjects,
    writeYaml,
    yamlText,
} from "../../packages/adapters/src/filesystem/projects.js";
import {
    type Installation,
    readState,
    saveState,
} from "../../packages/adapters/src/filesystem/state.js";
import { validateManagedProject } from "../../packages/adapters/src/filesystem/validation.js";
import { NodeServerController } from "../../packages/adapters/src/runtime/controller.js";
import * as java from "../../packages/adapters/src/runtime/java.js";
import type { RunnerRecord } from "../../packages/adapters/src/runtime/protocol.js";
import {
    processDefinitelyExited,
    recoverProcessLocks,
} from "../../packages/adapters/src/runtime/recovery.js";
import { artifactJar, artifactZip } from "./artifacts-fixture.js";

const temporaryRoots: string[] = [];
const temporaryParent = await realpath(os.tmpdir());

async function directory(): Promise<string> {
    const root = await mkdtemp(path.join(temporaryParent, "crafleet-project-"));
    temporaryRoots.push(root);
    return root;
}

afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of temporaryRoots.splice(0)) {
        if (
            path.dirname(root) !== temporaryParent ||
            !path.basename(root).startsWith("crafleet-project-")
        )
            throw new Error("Unexpected fixture cleanup target");
        await rm(root, { recursive: true, force: true });
    }
});

async function put(
    root: string,
    relative: string,
    content: string | Buffer,
): Promise<string> {
    const file = io.containedPath(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
}

async function contents(
    root: string,
    relative: string,
): Promise<string | null> {
    const file = io.containedPath(root, relative);
    return (await io.exists(file)) ? readFile(file, "utf8") : null;
}

async function metadata(root: string): Promise<Record<string, string | null>> {
    const files = [
        "crafleet.yaml",
        "crafleet-lock.yaml",
        ".crafleet/state.json",
        ".crafleet/config-state.json",
        ".crafleet/deploy.json",
        ".crafleet/manifest-transaction.json",
    ];
    return Object.fromEntries(
        await Promise.all(
            files.map(async (file) => [file, await contents(root, file)]),
        ),
    );
}

/** Real ZIP bytes and real filesystem deployment; the fixture provider never starts Java or downloads. */
function artifactStore(root: string) {
    const files = new Map<string, string>();
    const resolve = vi.fn(
        async (
            input: SourceInput,
            _context: ArtifactContext,
        ): Promise<LockedArtifact> => {
            const source = parseSource(input);
            const server = source.provider === "paper";
            if (source.provider === "paper" && source.build === "latest")
                source.build = "1";
            else if (
                source.provider !== "file" &&
                source.provider !== "paper" &&
                source.version === "latest"
            )
                source.version = "1.0.0";
            const version =
                source.provider === "file"
                    ? "local"
                    : source.provider === "paper"
                      ? source.build
                      : source.version;
            const id =
                source.provider === "modrinth" && source.project === "renamed"
                    ? "Renamed"
                    : "Example";
            const bytes = server
                ? artifactZip([
                      {
                          name: "META-INF/MANIFEST.MF",
                          content: `Manifest-Version: 1.0\nImplementation-Version: ${version}\n`,
                      },
                  ])
                : artifactJar(id, version);
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            files.set(
                sha256,
                await put(root, `artifacts/${sha256}.jar`, bytes),
            );
            return {
                source,
                version,
                sha256,
                size: bytes.length,
                ...(server
                    ? {}
                    : {
                          identity: {
                              id,
                              version,
                              format: "bukkit" as const,
                              dependencies: [],
                              optionalDependencies: [],
                          },
                      }),
            };
        },
    );
    const ensure = vi.fn(
        async (
            artifact: LockedArtifact,
            _context: ArtifactContext,
        ): Promise<string> => {
            const file = files.get(artifact.sha256);
            if (!file || !(await io.exists(file)))
                throw new CrafleetError(
                    "FIXTURE_CACHE_MISS",
                    "Fixture artifact is unavailable.",
                    3,
                );
            return file;
        },
    );
    const latest = vi.fn(
        async (input: SourceInput, _context: ArtifactContext) => {
            const source = parseSource(input);
            if (source.provider === "paper") source.build = "2";
            else if (source.provider !== "file") source.version = "2.0.0";
            return {
                source,
                version:
                    source.provider === "paper"
                        ? source.build
                        : source.provider === "file"
                          ? "local"
                          : source.version,
            };
        },
    );
    const store = {
        resolve,
        ensure,
        latest,
        inspect: vi.fn(async () => ({
            id: "Example",
            version: "1.0.0",
            format: "bukkit" as const,
            dependencies: [],
            optionalDependencies: [],
        })),
    } satisfies ArtifactStore;
    return { store, files };
}

type FixtureArtifactStore = ReturnType<typeof artifactStore>["store"];

function clearArtifactCalls(store: FixtureArtifactStore): void {
    store.latest.mockClear();
    store.resolve.mockClear();
    store.ensure.mockClear();
}

function expectNoArtifactCalls(store: FixtureArtifactStore): void {
    expect(store.latest).not.toHaveBeenCalled();
    expect(store.resolve).not.toHaveBeenCalled();
    expect(store.ensure).not.toHaveBeenCalled();
}

async function workspaceProjectPair() {
    const root = await directory();
    await initWorkspace(root, ["servers/*"]);
    for (const name of ["alpha", "beta"])
        await initProject(path.join(root, "servers", name), {
            name,
            kind: "paper",
            version: "26.1",
        });
    const selected = await selectProjects(root, path.join(root, "home"), {
        recursive: true,
    });
    const alpha = selected.find((project) => project.manifest.name === "alpha");
    const beta = selected.find((project) => project.manifest.name === "beta");
    if (!alpha || !beta) throw new Error("Expected both workspace projects.");
    return {
        root,
        projects: [alpha, beta],
        beta,
        ...artifactStore(root),
    };
}

async function project(
    options: { plugin?: boolean; installed?: boolean } = {},
) {
    const root = await directory();
    const dir = path.join(root, "project");
    const home = path.join(root, "home");
    const manifest = await initProject(dir, {
        name: "alpha",
        kind: "paper",
        version: "26.1",
    });
    if (options.plugin !== false) {
        manifest.plugins.Example = "modrinth:example@1.0.0";
        await writeYaml(path.join(dir, "crafleet.yaml"), manifest);
    }
    const context = await loadProject(dir, home);
    const provider = artifactStore(root);
    if (options.installed !== false)
        await installProjects([context], provider.store);
    const manager = new NodeDeploymentManager(context, provider.store);
    return { root, dir, home, context, manager, ...provider };
}

async function pending(dir: string): Promise<Installation> {
    const installation = (await readState(dir)).pending;
    if (!installation) throw new Error("Expected fixture pending installation");
    return installation;
}

async function treeBytes(root: string): Promise<Record<string, string>> {
    return Object.fromEntries(
        await Promise.all(
            (await io.listFiles(root)).map(async (file) => [
                file,
                (await readFile(path.join(root, file))).toString("base64"),
            ]),
        ),
    );
}

describe("bounded regular file reads", () => {
    it("returns content with bigint identity, mode, size and timestamps", async () => {
        const root = await directory();
        const file = await put(root, "bounded.txt", "bounded\n");
        const snapshot = await io.readBoundedRegularFile(file, {
            maxBytes: 1024,
            failure: (reason) => {
                throw new Error(`Unexpected bounded read failure: ${reason}`);
            },
        });
        if (!snapshot) throw new Error("Expected a bounded file snapshot.");

        expect(snapshot.bytes.toString("utf8")).toBe("bounded\n");
        for (const key of [
            "dev",
            "ino",
            "size",
            "mode",
            "atimeNs",
            "mtimeNs",
            "ctimeNs",
            "birthtimeNs",
        ] as const)
            expect(typeof snapshot.stats[key]).toBe("bigint");
    });
});

describe("atomic file creation", () => {
    it("allows exactly one concurrent creator without clobbering its content", async () => {
        const root = await directory();
        const file = path.join(root, "created.txt");
        const contents = ["first\n", "second\n"];

        const results = await Promise.allSettled(
            contents.map((content) => io.atomicCreate(file, content)),
        );

        expect(
            results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
            results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const winner = results.findIndex(
            (result) => result.status === "fulfilled",
        );
        const loser = results.find((result) => result.status === "rejected");
        expect(loser).toMatchObject({
            status: "rejected",
            reason: { code: "EEXIST" },
        });
        expect(await readFile(file, "utf8")).toBe(contents[winner]);
        expect(await readdir(root)).toEqual(["created.txt"]);
    });

    it("leaves a pre-existing target unchanged and removes its temporary file", async () => {
        const root = await directory();
        const file = await put(root, "created.txt", "original\n");

        await expect(
            io.atomicCreate(file, "replacement\n"),
        ).rejects.toMatchObject({ code: "EEXIST" });

        expect(await readFile(file, "utf8")).toBe("original\n");
        expect(await readdir(root)).toEqual(["created.txt"]);
    });

    it("removes its temporary file after rejecting an invalid write payload", async () => {
        const root = await directory();
        const file = path.join(root, "created.txt");

        await expect(
            io.atomicCreate(file, {} as Uint8Array),
        ).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });

        expect(await io.exists(file)).toBe(false);
        expect(await readdir(root)).toEqual([]);
    });

    it.runIf(process.platform !== "win32")(
        "applies the process umask to the requested target mode",
        async () => {
            const root = await directory();
            const file = path.join(root, "created.txt");
            const requestedMode = 0o764;
            const expectedMode = requestedMode & (~process.umask() & 0o777);

            await io.atomicCreate(file, "created\n", requestedMode);

            expect((await stat(file)).mode & 0o777).toBe(expectedMode);
        },
    );
});

describe("bounded Windows atomic replacement", () => {
    it.each(["EPERM", "EACCES", "EBUSY"])(
        "retries transient %s against the same paths without deleting original content",
        async (code) => {
            const root = await directory();
            const source = await put(root, "replacement.tmp", "new");
            const destination = await put(root, "target.json", "old");
            let attempts = 0;
            const replace = vi.fn(async (from: string, to: string) => {
                expect([from, to]).toEqual([source, destination]);
                expect(await readFile(destination, "utf8")).toBe("old");
                if (++attempts < 3)
                    throw Object.assign(
                        new Error("fixture reader holds a sharing lock"),
                        { code },
                    );
                await rename(from, to);
            });
            await io.renameWithSharingRetry(source, destination, {
                platform: "win32",
                rename: replace,
            });
            expect(replace).toHaveBeenCalledTimes(3);
            expect(await readFile(destination, "utf8")).toBe("new");
            expect(await io.exists(source)).toBe(false);
        },
    );

    it.each([
        ["win32", "EPERM", 6],
        ["linux", "EPERM", 1],
        ["win32", "ENOSPC", 1],
    ] as const)(
        "fails with both files retained on %s/%s after %i attempts",
        async (platform, code, attempts) => {
            const root = await directory();
            const source = await put(root, "replacement.tmp", "new");
            const destination = await put(root, "target.json", "old");
            const error = Object.assign(
                new Error("fixture persistent failure"),
                { code },
            );
            const replace = vi.fn(async () => {
                throw error;
            });
            await expect(
                io.renameWithSharingRetry(source, destination, {
                    platform,
                    rename: replace,
                }),
            ).rejects.toBe(error);
            expect(replace).toHaveBeenCalledTimes(attempts);
            expect(await readFile(source, "utf8")).toBe("new");
            expect(await readFile(destination, "utf8")).toBe("old");
        },
    );

    it("revalidates ancestor links before retrying a transient replacement failure", async () => {
        const root = await directory();
        const source = await put(root, "replacement.tmp", "new");
        const destination = await put(root, "target/file", "old");
        const external = path.join(root, "external");
        await put(external, "file", "protected");
        const replace = vi.fn(async () => {
            await rename(
                path.join(root, "target"),
                path.join(root, "original-target"),
            );
            await symlink(
                external,
                path.join(root, "target"),
                process.platform === "win32" ? "junction" : "dir",
            );
            throw Object.assign(new Error("transient"), { code: "EPERM" });
        });
        await expect(
            io.renameWithSharingRetry(source, destination, {
                platform: "win32",
                rename: replace,
            }),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
        expect(replace).toHaveBeenCalledTimes(1);
        expect(await readFile(path.join(external, "file"), "utf8")).toBe(
            "protected",
        );
        expect(
            await readFile(path.join(root, "original-target/file"), "utf8"),
        ).toBe("old");
    });
});

async function importFixture(id = "server") {
    const root = await directory();
    const source = path.join(root, "existing");
    const target = path.join(root, "imported");
    const home = path.join(root, "home");
    const server = artifactZip([
        { name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\n" },
    ]);
    const plugin = artifactJar(id, "1.0.0");
    await put(source, "paper-download.jar", server);
    await put(source, "plugins/download-name.jar", plugin);
    await put(source, "server.properties", "motd=existing\n");
    await put(source, "world/level.dat", "world-original");
    const store = new NodeArtifactStore(home);
    const options = {
        name: "imported",
        kind: "paper" as const,
        version: "26.1",
        serverJar: "paper-download.jar",
    };
    return { root, source, target, home, server, plugin, store, options };
}

describe("safe import of an existing server", () => {
    it("previews descriptor identities without creating the destination or cache", async () => {
        const fixture = await importFixture();
        const before = await treeBytes(fixture.source);
        const resolve = vi.spyOn(fixture.store, "resolve");
        const ensure = vi.spyOn(fixture.store, "ensure");
        await expect(
            importProject(
                fixture.source,
                fixture.target,
                fixture.home,
                { ...fixture.options, dryRun: true },
                fixture.store,
            ),
        ).resolves.toMatchObject({
            plugins: ["server"],
            originalUnchanged: true,
        });
        expect(resolve).not.toHaveBeenCalled();
        expect(ensure).not.toHaveBeenCalled();
        expect(await io.exists(fixture.target)).toBe(false);
        expect(await io.exists(fixture.home)).toBe(false);
        expect(await treeBytes(fixture.source)).toEqual(before);
    });

    it("keeps a plugin named server separate from the server JAR and copies the source unchanged", async () => {
        const fixture = await importFixture();
        const before = await treeBytes(fixture.source);
        await importProject(
            fixture.source,
            fixture.target,
            fixture.home,
            fixture.options,
            fixture.store,
        );
        expect(
            await readFile(
                path.join(fixture.target, "imports/server/server.jar"),
            ),
        ).toEqual(fixture.server);
        expect(
            await readFile(
                path.join(fixture.target, "imports/plugins/server.jar"),
            ),
        ).toEqual(fixture.plugin);
        expect(
            await readFile(path.join(fixture.target, "runtime/server.jar")),
        ).toEqual(fixture.server);
        expect(
            await readFile(
                path.join(fixture.target, "runtime/plugins/server.jar"),
            ),
        ).toEqual(fixture.plugin);
        const context = await loadProject(fixture.target, fixture.home);
        expect(context.manifest.server.source).toBe(
            "file:imports/server/server.jar",
        );
        expect(context.manifest.plugins).toEqual({
            server: "file:imports/plugins/server.jar",
        });
        expect(await contents(fixture.target, "runtime/world/level.dat")).toBe(
            "world-original",
        );
        expect(await io.listFiles(path.join(fixture.target, "config"))).toEqual(
            [],
        );
        expect(
            await io.exists(
                path.join(fixture.target, ".crafleet/import-incomplete.json"),
            ),
        ).toBe(false);
        expect(await readState(fixture.target)).toMatchObject({
            pending: {
                lock: { plugins: { server: { identity: { id: "server" } } } },
            },
        });
        expect((await readState(fixture.target)).active).toBeUndefined();
        expect(await treeBytes(fixture.source)).toEqual(before);
    });

    it.each([
        "absolute",
        "escape",
        "not-jar",
        "managed",
        "nonempty",
        "inside",
        "ancestor",
        "update",
        "target-collision",
        "directory-collision",
        "symlink",
    ])("rejects %s before creating imported files", async (kind) => {
        const fixture = await importFixture();
        let target = fixture.target;
        let serverJar = fixture.options.serverJar;
        if (kind === "absolute")
            serverJar = path.join(fixture.source, serverJar);
        if (kind === "escape") serverJar = "../outside.jar";
        if (kind === "not-jar") serverJar = "server.properties";
        if (kind === "managed")
            await mkdir(path.join(fixture.source, ".crafleet"));
        if (kind === "nonempty") await put(target, "owned.txt", "owned");
        if (kind === "inside") target = path.join(fixture.source, "child");
        if (kind === "ancestor") target = fixture.root;
        if (kind === "update")
            await put(
                fixture.source,
                "plugins/update/next.jar",
                fixture.plugin,
            );
        if (kind === "target-collision")
            await put(fixture.source, "server.jar", "another-server");
        if (kind === "directory-collision")
            await put(fixture.source, "plugins/server.jar/data.txt", "owned");
        if (kind === "symlink") {
            await mkdir(path.join(fixture.root, "external"));
            await symlink(
                path.join(fixture.root, "external"),
                path.join(fixture.source, "linked"),
                process.platform === "win32" ? "junction" : "dir",
            );
        }
        await expect(
            importProject(
                fixture.source,
                target,
                fixture.home,
                { ...fixture.options, serverJar },
                fixture.store,
            ),
        ).rejects.toBeInstanceOf(CrafleetError);
        if (kind === "nonempty")
            expect(await contents(target, "owned.txt")).toBe("owned");
        else if (kind !== "ancestor")
            expect(await io.exists(target)).toBe(false);
        expect(await io.exists(fixture.home)).toBe(false);
    });

    it("rejects a non-JAR import selection before inspecting an occupied destination", async () => {
        const fixture = await importFixture();
        await put(fixture.target, "owned.txt", "owned");

        await expect(
            importProject(
                fixture.source,
                fixture.target,
                fixture.home,
                { ...fixture.options, serverJar: "server.properties" },
                fixture.store,
            ),
        ).rejects.toMatchObject({ code: "IMPORT_SERVER" });
        expect(await contents(fixture.target, "owned.txt")).toBe("owned");
        expect(await io.exists(fixture.home)).toBe(false);
    });

    it.each(["constructor", "CON", "unsafe:name"])(
        "refuses a descriptor identity unsafe for portable management: %s",
        async (id) => {
            const fixture = await importFixture(id);
            await expect(
                importProject(
                    fixture.source,
                    fixture.target,
                    fixture.home,
                    fixture.options,
                    fixture.store,
                ),
            ).rejects.toBeInstanceOf(CrafleetError);
            expect(await io.exists(fixture.target)).toBe(false);
        },
    );

    it("keeps an incomplete marker after resolution fails and never changes the source", async () => {
        const fixture = await importFixture();
        const before = await treeBytes(fixture.source);
        vi.spyOn(fixture.store, "resolve").mockRejectedValue(
            new Error("fixture disk unavailable"),
        );
        await expect(
            importProject(
                fixture.source,
                fixture.target,
                fixture.home,
                fixture.options,
                fixture.store,
            ),
        ).rejects.toMatchObject({ code: "IMPORT_INCOMPLETE" });
        expect(
            await io.exists(
                path.join(fixture.target, ".crafleet/import-incomplete.json"),
            ),
        ).toBe(true);
        await expect(
            validateManagedProject(
                await loadProject(fixture.target, fixture.home),
            ),
        ).rejects.toMatchObject({ code: "IMPORT_INCOMPLETE" });
        expect(await treeBytes(fixture.source)).toEqual(before);
    });

    it.each(["bytes", "files"])(
        "detects concurrent changes to source %s and retains a blocked destination",
        async (change) => {
            const fixture = await importFixture();
            const original = backupFiles.hashBackupFile;
            let changed = false;
            vi.spyOn(backupFiles, "hashBackupFile").mockImplementation(
                async (file) => {
                    const result = await original(file);
                    if (
                        !changed &&
                        file ===
                            path.join(fixture.target, "runtime/world/level.dat")
                    ) {
                        changed = true;
                        await put(
                            fixture.source,
                            change === "bytes"
                                ? "world/level.dat"
                                : "world/new.dat",
                            "concurrent writer",
                        );
                    }
                    return result;
                },
            );
            await expect(
                importProject(
                    fixture.source,
                    fixture.target,
                    fixture.home,
                    fixture.options,
                    fixture.store,
                ),
            ).rejects.toMatchObject({ code: "IMPORT_CHANGED" });
            expect(changed).toBe(true);
            expect(
                await io.exists(
                    path.join(
                        fixture.target,
                        ".crafleet/import-incomplete.json",
                    ),
                ),
            ).toBe(true);
            expect(
                await io.exists(
                    path.join(fixture.target, "crafleet-lock.yaml"),
                ),
            ).toBe(false);
        },
    );
});

async function cached(
    home: string,
    bytes: string | Buffer,
    old = true,
    hash?: string,
): Promise<string> {
    const sha256 = hash ?? createHash("sha256").update(bytes).digest("hex");
    const file = await put(
        home,
        `cache/artifacts/sha256/${sha256}/artifact.jar`,
        bytes,
    );
    if (old) await utimes(file, new Date(0), new Date(0));
    return sha256;
}

describe("registered cache pruning safety", () => {
    it("lists and optionally verifies cache entries without mutating unknown files", async () => {
        const root = await directory();
        const home = path.join(root, "home");
        expect((await inspectArtifactCache(home, true)).entries).toEqual([]);
        const valid = await cached(home, "known bytes");
        const invalid = await cached(home, "corrupted", true, "e".repeat(64));
        await put(
            home,
            "cache/artifacts/sha256/not-an-object/owned.txt",
            "owned",
        );
        await mkdir(path.join(home, "cache/artifacts/sha256", "d".repeat(64)));
        await mkdir(
            path.join(
                home,
                "cache/artifacts/sha256",
                "c".repeat(64),
                "artifact.jar",
            ),
            { recursive: true },
        );
        const before = await treeBytes(home);
        const checked = await inspectArtifactCache(home, true);
        expect(
            checked.entries.find((entry) => entry.sha256 === valid)?.valid,
        ).toBe(true);
        expect(
            checked.entries.find((entry) => entry.sha256 === invalid)?.valid,
        ).toBe(false);
        expect(checked.ignored).toEqual(
            expect.arrayContaining([
                "not-an-object",
                "d".repeat(64),
                "c".repeat(64),
            ]),
        );
        expect(
            (await inspectArtifactCache(home, false)).entries.every(
                (entry) => entry.valid === undefined,
            ),
        ).toBe(true);
        expect(await treeBytes(home)).toEqual(before);
    });

    it("registers a canonical project once and protects registry ownership", async () => {
        const fixture = await project({ installed: false });
        await registerCacheProject(fixture.home, fixture.dir);
        await registerCacheProject(fixture.home, path.join(fixture.dir, "."));
        expect(
            await io.readJson(path.join(fixture.home, "cache/projects.json")),
        ).toEqual({ schemaVersion: 1, projects: [fixture.dir] });
        await io.withMutex(
            path.join(fixture.home, "cache/registry.lock"),
            async () => {
                await expect(
                    registerCacheProject(fixture.home, fixture.dir),
                ).rejects.toMatchObject({ code: "BUSY" });
            },
        );
    });

    it.each(["malformed", "relative", "extra", "version", "large"])(
        "disables pruning for %s registry metadata without revealing its contents",
        async (kind) => {
            const root = await directory();
            const text =
                kind === "malformed"
                    ? "private-fixture{bad"
                    : kind === "large"
                      ? " ".repeat(2 * 1024 * 1024 + 1)
                      : JSON.stringify({
                            schemaVersion: kind === "version" ? 2 : 1,
                            projects:
                                kind === "relative"
                                    ? ["../private-fixture"]
                                    : [],
                            ...(kind === "extra"
                                ? { secret: "private-fixture" }
                                : {}),
                        });
            await put(root, "cache/projects.json", text);
            const hash = await cached(root, "retain");
            await expect(pruneArtifactCache(root, false)).rejects.toMatchObject(
                { code: "CACHE_REGISTRY" },
            );
            await expect(pruneArtifactCache(root, true)).rejects.not.toThrow(
                "private-fixture",
            );
            expect(
                await contents(
                    root,
                    `cache/artifacts/sha256/${hash}/artifact.jar`,
                ),
            ).toBe("retain");
            expect(await contents(root, "cache/projects.json")).toBe(text);
        },
    );

    it("retains active, pending and shared lock artifacts while pruning only old unreferenced bytes", async () => {
        const fixture = await project();
        await fixture.manager.applyPrepared();
        fixture.context.manifest.plugins.Example = "modrinth:example@2.0.0";
        await writeYaml(
            path.join(fixture.dir, "crafleet.yaml"),
            fixture.context.manifest,
        );
        await installProjects(
            [await loadProject(fixture.dir, fixture.home)],
            fixture.store,
        );
        for (const [hash, file] of fixture.files)
            await cached(fixture.home, await readFile(file), true, hash);
        const orphan = await cached(fixture.home, "old orphan");
        const recent = await cached(fixture.home, "newly inspected", false);
        const before = await treeBytes(fixture.home);
        const planned = await pruneArtifactCache(fixture.home, false);
        expect(planned.candidates.map((entry) => entry.sha256)).toEqual([
            orphan,
        ]);
        expect(await treeBytes(fixture.home)).toEqual(before);
        const result = await pruneArtifactCache(fixture.home, true);
        expect(result.candidates.map((entry) => entry.sha256)).toEqual([
            orphan,
        ]);
        for (const hash of [...fixture.files.keys(), recent])
            expect(
                await io.exists(
                    path.join(
                        fixture.home,
                        `cache/artifacts/sha256/${hash}/artifact.jar`,
                    ),
                ),
            ).toBe(true);
        expect(
            await io.exists(
                path.join(fixture.home, `cache/artifacts/sha256/${orphan}`),
            ),
        ).toBe(false);
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/operation.lock")),
        ).toBe(false);
    });

    it.each([
        ".crafleet/operation.lock",
        ".crafleet/deploy.json",
        ".crafleet/restore.json",
        ".crafleet/import-incomplete.json",
        ".crafleet/manifest-transaction.json",
        ".crafleet/group-operation.json",
        ".crafleet/group-restore.json",
    ])("retains every cache object while %s is unresolved", async (marker) => {
        const fixture = await project({ installed: false });
        await registerCacheProject(fixture.home, fixture.dir);
        const hash = await cached(fixture.home, "old orphan");
        if (marker.endsWith(".lock"))
            await mkdir(path.join(fixture.dir, marker), { recursive: true });
        else await put(fixture.dir, marker, "{}");
        await expect(
            pruneArtifactCache(fixture.home, false),
        ).rejects.toMatchObject({ code: "CACHE_BUSY" });
        await expect(
            pruneArtifactCache(fixture.home, true),
        ).rejects.toMatchObject({ code: "CACHE_BUSY" });
        expect(
            await contents(
                fixture.home,
                `cache/artifacts/sha256/${hash}/artifact.jar`,
            ),
        ).toBe("old orphan");
    });

    it("retains all objects when a registered project is missing or unreadable", async () => {
        const fixture = await project({ installed: false });
        await registerCacheProject(
            fixture.home,
            path.join(fixture.root, "missing-project"),
        );
        await cached(fixture.home, "old orphan");
        const before = await treeBytes(fixture.home);
        const result = await pruneArtifactCache(fixture.home, true);
        expect(result.candidates).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(await treeBytes(fixture.home)).toEqual(before);
    });

    it("validates all candidate directories before the first deletion and never deletes unknown children", async () => {
        const root = await directory();
        const hashes = [
            await cached(root, "first"),
            await cached(root, "second"),
        ].sort();
        await put(
            root,
            `cache/artifacts/sha256/${hashes[1]}/owned.txt`,
            "owned",
        );
        const before = await treeBytes(root);
        await expect(pruneArtifactCache(root, true)).rejects.toMatchObject({
            code: "CACHE_UNEXPECTED",
        });
        expect(await treeBytes(root)).toEqual(before);
    });
});

describe("read-only project validation", () => {
    it.each(["manifest", "lock", "requests", "config"])(
        "does not accept array mappings from persisted installation %s",
        async (kind) => {
            const fixture = await project();
            const installation = await pending(fixture.dir);
            if (kind === "manifest")
                Reflect.set(installation.manifest, "plugins", []);
            if (kind === "lock") Reflect.set(installation.lock, "plugins", []);
            if (kind === "requests")
                Reflect.set(installation.lock.requests, "plugins", []);
            if (kind === "config")
                Reflect.set(installation.config.state, "files", []);
            await io.writeJson(path.join(fixture.dir, ".crafleet/state.json"), {
                schemaVersion: 1,
                pending: installation,
            });
            const before = await treeBytes(fixture.dir);
            await expect(readState(fixture.dir)).rejects.toMatchObject({
                code:
                    kind === "config"
                        ? "CONFIG_BUNDLE_INVALID"
                        : "STATE_INVALID",
            });
            expect(await treeBytes(fixture.dir)).toEqual(before);
        },
    );
    it("validates fresh, pending and active projects without writing state", async () => {
        const fixture = await project({ installed: false });
        const before = await metadata(fixture.dir);
        expect(await validateManagedProject(fixture.context)).toMatchObject({
            valid: true,
            locked: false,
            active: null,
            pending: null,
        });
        expect(await metadata(fixture.dir)).toEqual(before);
        await installProjects([fixture.context], fixture.store);
        expect(await validateManagedProject(fixture.context)).toMatchObject({
            valid: true,
            locked: true,
            pending: (await pending(fixture.dir)).id,
        });
        await fixture.manager.applyPrepared();
        expect(await validateManagedProject(fixture.context)).toMatchObject({
            valid: true,
            active: (await readState(fixture.dir)).active?.id,
            pending: null,
        });
    });

    it("refuses descriptor mismatches in lock data before reporting validity", async () => {
        const fixture = await project();
        const lock = await readLock(fixture.dir);
        const artifact = lock.projects["."]?.plugins.Example;
        if (!artifact?.identity) throw new Error("Missing fixture identity");
        artifact.identity.id = "Renamed";
        await writeYaml(path.join(fixture.dir, "crafleet-lock.yaml"), lock);
        await expect(
            validateManagedProject(fixture.context),
        ).rejects.toMatchObject({ code: "LOCK_IDENTITY" });
    });

    it("refuses unresolved configuration conflicts without changing either side", async () => {
        const fixture = await project({ installed: false });
        await put(fixture.dir, "config/server.properties", "motd=first\n");
        await installProjects([fixture.context], fixture.store);
        await fixture.manager.applyPrepared();
        await put(fixture.dir, "config/server.properties", "motd=base-edit\n");
        await put(
            fixture.dir,
            "runtime/server.properties",
            "motd=runtime-edit\n",
        );
        const before = await treeBytes(fixture.dir);
        await expect(
            validateManagedProject(fixture.context),
        ).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });
        expect(await treeBytes(fixture.dir)).toEqual(before);
    });
});

async function staleOwnerFixture() {
    const fixture = await project({ installed: false });
    const record: RunnerRecord = {
        protocol: 1,
        projectDir: fixture.dir,
        token: randomUUID(),
        pid: 43210,
        javaPid: 43211,
        port: 0,
        activeId: randomUUID(),
        phase: "running",
        clean: false,
        startedAt: "fixture-time",
    };
    await io.writeJson(path.join(fixture.dir, ".crafleet/runner.json"), record);
    await io.writeJson(
        path.join(fixture.dir, ".crafleet/process.lock/owner.json"),
        { pid: record.pid, token: record.token },
    );
    await io.writeJson(
        path.join(fixture.dir, ".crafleet/operation.lock/owner.json"),
        { pid: 43212, token: randomUUID(), started: "fixture-time" },
    );
    vi.spyOn(NodeServerController.prototype, "status").mockResolvedValue({
        status: "unknown",
    });
    const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((_pid, signal) => {
            if (signal !== 0)
                throw new Error(
                    "Test forbids sending process termination signals",
                );
            throw Object.assign(new Error("No fixture process"), {
                code: "ESRCH",
            });
        });
    return { ...fixture, record, kill };
}

describe("explicit stale process ownership recovery", () => {
    it("only accepts ESRCH as proof of exit and never sends a termination signal", () => {
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        expect(processDefinitelyExited(43210)).toBe(false);
        kill.mockImplementation(() => {
            throw Object.assign(new Error("denied"), { code: "EPERM" });
        });
        expect(processDefinitelyExited(43210)).toBe(false);
        kill.mockImplementation(() => {
            throw Object.assign(new Error("absent"), { code: "ESRCH" });
        });
        expect(processDefinitelyExited(43210)).toBe(true);
        expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    });

    it("previews without writes, then clears matching exited owners and marks an unclean stop", async () => {
        const fixture = await staleOwnerFixture();
        const before = await treeBytes(fixture.dir);
        await recoverProcessLocks(fixture.context, true);
        expect(await treeBytes(fixture.dir)).toEqual(before);
        await recoverProcessLocks(fixture.context);
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/process.lock")),
        ).toBe(false);
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/operation.lock")),
        ).toBe(false);
        expect(
            await io.readJson(path.join(fixture.dir, ".crafleet/runner.json")),
        ).toEqual({ ...fixture.record, phase: "stopped", clean: false });
        expect(fixture.kill.mock.calls.every((call) => call[1] === 0)).toBe(
            true,
        );
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/recovery.lock")),
        ).toBe(false);
    });

    it.each(["running", "starting", "stopping"] as const)(
        "does not touch ownership while an authenticated runner is %s",
        async (status) => {
            const fixture = await staleOwnerFixture();
            vi.mocked(NodeServerController.prototype.status).mockResolvedValue({
                status,
            });
            const before = await treeBytes(fixture.dir);
            await expect(
                recoverProcessLocks(fixture.context),
            ).rejects.toMatchObject({ code: "RECOVERY_RUNNING" });
            expect(await treeBytes(fixture.dir)).toEqual(before);
            expect(fixture.kill).not.toHaveBeenCalled();
        },
    );

    it.each([
        "json",
        "oversized",
        "missing-record",
        "mismatched-token",
        "mismatched-pid",
        "missing-java",
        "alive-java",
        "no-guard",
    ])("retains every owner for ambiguous runner state: %s", async (kind) => {
        const fixture = await staleOwnerFixture();
        if (kind === "json")
            await put(fixture.dir, ".crafleet/runner.json", "private-invalid{");
        if (kind === "oversized")
            await put(fixture.dir, ".crafleet/runner.json", " ".repeat(65537));
        if (kind === "missing-record")
            await rm(path.join(fixture.dir, ".crafleet/runner.json"));
        if (kind === "mismatched-token") fixture.record.token = randomUUID();
        if (kind === "mismatched-pid") fixture.record.pid = 43213;
        if (kind === "missing-java") delete fixture.record.javaPid;
        if (
            ["mismatched-token", "mismatched-pid", "missing-java"].includes(
                kind,
            )
        )
            await io.writeJson(
                path.join(fixture.dir, ".crafleet/runner.json"),
                fixture.record,
            );
        if (kind === "alive-java")
            fixture.kill.mockImplementation((pid) => {
                if (pid === fixture.record.javaPid) return true;
                throw Object.assign(new Error("absent"), { code: "ESRCH" });
            });
        if (kind === "no-guard")
            await rm(path.join(fixture.dir, ".crafleet/process.lock"), {
                recursive: true,
            });
        const before = await treeBytes(fixture.dir);
        await expect(
            recoverProcessLocks(fixture.context),
        ).rejects.toMatchObject({ code: "UNKNOWN_PROCESS" });
        expect(await treeBytes(fixture.dir)).toEqual(before);
    });

    it.each([
        "missing",
        "json",
        "extra-field",
        "extra-file",
        "file-not-directory",
        "oversized",
        "pid-zero",
        "alive",
    ])(
        "validates the later operation owner before removing a valid process guard: %s",
        async (kind) => {
            const fixture = await staleOwnerFixture();
            const owner = ".crafleet/operation.lock/owner.json";
            if (kind === "missing") await rm(path.join(fixture.dir, owner));
            if (kind === "json")
                await put(fixture.dir, owner, "private-invalid{");
            if (kind === "extra-field")
                await io.writeJson(path.join(fixture.dir, owner), {
                    pid: 43212,
                    private: "no-output",
                });
            if (kind === "extra-file")
                await put(
                    fixture.dir,
                    ".crafleet/operation.lock/owned.txt",
                    "retain",
                );
            if (kind === "file-not-directory") {
                await rm(path.join(fixture.dir, ".crafleet/operation.lock"), {
                    recursive: true,
                });
                await put(fixture.dir, ".crafleet/operation.lock", "retain");
            }
            if (kind === "oversized")
                await put(fixture.dir, owner, " ".repeat(65537));
            if (kind === "pid-zero")
                await io.writeJson(path.join(fixture.dir, owner), { pid: 0 });
            if (kind === "alive")
                fixture.kill.mockImplementation((pid) => {
                    if (pid === 43212) return true;
                    throw Object.assign(new Error("absent"), { code: "ESRCH" });
                });
            const before = await treeBytes(fixture.dir);
            await expect(
                recoverProcessLocks(fixture.context),
            ).rejects.toMatchObject({ code: "LOCK_OWNER" });
            expect(await treeBytes(fixture.dir)).toEqual(before);
        },
    );

    it("does not confuse a reused old Java PID in a stopped record with an unrelated operation owner", async () => {
        const fixture = await staleOwnerFixture();
        await rm(path.join(fixture.dir, ".crafleet/process.lock"), {
            recursive: true,
        });
        fixture.record.phase = "stopped";
        await io.writeJson(
            path.join(fixture.dir, ".crafleet/runner.json"),
            fixture.record,
        );
        fixture.kill.mockImplementation((pid) => {
            if (pid === fixture.record.javaPid) return true;
            throw Object.assign(new Error("absent"), { code: "ESRCH" });
        });
        await recoverProcessLocks(fixture.context);
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/operation.lock")),
        ).toBe(false);
        expect(
            fixture.kill.mock.calls.some(
                (call) => call[0] === fixture.record.javaPid,
            ),
        ).toBe(false);
    });

    it("rechecks all owner bytes after preparation and refuses a concurrent edit", async () => {
        const fixture = await staleOwnerFixture();
        const original = io.assertNoSymlinks;
        let calls = 0;
        vi.spyOn(io, "assertNoSymlinks").mockImplementation(
            async (root, relative) => {
                const result = await original(root, relative);
                if (
                    root === path.join(fixture.dir, ".crafleet/process.lock") &&
                    relative === "owner.json" &&
                    ++calls === 2
                )
                    await writeFile(
                        result,
                        JSON.stringify({ pid: 99999, token: randomUUID() }),
                    );
                return result;
            },
        );
        await expect(
            recoverProcessLocks(fixture.context),
        ).rejects.toMatchObject({ code: "LOCK_CHANGED" });
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/process.lock")),
        ).toBe(true);
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/operation.lock")),
        ).toBe(true);
    });
});

describe("project initialization and workspaces", () => {
    it("keeps workspace keys that resemble JavaScript prototype properties as ordinary lock entries", async () => {
        const root = await directory();
        const home = path.join(root, "home");
        await initWorkspace(root, ["*"]);
        const contexts = [];
        for (const [index, name] of ["constructor", "__proto__"].entries()) {
            const dir = path.join(root, name);
            await initProject(dir, {
                name: `server${index}`,
                kind: "paper",
                version: "26.1",
            });
            contexts.push(await loadProject(dir, home));
        }
        const provider = artifactStore(root);
        await installProjects(contexts, provider.store, { dryRun: true });
        await installProjects(contexts, provider.store);
        const lock = await readLock(root);
        expect(Object.getPrototypeOf(lock.projects)).toBeNull();
        expect(Object.keys(lock.projects).sort()).toEqual([
            "__proto__",
            "constructor",
        ]);
        expect(lock.projects.constructor?.name).toBe("server0");
        expect(Reflect.get(lock.projects, "__proto__")?.name).toBe("server1");
        await installProjects(contexts, provider.store, { frozen: true });
        expect((await readLock(root)).projects).toEqual(lock.projects);
    });
    it("initializes data directories and one validated custom manifest", async () => {
        const root = await directory();
        const created = await initProject(root, {
            name: "alpha",
            kind: "paper",
            version: "26.1",
            build: "42",
            source: "file:imports/server.jar",
        });
        expect(await loadProject(root, path.join(root, "home"))).toMatchObject({
            manifest: created,
            lockKey: ".",
            lockRoot: root,
        });
        for (const child of ["config", "runtime", "shared-data"])
            expect((await stat(path.join(root, child))).isDirectory()).toBe(
                true,
            );
        expect(created.server).toEqual({
            type: "paper",
            version: "26.1",
            build: "42",
            source: "file:imports/server.jar",
        });
        await expect(
            initProject(root, {
                name: "other",
                kind: "velocity",
                version: "3.4",
            }),
        ).rejects.toMatchObject({ code: "PROJECT_EXISTS" });
        expect((await loadProject(root, "unused")).manifest).toEqual(created);
    });

    it("allows exactly one concurrent initialization without replacing its manifest", async () => {
        const root = await directory();
        const target = path.join(root, "survival");
        const results = await Promise.allSettled(
            ["alpha", "beta"].map((name) =>
                initProject(target, {
                    name,
                    kind: "paper",
                    version: "26.1",
                }),
            ),
        );

        expect(
            results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
            results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const successful = results.find(
            (result) => result.status === "fulfilled",
        );
        const failed = results.find((result) => result.status === "rejected");
        if (successful?.status !== "fulfilled")
            throw new Error("Expected one successful initialization.");
        expect(failed).toMatchObject({
            status: "rejected",
            reason: { code: "PROJECT_EXISTS" },
        });

        const loaded = await loadProject(target, path.join(root, "home"));
        expect(loaded.manifest).toEqual(successful.value);
    });

    it("creates gitignore rules for a project nested in a Git worktree", async () => {
        const root = await directory();
        const target = path.join(root, "servers", "survival");
        await mkdir(path.join(root, ".git"));

        await initProject(target, {
            name: "survival",
            kind: "paper",
            version: "26.1",
        });

        expect(await io.exists(path.join(target, ".git"))).toBe(false);
        expect(await contents(target, ".gitignore")).toBe(
            "runtime/\nshared-data/\n.crafleet/\nimports/\n.env\n.env.*\n",
        );
    });

    it("treats an ancestor linked-worktree git file as a managed marker", async () => {
        const root = await directory();
        const target = path.join(root, "servers", "survival");
        await put(root, ".git", "gitdir: ../metadata/worktrees/survival\n");

        await initProject(target, {
            name: "survival",
            kind: "paper",
            version: "26.1",
        });

        expect(await contents(target, ".gitignore")).toBe(
            "runtime/\nshared-data/\n.crafleet/\nimports/\n.env\n.env.*\n",
        );
    });

    it("does not create gitignore outside a Git worktree", async () => {
        const root = await directory();
        const target = path.join(root, "survival");

        await initProject(target, {
            name: "survival",
            kind: "paper",
            version: "26.1",
        });

        expect(await io.exists(path.join(target, ".gitignore"))).toBe(false);
    });

    it("preserves existing gitignore content and appends each missing rule once", async () => {
        const root = await directory();
        const target = path.join(root, "servers", "survival");
        await mkdir(path.join(root, ".git"));
        const file = await put(
            target,
            ".gitignore",
            "# custom\n*.local\nruntime/",
        );
        const before = await lstat(file, { bigint: true });

        await initProject(target, {
            name: "survival",
            kind: "paper",
            version: "26.1",
        });

        const ignore = await contents(target, ".gitignore");
        expect(ignore).toBe(
            "# custom\n*.local\nruntime/\nshared-data/\n.crafleet/\nimports/\n.env\n.env.*\n",
        );
        expect(ignore?.match(/^runtime\/$/gm)).toHaveLength(1);
        const after = await lstat(file, { bigint: true });
        expect({
            dev: after.dev,
            ino: after.ino,
            birthtimeNs: after.birthtimeNs,
        }).toEqual({
            dev: before.dev,
            ino: before.ino,
            birthtimeNs: before.birthtimeNs,
        });
    });

    it("preserves CRLF while appending each missing gitignore rule once", async () => {
        const root = await directory();
        const target = path.join(root, "servers", "survival");
        await put(root, ".git", "gitdir: ../metadata/worktrees/survival\n");
        await put(target, ".gitignore", "# custom\r\n*.local\r\nruntime/\r\n");

        await initProject(target, {
            name: "survival",
            kind: "paper",
            version: "26.1",
        });

        const ignore = await contents(target, ".gitignore");
        expect(ignore).toBe(
            "# custom\r\n*.local\r\nruntime/\r\nshared-data/\r\n.crafleet/\r\nimports/\r\n.env\r\n.env.*\r\n",
        );
        expect(ignore?.match(/^runtime\/$/gm)).toHaveLength(1);
    });

    it("preserves a BOM-prefixed first rule without duplicating it", async () => {
        const root = await directory();
        const target = path.join(root, "servers", "survival");
        await mkdir(path.join(root, ".git"));
        await put(target, ".gitignore", "\uFEFFruntime/\n# custom\n");

        await initProject(target, {
            name: "survival",
            kind: "paper",
            version: "26.1",
        });

        const ignore = await contents(target, ".gitignore");
        expect(ignore).toBe(
            "\uFEFFruntime/\n# custom\nshared-data/\n.crafleet/\nimports/\n.env\n.env.*\n",
        );
        expect(ignore?.match(/runtime\//g)).toHaveLength(1);
    });

    it.each([
        {
            label: "invalid UTF-8",
            code: "GITIGNORE_UNREADABLE",
            prepare: async (_root: string, target: string) => {
                await put(target, ".gitignore", Buffer.from([0xc3, 0x28]));
            },
        },
        {
            label: "content over 1 MiB",
            code: "GITIGNORE_SIZE",
            prepare: async (_root: string, target: string) => {
                await put(
                    target,
                    ".gitignore",
                    Buffer.alloc(1024 * 1024 + 1, 0x61),
                );
            },
        },
        {
            label: "a hard link",
            code: "GITIGNORE_UNSAFE",
            prepare: async (root: string, target: string) => {
                const external = await put(
                    root,
                    "external-ignore",
                    "runtime/\n",
                );
                await mkdir(target, { recursive: true });
                await link(external, path.join(target, ".gitignore"));
            },
        },
    ])(
        "rejects gitignore with $label before creating the manifest",
        async ({ code, prepare }) => {
            const root = await directory();
            const target = path.join(root, "servers", "survival");
            await mkdir(path.join(root, ".git"));
            await prepare(root, target);

            await expect(
                initProject(target, {
                    name: "survival",
                    kind: "paper",
                    version: "26.1",
                }),
            ).rejects.toMatchObject({ code });
            expect(await io.exists(path.join(target, "crafleet.yaml"))).toBe(
                false,
            );
        },
    );

    it.runIf(process.platform !== "win32")(
        "preserves the mode of an existing gitignore",
        async () => {
            const root = await directory();
            const target = path.join(root, "servers", "survival");
            await mkdir(path.join(root, ".git"));
            const ignore = await put(target, ".gitignore", "# custom\n");
            const originalUmask = process.umask(0o077);
            try {
                await chmod(ignore, 0o664);
                await initProject(target, {
                    name: "survival",
                    kind: "paper",
                    version: "26.1",
                });
                expect((await stat(ignore)).mode & 0o777).toBe(0o664);
            } finally {
                process.umask(originalUmask);
            }
        },
    );

    it.each([false, true])(
        "rejects a linked gitignore before project creation (dryRun: %s)",
        async (dryRun) => {
            const root = await directory();
            const target = path.join(root, "servers", "survival");
            const external = path.join(root, "external-ignore");
            await put(root, ".git", "gitdir: ../metadata/worktrees/survival\n");
            await mkdir(target, { recursive: true });
            if (process.platform === "win32") {
                await mkdir(external);
                await symlink(
                    external,
                    path.join(target, ".gitignore"),
                    "junction",
                );
            } else {
                await writeFile(external, "# external\n");
                await symlink(
                    external,
                    path.join(target, ".gitignore"),
                    "file",
                );
            }

            await expect(
                initProject(target, {
                    name: "survival",
                    kind: "paper",
                    version: "26.1",
                    dryRun,
                }),
            ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
            expect(await io.exists(path.join(target, "crafleet.yaml"))).toBe(
                false,
            );
        },
    );

    it("does not create project or gitignore files during a Git-managed dry run", async () => {
        const root = await directory();
        const target = path.join(root, "servers", "survival");
        await mkdir(path.join(root, ".git"));

        await initProject(target, {
            name: "survival",
            kind: "paper",
            version: "26.1",
            dryRun: true,
        });

        expect(await io.exists(target)).toBe(false);
        expect(await io.exists(path.join(target, ".gitignore"))).toBe(false);
    });

    it("validates source and manifest before creating any files, including dry runs", async () => {
        const root = await directory();
        const target = path.join(root, "new");
        await expect(
            initProject(target, {
                name: "alpha",
                kind: "paper",
                version: "26.1",
                source: "https://not-a-source",
            }),
        ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
        expect(await io.exists(target)).toBe(false);
        await expect(
            initProject(target, {
                name: "bad name",
                kind: "paper",
                version: "26.1",
            }),
        ).rejects.toMatchObject({ code: "PROJECT_NAME" });
        const occupied = path.join(root, "occupied");
        await put(occupied, "crafleet.yaml", "owned\n");
        for (const dryRun of [false, true])
            await expect(
                initProject(occupied, {
                    name: "alpha",
                    kind: "paper",
                    version: "26.1",
                    source: "file:server.zip",
                    dryRun,
                }),
            ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
        expect(await contents(occupied, "crafleet.yaml")).toBe("owned\n");
        const preview = await initProject(target, {
            name: "alpha",
            kind: "velocity",
            version: "3.4",
            dryRun: true,
        });
        expect(preview.server.type).toBe("velocity");
        expect(await io.exists(target)).toBe(false);
    });

    it.each([
        {
            kind: "paper",
            version: "1.21.11",
            source: "velocity:3.4.0@20",
        },
        {
            kind: "velocity",
            version: "3.4.0",
            source: "paper:1.21.11@200",
        },
    ] as const)(
        "rejects a $kind project backed by the other Paper project before files or EULA consent",
        async ({ kind, version, source }) => {
            const root = await directory();
            const target = path.join(root, kind);
            const home = path.join(root, "home");
            const requestConsent = vi.fn(async () => undefined);

            await expect(
                initProject(target, {
                    name: kind,
                    kind,
                    version,
                    source,
                    eula: { home, requestConsent },
                }),
            ).rejects.toMatchObject({ code: "SERVER_PLATFORM" });

            expect(requestConsent).not.toHaveBeenCalled();
            expect(await io.exists(target)).toBe(false);
            expect(await io.exists(path.join(home, "eula.json"))).toBe(false);
        },
    );

    it("allows exactly one concurrent workspace initialization without replacing its YAML", async () => {
        const root = await directory();
        const projectSets = [["servers/*"], ["proxies/*", "!proxies/retired"]];
        const results = await Promise.allSettled(
            projectSets.map((projects) => initWorkspace(root, projects)),
        );

        expect(
            results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
            results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const winner = results.findIndex(
            (result) => result.status === "fulfilled",
        );
        const winningProjects = projectSets[winner];
        if (!winningProjects)
            throw new Error(
                "Expected one successful workspace initialization.",
            );
        expect(
            results.find((result) => result.status === "rejected"),
        ).toMatchObject({
            status: "rejected",
            reason: { code: "WORKSPACE_EXISTS" },
        });
        expect(
            await readYaml(path.join(root, "crafleet-workspace.yaml")),
        ).toEqual({
            schemaVersion: 1,
            projects: winningProjects,
        });
    });

    it.each([false, true])(
        "rejects a linked workspace directory without writing through it (dryRun: %s)",
        async (dryRun) => {
            const root = await directory();
            const external = path.join(root, "external");
            const workspace = path.join(root, "workspace");
            await mkdir(external);
            await symlink(
                external,
                workspace,
                process.platform === "win32" ? "junction" : "dir",
            );

            await expect(
                initWorkspace(workspace, ["servers/*"], dryRun),
            ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
            expect(
                await io.exists(path.join(external, "crafleet-workspace.yaml")),
            ).toBe(false);
        },
    );

    it.each([false, true])(
        "rejects an oversized generated workspace manifest without writing it (dryRun: %s)",
        async (dryRun) => {
            const root = await directory();
            const suffix = "a".repeat(1024);
            const projects = Array.from(
                { length: 2_048 },
                (_, index) => `servers/${index}-${suffix}`,
            );

            await expect(
                initWorkspace(root, projects, dryRun),
            ).rejects.toMatchObject({ code: "YAML_SIZE" });
            expect(await readdir(root)).toEqual([]);
        },
    );

    it.each([
        ["servers/*", "!servers/retired"],
        ["!servers/retired", "servers/*"],
    ])(
        "excludes workspace members independently of pattern order: %j",
        async (...patterns) => {
            const root = await directory();
            await initWorkspace(root, patterns);
            for (const name of ["alpha", "beta", "retired"])
                await initProject(path.join(root, "servers", name), {
                    name,
                    kind: "paper",
                    version: "26.1",
                });
            expect(await workspaceProjects(root)).toEqual([
                path.join(root, "servers/alpha"),
                path.join(root, "servers/beta"),
            ]);
            const selected = await selectProjects(root, "unused", {
                filters: ["servers/b*"],
            });
            expect(selected.map((item) => item.manifest.name)).toEqual([
                "beta",
            ]);
            expect(selected[0]?.lockRoot).toBe(root);
            expect(selected[0]?.lockKey).toBe("servers/beta");
        },
    );

    it("requires a positive inclusion and does not imply recursion from a workspace root", async () => {
        const root = await directory();
        const server = path.join(root, "servers/alpha");
        await initWorkspace(root, ["!servers/retired"]);
        await initProject(server, {
            name: "alpha",
            kind: "paper",
            version: "26.1",
        });
        expect(await workspaceProjects(root)).toEqual([]);
        await expect(selectProjects(root, "unused")).rejects.toMatchObject({
            code: "NO_PROJECT",
        });
        expect(
            (await selectProjects(path.join(server, "runtime"), "unused"))[0]
                ?.dir,
        ).toBe(server);
    });

    it("rejects duplicate member names and empty selections", async () => {
        const root = await directory();
        await initWorkspace(root, ["servers/*"]);
        for (const name of ["first", "second"])
            await initProject(path.join(root, "servers", name), {
                name: "duplicate",
                kind: "paper",
                version: "26.1",
            });
        await expect(
            selectProjects(root, "unused", { filters: ["servers/first"] }),
        ).rejects.toMatchObject({ code: "DUPLICATE_PROJECT" });
        await expect(
            selectProjects(root, "unused", { filters: ["missing"] }),
        ).rejects.toMatchObject({ code: "EMPTY_SELECTION" });
    });

    it.each(["../*", "!../*", "/outside/*", "C:\\outside\\*", "!", ""])(
        "rejects unsafe workspace pattern %s without mutation",
        async (pattern) => {
            const root = await directory();
            await expect(initWorkspace(root, [pattern])).rejects.toMatchObject({
                code: "WORKSPACE_PATH",
            });
            expect(await readdir(root)).toEqual([]);
        },
    );

    it("preserves YAML bytes on no-op and comments on a targeted edit", async () => {
        const root = await directory();
        const file = await put(
            root,
            "sample.yaml",
            "# operator notes\nname: 'alpha' # project name\nserver:\n  build: '1' # exact build\n",
        );
        const value = (await readYaml(file)) as {
            name: string;
            server: { build: string };
        };
        const before = await readFile(file, "utf8");
        expect(await yamlText(file, value)).toBe(before);
        await writeYaml(file, value);
        expect(await readFile(file, "utf8")).toBe(before);
        value.server.build = "2";
        await writeYaml(file, value);
        expect(await readFile(file, "utf8")).toContain("# operator notes");
        expect(await readFile(file, "utf8")).toContain("# exact build");
        expect(await readYaml(file)).toEqual(value);
    });

    it("rejects invalid or oversized metadata without exposing its value", async () => {
        const root = await directory();
        const file = await put(
            root,
            "crafleet.yaml",
            "secret: private-value\nsecret: another-value\n",
        );
        await expect(readYaml(file)).rejects.toMatchObject({
            code: "YAML_SYNTAX",
        });
        await expect(readYaml(file)).rejects.not.toThrow("private-value");
        await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
        await expect(readYaml(file)).rejects.toMatchObject({
            code: "YAML_SIZE",
        });
        await put(root, "crafleet-lock.yaml", "lockVersion: 2\nprojects: {}\n");
        await expect(readLock(root)).rejects.toMatchObject({
            code: "INVALID_INPUT",
        });
    });

    it("refuses initialization and metadata access through directory links", async () => {
        const root = await directory();
        const outside = path.join(root, "outside");
        await mkdir(outside);
        const target = path.join(root, "project");
        await mkdir(target);
        await symlink(
            outside,
            path.join(target, "runtime"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(
            initProject(target, {
                name: "alpha",
                kind: "paper",
                version: "26.1",
            }),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
        expect(await io.exists(path.join(target, "crafleet.yaml"))).toBe(false);
        expect(await io.exists(path.join(target, "config"))).toBe(false);
        const file = await put(
            outside,
            "crafleet-lock.yaml",
            "lockVersion: 1\nprojects: {}\n",
        );
        await expect(
            readLock(path.join(target, "runtime")),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
        expect(await readFile(file, "utf8")).toBe(
            "lockVersion: 1\nprojects: {}\n",
        );
    });
});

describe("installation and shared manifest transactions", () => {
    it("rejects generated transactions beyond the same recovery byte and change-count limits", () => {
        expect(() =>
            assertManifestJournalLimits(32 * 1024 * 1024, 4096),
        ).not.toThrow();
        expect(() =>
            assertManifestJournalLimits(32 * 1024 * 1024 + 1, 1),
        ).toThrow(expect.objectContaining({ code: "MANIFEST_TOO_LARGE" }));
        expect(() => assertManifestJournalLimits(1, 4097)).toThrow(
            expect.objectContaining({ code: "MANIFEST_TOO_LARGE" }),
        );
    });

    it("rejects a 2,048-project manifest transaction for apply and dry-run", () => {
        const manifest = newProject("template", "paper", "26.1");
        const projects = Array.from(
            { length: 2_048 },
            (_, index): ProjectContext => ({
                dir: `project-${index}`,
                manifest: { ...manifest, name: `server-${index}` },
                lockRoot: "workspace",
                lockKey: `server-${index}`,
                home: "home",
            }),
        );

        for (const dryRun of [false, true])
            expect(() =>
                validateInstallRequest(projects, { dryRun }),
            ).toThrowError(
                expect.objectContaining({ code: "MANIFEST_TOO_LARGE" }),
            );
    });

    it("rejects a schema-valid state whose minimum recovery journal exceeds the byte limit", async () => {
        const fixture = await project({ installed: false });
        for (let index = 0; index < 8; index++)
            await put(fixture.dir, `config/large-${index}.txt`, "initial\n");
        await installProjects([fixture.context], fixture.store);
        const state = await readState(fixture.dir);
        const files = state.pending?.config.files;
        if (files?.length !== 8)
            throw new Error("Expected eight pending configuration files.");
        for (const file of files) file.content = "";
        const empty = `${JSON.stringify(state)}\n`;
        const targetBytes = 32 * 1024 * 1024 - 1;
        let remaining = targetBytes - Buffer.byteLength(empty);
        for (const file of files) {
            const bytes = Math.min(4 * 1024 * 1024, remaining);
            file.content = "x".repeat(bytes);
            remaining -= bytes;
        }
        expect(remaining).toBe(0);
        const stateText = `${JSON.stringify(state)}\n`;
        expect(Buffer.byteLength(stateText)).toBe(targetBytes);
        await writeFile(
            path.join(fixture.dir, ".crafleet/state.json"),
            stateText,
        );
        clearArtifactCalls(fixture.store);

        for (const dryRun of [false, true]) {
            await expect(
                installProjects([fixture.context], fixture.store, { dryRun }),
            ).rejects.toMatchObject({ code: "MANIFEST_TOO_LARGE" });
            expectNoArtifactCalls(fixture.store);
        }
    });

    it("rejects oversized generated shared-lock YAML without changing any input", async () => {
        const fixture = await workspaceProjectPair();
        await installProjects(fixture.projects, fixture.store);
        const inputFiles = [
            path.join(fixture.root, "crafleet-lock.yaml"),
            ...fixture.projects.flatMap((project) => [
                path.join(project.dir, "crafleet.yaml"),
                path.join(project.dir, ".crafleet/state.json"),
            ]),
        ];
        const readInputs = () =>
            Promise.all(inputFiles.map((file) => readFile(file, "utf8")));
        const before = await readInputs();
        const resolve = fixture.store.resolve.getMockImplementation();
        if (!resolve) throw new Error("Expected the fixture resolver.");
        fixture.store.resolve.mockImplementation(async (input, context) => ({
            ...(await resolve(input, context)),
            url: `https://example.test/${"x".repeat(MAX_YAML_BYTES)}`,
        }));

        await expect(
            installProjects(fixture.projects, fixture.store, {
                updateServer: true,
            }),
        ).rejects.toMatchObject({ code: "YAML_SIZE" });

        expect(await readInputs()).toEqual(before);
        expect(
            await io.exists(
                path.join(fixture.root, ".crafleet/manifest-transaction.json"),
            ),
        ).toBe(false);
    });

    it("rejects a stale loaded declaration before any artifact lookup", async () => {
        const fixture = await project();
        const file = path.join(fixture.dir, "crafleet.yaml");
        await writeFile(
            file,
            `${await readFile(file, "utf8")}# manual edit before install\n`,
        );
        const edited = await metadata(fixture.dir);
        for (const mock of [
            fixture.store.resolve,
            fixture.store.ensure,
            fixture.store.latest,
        ])
            mock.mockClear();
        await expect(
            installProjects([fixture.context], fixture.store, {
                updateServer: true,
            }),
        ).rejects.toMatchObject({ code: "CONCURRENT_EDIT" });
        for (const mock of [
            fixture.store.resolve,
            fixture.store.ensure,
            fixture.store.latest,
        ])
            expect(mock).not.toHaveBeenCalled();
        expect(await metadata(fixture.dir)).toEqual(edited);
    });

    it.each(["manifest", "lock", "state"] as const)(
        "preserves a manual %s edit made during provider resolution and creates no transaction",
        async (field) => {
            const fixture = await project();
            const latest = fixture.store.latest.getMockImplementation();
            if (!latest) throw new Error("Missing fixture provider");
            let edited: Record<string, string | null> | undefined;
            fixture.store.latest.mockImplementationOnce(
                async (input, context) => {
                    if (field === "manifest") {
                        const file = path.join(fixture.dir, "crafleet.yaml");
                        await writeFile(
                            file,
                            `${await readFile(file, "utf8")}# concurrent operator note\n`,
                        );
                    } else if (field === "lock") {
                        const lock = await readLock(fixture.context.lockRoot);
                        const entry = lock.projects[fixture.context.lockKey];
                        if (!entry)
                            throw new Error("Missing fixture lock slice");
                        lock.projects.unselected = {
                            ...structuredClone(entry),
                            name: "unselected",
                        };
                        await writeYaml(
                            path.join(
                                fixture.context.lockRoot,
                                "crafleet-lock.yaml",
                            ),
                            lock,
                        );
                    } else {
                        const file = path.join(
                            fixture.dir,
                            ".crafleet/state.json",
                        );
                        await writeFile(
                            file,
                            `${await readFile(file, "utf8")}\n`,
                        );
                    }
                    edited = await metadata(fixture.dir);
                    return latest(input, context);
                },
            );
            await expect(
                installProjects([fixture.context], fixture.store, {
                    updateServer: true,
                }),
            ).rejects.toMatchObject({ code: "CONCURRENT_EDIT" });
            expect(fixture.store.latest).toHaveBeenCalledOnce();
            expect(edited).toBeDefined();
            expect(await metadata(fixture.dir)).toEqual(edited);
            expect(
                await io.exists(
                    path.join(
                        fixture.dir,
                        ".crafleet/manifest-transaction.json",
                    ),
                ),
            ).toBe(false);
            if (field === "lock")
                expect(
                    (await readLock(fixture.context.lockRoot)).projects
                        .unselected?.name,
                ).toBe("unselected");
        },
    );

    it("protects declarations before the first add-plugin identity lookup", async () => {
        const fixture = await project({ plugin: false });
        const resolve = fixture.store.resolve.getMockImplementation();
        if (!resolve) throw new Error("Missing fixture provider");
        fixture.store.resolve.mockClear();
        let edited: Record<string, string | null> | undefined;
        fixture.store.resolve.mockImplementationOnce(
            async (source, context) => {
                const file = path.join(fixture.dir, "crafleet.yaml");
                await writeFile(
                    file,
                    `${await readFile(file, "utf8")}# concurrent edit during identity discovery\n`,
                );
                edited = await metadata(fixture.dir);
                return resolve(source, context);
            },
        );
        await expect(
            addPlugins([fixture.context], fixture.store, [
                "modrinth:renamed@1.0.0",
            ]),
        ).rejects.toMatchObject({ code: "CONCURRENT_EDIT" });
        expect(fixture.store.resolve).toHaveBeenCalledOnce();
        expect(edited).toBeDefined();
        expect(await metadata(fixture.dir)).toEqual(edited);
        expect(
            await io.exists(
                path.join(fixture.dir, ".crafleet/manifest-transaction.json"),
            ),
        ).toBe(false);
    });

    it("uses locked resolutions offline without silently changing exact requests", async () => {
        const fixture = await project();
        const before = await metadata(fixture.dir);
        fixture.store.resolve.mockClear();
        fixture.store.ensure.mockClear();
        fixture.store.latest.mockClear();
        await installProjects([fixture.context], fixture.store, {
            frozen: true,
            offline: true,
        });
        expect(fixture.store.resolve).not.toHaveBeenCalled();
        expect(fixture.store.latest).not.toHaveBeenCalled();
        expect(fixture.store.ensure).toHaveBeenCalledTimes(2);
        expect(
            fixture.store.ensure.mock.calls.every(
                ([, context]) => context.offline,
            ),
        ).toBe(true);
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("refreshes pending runtime snapshots even if desired content and deployment ID are unchanged", async () => {
        const fixture = await project({ installed: false });
        const source = '{"max":10}\n';
        await put(fixture.dir, "config/settings.json", source);
        await installProjects([fixture.context], fixture.store);
        const before = await pending(fixture.dir);
        await put(fixture.dir, "runtime/settings.json", source);
        await expect(
            new NodeConfigManager(fixture.dir).assertUnchanged(before.config),
        ).rejects.toMatchObject({ code: "CONFIG_CHANGED" });
        await installProjects([fixture.context], fixture.store);
        const after = await pending(fixture.dir);
        expect(after.id).toBe(before.id);
        expect(after.createdAt).toBe(before.createdAt);
        expect(after.config.files[0]?.runtime).toBe(source);
        await expect(
            new NodeConfigManager(fixture.dir).assertUnchanged(after.config),
        ).resolves.toBeUndefined();
    });

    it("prepares dry-run results without committing manifests, lock or pending", async () => {
        const fixture = await project({ installed: false });
        const before = await metadata(fixture.dir);
        const results = await installProjects(
            [fixture.context],
            fixture.store,
            { dryRun: true },
        );
        expect(results[0]).toMatchObject({
            changed: true,
            project: "alpha",
            plugins: ["Example"],
        });
        expect(results[0]?.unresolved).toEqual(["server", "Example"]);
        expect(results[0]?.warnings).toHaveLength(1);
        expect(fixture.store.resolve).not.toHaveBeenCalled();
        expect(fixture.store.ensure).not.toHaveBeenCalled();
        expect(fixture.store.latest).not.toHaveBeenCalled();
        expect(await io.exists(path.join(fixture.root, "artifacts"))).toBe(
            false,
        );
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("validates a frozen dry-run and reports updates as unresolved without any provider calls", async () => {
        const fixture = await project();
        for (const mock of [
            fixture.store.resolve,
            fixture.store.ensure,
            fixture.store.latest,
        ])
            mock.mockClear();
        const before = await metadata(fixture.dir);
        const locked = await installProjects([fixture.context], fixture.store, {
            frozen: true,
            dryRun: true,
        });
        expect(locked[0]?.unresolved).toEqual([]);
        const update = await installProjects([fixture.context], fixture.store, {
            updateAllPlugins: true,
            dryRun: true,
        });
        expect(update[0]?.unresolved).toEqual(["Example"]);
        fixture.context.manifest.plugins.Example = "modrinth:example@9.0.0";
        await expect(
            installProjects([fixture.context], fixture.store, {
                frozen: true,
                dryRun: true,
            }),
        ).rejects.toMatchObject({ code: "FROZEN_LOCK" });
        for (const mock of [
            fixture.store.resolve,
            fixture.store.ensure,
            fixture.store.latest,
        ])
            expect(mock).not.toHaveBeenCalled();
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it.each(["server", "plugin", "removed-plugin"] as const)(
        "refuses frozen %s declaration changes without metadata writes",
        async (change) => {
            const fixture = await project();
            if (change === "server")
                fixture.context.manifest.server.build = "9";
            if (change === "plugin")
                fixture.context.manifest.plugins.Example =
                    "modrinth:example@3.0.0";
            if (change === "removed-plugin")
                delete fixture.context.manifest.plugins.Example;
            const before = await metadata(fixture.dir);
            await expect(
                installProjects([fixture.context], fixture.store, {
                    frozen: true,
                }),
            ).rejects.toMatchObject({ code: "FROZEN_LOCK" });
            expect(await metadata(fixture.dir)).toEqual(before);
        },
    );

    it.each([
        { update: "server", options: { frozen: true, updateServer: true } },
        {
            update: "all plugins",
            options: { frozen: true, updateAllPlugins: true },
        },
        {
            update: "named plugins",
            options: { frozen: true, updatePlugins: ["Example"] },
        },
    ])(
        "rejects frozen with $update updates before artifact I/O",
        async ({ options }) => {
            const fixture = await project();
            clearArtifactCalls(fixture.store);

            expect(() =>
                validateInstallRequest([fixture.context], options),
            ).toThrowError(expect.objectContaining({ code: "FROZEN_LOCK" }));
            await expect(
                installProjects([fixture.context], fixture.store, options),
            ).rejects.toMatchObject({ code: "FROZEN_LOCK" });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each(["stale request", "project name"] as const)(
        "rejects a frozen lock with a mismatched $violation before artifact I/O",
        async (violation) => {
            const fixture = await project();
            const lock = await readLock(fixture.context.lockRoot);
            const entry = lock.projects[fixture.context.lockKey];
            if (!entry) throw new Error("Expected the fixture lock entry.");
            if (violation === "stale request")
                entry.requests.plugins.Stale = stableStringify(
                    parseSource("modrinth:stale@1.0.0"),
                );
            else entry.name = "renamed";
            await writeYaml(
                path.join(fixture.context.lockRoot, "crafleet-lock.yaml"),
                lock,
            );
            clearArtifactCalls(fixture.store);

            await expect(
                installProjects([fixture.context], fixture.store, {
                    frozen: true,
                }),
            ).rejects.toMatchObject({ code: "FROZEN_LOCK" });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([
        {
            violation: "wrong platform",
            code: "PLUGIN_PLATFORM",
            mutate: (plugins: Record<string, LockedArtifact>) => {
                const identity = plugins.Example?.identity;
                if (!identity) throw new Error("Expected Example identity.");
                identity.format = "velocity";
            },
        },
        {
            violation: "duplicate id/provides namespace",
            code: "DUPLICATE_PLUGIN",
            mutate: (plugins: Record<string, LockedArtifact>) => {
                const identity = plugins.Example?.identity;
                if (!identity) throw new Error("Expected Example identity.");
                identity.provides = ["RENAMED"];
            },
        },
    ])(
        "rejects reusable lock identities with a $violation before resolving an update",
        async ({ code, mutate }) => {
            const fixture = await project({ installed: false });
            fixture.context.manifest.plugins.Renamed = "modrinth:renamed@1.0.0";
            await installProjects([fixture.context], fixture.store);
            const lock = await readLock(fixture.context.lockRoot);
            const entry = lock.projects[fixture.context.lockKey];
            const example = entry?.plugins.Example;
            if (!entry || !example?.identity)
                throw new Error("Expected reusable fixture locks.");
            const source = "modrinth:future@1.0.0";
            const future = structuredClone(example);
            future.source = parseSource(source);
            future.identity = { ...example.identity, id: "Future" };
            entry.plugins.Future = future;
            entry.requests.plugins.Future = stableStringify(
                parseSource(source),
            );
            mutate(entry.plugins);
            await writeYaml(
                path.join(fixture.context.lockRoot, "crafleet-lock.yaml"),
                lock,
            );
            fixture.context.manifest.plugins.Future = source;
            clearArtifactCalls(fixture.store);

            await expect(
                installProjects([fixture.context], fixture.store, {
                    updatePlugins: ["Future"],
                }),
            ).rejects.toMatchObject({ code });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it("rejects an unresolved declaration that claims a reusable plugin alias before artifact I/O", async () => {
        const fixture = await project();
        const lock = await readLock(fixture.context.lockRoot);
        const entry = lock.projects[fixture.context.lockKey];
        const identity = entry?.plugins.Example?.identity;
        if (!entry || !identity) throw new Error("Expected Example lock data.");
        identity.provides = ["B"];
        await writeYaml(
            path.join(fixture.context.lockRoot, "crafleet-lock.yaml"),
            lock,
        );
        fixture.context.manifest.plugins.B = "modrinth:b@1.0.0";
        clearArtifactCalls(fixture.store);

        await expect(
            installProjects([fixture.context], fixture.store),
        ).rejects.toMatchObject({ code: "DUPLICATE_PLUGIN" });
        expectNoArtifactCalls(fixture.store);
    });

    it("validates each resolved plugin before caching it or resolving the next plugin", async () => {
        const fixture = await project({ plugin: false, installed: false });
        fixture.context.manifest.plugins.Example = "modrinth:example@1.0.0";
        fixture.context.manifest.plugins.Renamed = "modrinth:renamed@1.0.0";
        const resolve = fixture.store.resolve.getMockImplementation();
        if (!resolve) throw new Error("Expected the fixture resolver.");
        fixture.store.resolve.mockImplementation(async (input, context) => {
            const artifact = await resolve(input, context);
            const source = parseSource(input);
            if (
                source.provider === "modrinth" &&
                source.project === "example" &&
                artifact.identity
            )
                artifact.identity.format = "velocity";
            return artifact;
        });

        await expect(
            installProjects([fixture.context], fixture.store),
        ).rejects.toMatchObject({ code: "PLUGIN_PLATFORM" });
        expect(fixture.store.ensure).toHaveBeenCalledTimes(1);
        expect(
            fixture.store.resolve.mock.calls.some(([input]) => {
                const source = parseSource(input);
                return (
                    source.provider === "modrinth" &&
                    source.project === "renamed"
                );
            }),
        ).toBe(false);
    });

    it("checks a resolved plugin against reusable aliases before caching it", async () => {
        const fixture = await project({ installed: false });
        fixture.context.manifest.plugins.Renamed = "modrinth:renamed@1.0.0";
        await installProjects([fixture.context], fixture.store);
        const lock = await readLock(fixture.context.lockRoot);
        const renamed = lock.projects[fixture.context.lockKey]?.plugins.Renamed;
        if (!renamed?.identity)
            throw new Error("Expected the reusable plugin identity.");
        renamed.identity.provides = ["shared-alias"];
        await writeYaml(
            path.join(fixture.context.lockRoot, "crafleet-lock.yaml"),
            lock,
        );
        const resolve = fixture.store.resolve.getMockImplementation();
        if (!resolve) throw new Error("Expected the fixture resolver.");
        fixture.store.resolve.mockImplementation(async (input, context) => {
            const artifact = await resolve(input, context);
            const source = parseSource(input);
            if (
                source.provider === "modrinth" &&
                source.project === "example" &&
                artifact.identity
            )
                artifact.identity.provides = ["SHARED-ALIAS"];
            return artifact;
        });
        clearArtifactCalls(fixture.store);

        await expect(
            installProjects([fixture.context], fixture.store, {
                updatePlugins: ["Example"],
            }),
        ).rejects.toMatchObject({ code: "DUPLICATE_PLUGIN" });
        expect(fixture.store.latest).toHaveBeenCalledTimes(1);
        expect(fixture.store.resolve).toHaveBeenCalledTimes(1);
        expect(fixture.store.ensure).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            violation: "wrong platform",
            code: "PLUGIN_PLATFORM",
            mutate: (artifact: LockedArtifact) => {
                if (!artifact.identity)
                    throw new Error("Expected a plugin identity.");
                artifact.identity.format = "velocity";
            },
        },
        {
            violation: "case-insensitive identifier collision",
            code: "DUPLICATE_PLUGIN",
            mutate: (artifact: LockedArtifact) => {
                if (!artifact.identity)
                    throw new Error("Expected a plugin identity.");
                artifact.identity.id = "example";
            },
        },
        {
            violation: "provided alias collision",
            code: "DUPLICATE_PLUGIN",
            mutate: (artifact: LockedArtifact) => {
                if (!artifact.identity)
                    throw new Error("Expected a plugin identity.");
                artifact.identity.provides = ["EXAMPLE"];
            },
        },
    ])(
        "validates an added plugin with a $violation before resolving another source",
        async ({ code, mutate }) => {
            const fixture = await project();
            const resolve = fixture.store.resolve.getMockImplementation();
            if (!resolve) throw new Error("Expected the fixture resolver.");
            fixture.store.resolve.mockImplementation(async (input, context) => {
                const artifact = await resolve(input, context);
                mutate(artifact);
                return artifact;
            });
            clearArtifactCalls(fixture.store);

            await expect(
                addPlugins([fixture.context], fixture.store, [
                    "modrinth:renamed@1.0.0",
                    "modrinth:future@1.0.0",
                ]),
            ).rejects.toMatchObject({ code });
            expect(fixture.store.resolve).toHaveBeenCalledTimes(1);
            expect(fixture.store.latest).not.toHaveBeenCalled();
            expect(fixture.store.ensure).not.toHaveBeenCalled();
        },
    );

    it.each(["declaration", "add"] as const)(
        "rejects a Paper server source in a plugin $operation before artifact I/O",
        async (operation) => {
            const fixture = await project({
                plugin: false,
                installed: false,
            });
            const source = "paper:1.21.4@200";
            if (operation === "declaration")
                fixture.context.manifest.plugins.Example = source;
            clearArtifactCalls(fixture.store);

            const result =
                operation === "declaration"
                    ? installProjects([fixture.context], fixture.store)
                    : addPlugins([fixture.context], fixture.store, [source]);
            await expect(result).rejects.toMatchObject({ code: "NOT_PLUGIN" });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([
        {
            kind: "paper",
            version: "1.21.4",
            source: "velocity:3.4.0@20",
        },
        {
            kind: "velocity",
            version: "3.4.0",
            source: "paper:1.21.4@200",
        },
    ] as const)(
        "rejects $kind server declarations backed by the other Paper project before artifact I/O",
        async ({ kind, source, version }) => {
            const root = await directory();
            const dir = path.join(root, "project");
            await initProject(dir, { name: "alpha", kind, version });
            const context = await loadProject(dir, path.join(root, "home"));
            context.manifest.server.source = source;
            const { store } = artifactStore(root);
            clearArtifactCalls(store);

            await expect(
                installProjects([context], store),
            ).rejects.toMatchObject({ code: "SERVER_PLATFORM" });
            expectNoArtifactCalls(store);
        },
    );

    it("updates only the selected plugin and keeps server game version unchanged", async () => {
        const fixture = await project();
        const before = await pending(fixture.dir);
        await installProjects([fixture.context], fixture.store, {
            updatePlugins: ["Example"],
            to: "2.7.1",
        });
        const after = await pending(fixture.dir);
        expect(after.lock.plugins.Example?.version).toBe("2.7.1");
        expect(after.manifest.plugins.Example).toBe("modrinth:example@2.7.1");
        expect(after.lock.server).toEqual(before.lock.server);
        expect(after.manifest.server.version).toBe("26.1");
        expect(fixture.store.latest).not.toHaveBeenCalled();
    });

    it("resolves an exact server build without querying latest", async () => {
        const fixture = await project();
        fixture.store.latest.mockClear();
        await installProjects([fixture.context], fixture.store, {
            updateServer: true,
            to: "7",
        });
        const after = await pending(fixture.dir);
        expect(after.manifest.server).toMatchObject({
            type: "paper",
            version: "26.1",
            build: "7",
        });
        expect(after.lock.server.source).toMatchObject({
            provider: "paper",
            build: "7",
        });
        expect(fixture.store.latest).not.toHaveBeenCalled();
    });

    it.each([
        { dryRun: false, target: "plugin" },
        { dryRun: true, target: "plugin" },
        { dryRun: false, target: "server" },
        { dryRun: true, target: "server" },
    ] as const)(
        "rejects --to for a local $target JAR during dryRun=$dryRun without writing metadata",
        async ({ dryRun, target }) => {
            const fixture = await project();
            fixture.store.resolve.mockClear();
            fixture.store.ensure.mockClear();
            fixture.store.latest.mockClear();
            if (target === "plugin")
                fixture.context.manifest.plugins.Example =
                    "file:../build/Example.jar";
            else
                fixture.context.manifest.server.source =
                    "file:../build/server.jar";
            const before = await metadata(fixture.dir);
            await expect(
                installProjects([fixture.context], fixture.store, {
                    ...(target === "plugin"
                        ? { updatePlugins: ["Example"] }
                        : { updateServer: true }),
                    to: "2",
                    dryRun,
                }),
            ).rejects.toMatchObject({ code: "UPDATE_VERSION" });
            expect(await metadata(fixture.dir)).toEqual(before);
            expect(fixture.store.resolve).not.toHaveBeenCalled();
            expect(fixture.store.ensure).not.toHaveBeenCalled();
            expect(fixture.store.latest).not.toHaveBeenCalled();
        },
    );

    it.each(["plugin", "server"] as const)(
        "rejects an empty exact $target version without writing metadata",
        async (target) => {
            const fixture = await project();
            fixture.store.resolve.mockClear();
            fixture.store.ensure.mockClear();
            fixture.store.latest.mockClear();
            const before = await metadata(fixture.dir);
            await expect(
                installProjects([fixture.context], fixture.store, {
                    ...(target === "plugin"
                        ? { updatePlugins: ["Example"] }
                        : { updateServer: true }),
                    to: "   ",
                }),
            ).rejects.toMatchObject({ code: "UPDATE_VERSION" });
            expect(await metadata(fixture.dir)).toEqual(before);
            expect(fixture.store.resolve).not.toHaveBeenCalled();
            expect(fixture.store.ensure).not.toHaveBeenCalled();
            expect(fixture.store.latest).not.toHaveBeenCalled();
        },
    );

    it.each([
        { dryRun: false, target: "plugin" },
        { dryRun: true, target: "plugin" },
        { dryRun: false, target: "server" },
        { dryRun: true, target: "server" },
    ] as const)(
        "validates exact $target versions during dryRun=$dryRun before writing metadata",
        async ({ dryRun, target }) => {
            const fixture = await project();
            fixture.store.resolve.mockClear();
            fixture.store.ensure.mockClear();
            fixture.store.latest.mockClear();
            const before = await metadata(fixture.dir);
            await expect(
                installProjects([fixture.context], fixture.store, {
                    ...(target === "plugin"
                        ? { updatePlugins: ["Example"] }
                        : { updateServer: true }),
                    to: "2\ninvalid",
                    dryRun,
                }),
            ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
            expect(await metadata(fixture.dir)).toEqual(before);
            expect(fixture.store.resolve).not.toHaveBeenCalled();
            expect(fixture.store.ensure).not.toHaveBeenCalled();
            expect(fixture.store.latest).not.toHaveBeenCalled();
        },
    );

    it("updates the server build while preserving plugin locks and declared game version", async () => {
        const fixture = await project();
        const before = await pending(fixture.dir);
        await installProjects([fixture.context], fixture.store, {
            updateServer: true,
        });
        const after = await pending(fixture.dir);
        expect(after.manifest.server).toEqual({
            type: "paper",
            version: "26.1",
            build: "2",
        });
        expect(after.lock.plugins).toEqual(before.lock.plugins);
        expect(after.lock.server.sha256).not.toBe(before.lock.server.sha256);
    });

    it("rejects unknown selectors and identity changes before committing metadata", async () => {
        const fixture = await project();
        fixture.store.resolve.mockClear();
        fixture.store.ensure.mockClear();
        fixture.store.latest.mockClear();
        const before = await metadata(fixture.dir);
        await expect(
            installProjects([fixture.context], fixture.store, {
                updatePlugins: ["Missing"],
            }),
        ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN" });
        expect(fixture.store.resolve).not.toHaveBeenCalled();
        expect(fixture.store.ensure).not.toHaveBeenCalled();
        expect(fixture.store.latest).not.toHaveBeenCalled();
        fixture.context.manifest.plugins.Example = "modrinth:renamed@2.0.0";
        await expect(
            installProjects([fixture.context], fixture.store),
        ).rejects.toMatchObject({ code: "PLUGIN_IDENTITY" });
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it.each(["install", "add"] as const)(
        "rejects case-insensitive unresolved declaration keys before $operation artifact I/O",
        async (operation) => {
            const fixture = await project({
                plugin: false,
                installed: false,
            });
            fixture.context.manifest.plugins.Foo = "modrinth:foo@1.0.0";
            fixture.context.manifest.plugins.foo = "modrinth:foo@1.0.0";
            clearArtifactCalls(fixture.store);

            const result =
                operation === "install"
                    ? installProjects([fixture.context], fixture.store)
                    : addPlugins([fixture.context], fixture.store, [
                          "modrinth:renamed@1.0.0",
                      ]);
            await expect(result).rejects.toMatchObject({
                code: "DUPLICATE_PLUGIN",
            });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([
        {
            options: { updateAllPlugins: true, to: "2" },
            code: "UPDATE_VERSION",
        },
        {
            options: {
                updateAllPlugins: true,
                updatePlugins: ["Example"],
            },
            code: "UPDATE_OPTIONS",
        },
    ])(
        "rejects invalid update option combinations with $code",
        async ({ options, code }) => {
            const fixture = await project();
            fixture.store.resolve.mockClear();
            fixture.store.ensure.mockClear();
            fixture.store.latest.mockClear();
            const before = await metadata(fixture.dir);

            await expect(
                installProjects([fixture.context], fixture.store, options),
            ).rejects.toMatchObject({ code });

            expect(await metadata(fixture.dir)).toEqual(before);
            expect(fixture.store.resolve).not.toHaveBeenCalled();
            expect(fixture.store.ensure).not.toHaveBeenCalled();
            expect(fixture.store.latest).not.toHaveBeenCalled();
        },
    );

    it("validates selectors across a workspace before artifact I/O", async () => {
        const root = await directory();
        await initWorkspace(root, ["servers/*"]);
        const alphaDir = path.join(root, "servers", "alpha");
        const alpha = await initProject(alphaDir, {
            name: "alpha",
            kind: "paper",
            version: "26.1",
        });
        alpha.plugins.Example = "modrinth:example@1.0.0";
        await writeYaml(path.join(alphaDir, "crafleet.yaml"), alpha);
        await initProject(path.join(root, "servers", "beta"), {
            name: "beta",
            kind: "paper",
            version: "26.1",
        });
        const projects = await selectProjects(root, path.join(root, "home"), {
            recursive: true,
        });
        const { store } = artifactStore(root);
        await installProjects(projects, store);
        store.resolve.mockClear();
        store.ensure.mockClear();
        store.latest.mockClear();

        await expect(
            installProjects(projects, store, {
                updatePlugins: ["Example"],
            }),
        ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN" });

        expect(store.resolve).not.toHaveBeenCalled();
        expect(store.ensure).not.toHaveBeenCalled();
        expect(store.latest).not.toHaveBeenCalled();
    });

    it("preflights every workspace declaration before artifact I/O", async () => {
        const root = await directory();
        await initWorkspace(root, ["servers/*"]);
        for (const name of ["alpha", "beta"])
            await initProject(path.join(root, "servers", name), {
                name,
                kind: "paper",
                version: "26.1",
            });
        const projects = await selectProjects(root, path.join(root, "home"), {
            recursive: true,
        });
        const invalid = projects.find(
            (project) => project.manifest.name === "beta",
        );
        if (!invalid) throw new Error("Expected the beta workspace project.");
        invalid.manifest.plugins.Example = "not-a-source";
        const { store } = artifactStore(root);

        await expect(
            addPlugins(projects, store, ["modrinth:new-plugin@1"]),
        ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
        expect(store.resolve).not.toHaveBeenCalled();
        expect(store.ensure).not.toHaveBeenCalled();
        expect(store.latest).not.toHaveBeenCalled();

        await expect(installProjects(projects, store)).rejects.toMatchObject({
            code: "INVALID_SOURCE",
        });

        expect(store.resolve).not.toHaveBeenCalled();
        expect(store.ensure).not.toHaveBeenCalled();
        expect(store.latest).not.toHaveBeenCalled();

        delete invalid.manifest.plugins.Example;
        await put(invalid.dir, ".crafleet/state.json", "not-json");
        await expect(
            addPlugins(projects, store, ["modrinth:new-plugin@1"]),
        ).rejects.toMatchObject({ code: "STATE_INVALID" });
        expect(store.resolve).not.toHaveBeenCalled();
        expect(store.ensure).not.toHaveBeenCalled();
        expect(store.latest).not.toHaveBeenCalled();
    });

    it("rejects a later workspace project's non-JAR source before artifact I/O", async () => {
        const fixture = await workspaceProjectPair();
        fixture.beta.manifest.plugins.Example =
            "github:owner/repo@v1#Example.zip";
        clearArtifactCalls(fixture.store);

        await expect(
            installProjects(fixture.projects, fixture.store),
        ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
        expectNoArtifactCalls(fixture.store);
        expect(await io.exists(path.join(fixture.root, "artifacts"))).toBe(
            false,
        );
    });

    it("rejects an unsafe locked plugin size before any artifact I/O", async () => {
        const fixture = await project();
        const lock = await readLock(fixture.context.lockRoot);
        const plugin = lock.projects[fixture.context.lockKey]?.plugins.Example;
        if (!plugin) throw new Error("Expected the plugin lock entry");
        plugin.size = Number.MAX_SAFE_INTEGER + 1;
        await writeYaml(
            path.join(fixture.context.lockRoot, "crafleet-lock.yaml"),
            lock,
        );
        clearArtifactCalls(fixture.store);

        await expect(
            installProjects([fixture.context], fixture.store),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expectNoArtifactCalls(fixture.store);
    });

    it.each([
        { operation: "install", dryRun: false },
        { operation: "install", dryRun: true },
        { operation: "add", dryRun: false },
        { operation: "add", dryRun: true },
    ] as const)(
        "rejects later-project deployment recovery before $operation artifact I/O during dryRun=$dryRun",
        async ({ operation, dryRun }) => {
            const fixture = await workspaceProjectPair();
            await installProjects(fixture.projects, fixture.store);
            await put(fixture.beta.dir, ".crafleet/deploy.json", "{}");
            clearArtifactCalls(fixture.store);

            const result =
                operation === "install"
                    ? installProjects(fixture.projects, fixture.store, {
                          dryRun,
                      })
                    : addPlugins(
                          fixture.projects,
                          fixture.store,
                          ["modrinth:renamed@1.0.0"],
                          { dryRun },
                      );

            await expect(result).rejects.toMatchObject({
                code: "RECOVERY_REQUIRED",
            });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([false, true])(
        "rejects shared manifest recovery before add-plugin identity resolution during dryRun=%s",
        async (dryRun) => {
            const fixture = await workspaceProjectPair();
            await put(
                fixture.root,
                ".crafleet/manifest-transaction.json",
                "{}",
            );
            clearArtifactCalls(fixture.store);

            await expect(
                addPlugins(
                    fixture.projects,
                    fixture.store,
                    ["modrinth:renamed@1.0.0"],
                    { dryRun },
                ),
            ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([false, true])(
        "rejects a later-project frozen server mismatch before workspace artifact I/O during dryRun=%s",
        async (dryRun) => {
            const fixture = await workspaceProjectPair();
            await installProjects(fixture.projects, fixture.store);
            fixture.beta.manifest.server.build = "99";
            clearArtifactCalls(fixture.store);

            await expect(
                installProjects(fixture.projects, fixture.store, {
                    frozen: true,
                    dryRun,
                }),
            ).rejects.toMatchObject({ code: "FROZEN_LOCK" });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([false, true])(
        "rejects a same-project frozen plugin mismatch before ensuring the server during dryRun=%s",
        async (dryRun) => {
            const fixture = await project();
            fixture.context.manifest.plugins.Example = "modrinth:example@9.0.0";
            clearArtifactCalls(fixture.store);

            await expect(
                installProjects([fixture.context], fixture.store, {
                    frozen: true,
                    dryRun,
                }),
            ).rejects.toMatchObject({ code: "FROZEN_LOCK" });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([false, true])(
        "rejects frozen plugin additions before resolving identities during dryRun=%s",
        async (dryRun) => {
            const fixture = await workspaceProjectPair();
            await installProjects(fixture.projects, fixture.store);
            clearArtifactCalls(fixture.store);

            await expect(
                addPlugins(
                    fixture.projects,
                    fixture.store,
                    ["modrinth:renamed@1.0.0"],
                    { frozen: true, dryRun },
                ),
            ).rejects.toMatchObject({ code: "FROZEN_LOCK" });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it.each([
        { operation: "install", dryRun: false },
        { operation: "install", dryRun: true },
        { operation: "add", dryRun: false },
        { operation: "add", dryRun: true },
    ] as const)(
        "rejects a later-project configuration conflict before $operation artifact I/O during dryRun=$dryRun",
        async ({ operation, dryRun }) => {
            const fixture = await workspaceProjectPair();
            await put(
                fixture.beta.dir,
                "config/server.properties",
                "motd=first\n",
            );
            await installProjects(fixture.projects, fixture.store);
            await new NodeDeploymentManager(
                fixture.beta,
                fixture.store,
            ).applyPrepared();
            await put(
                fixture.beta.dir,
                "config/server.properties",
                "motd=base-edit\n",
            );
            await put(
                fixture.beta.dir,
                "runtime/server.properties",
                "motd=runtime-edit\n",
            );
            clearArtifactCalls(fixture.store);

            const result =
                operation === "install"
                    ? installProjects(fixture.projects, fixture.store, {
                          dryRun,
                      })
                    : addPlugins(
                          fixture.projects,
                          fixture.store,
                          ["modrinth:renamed@1.0.0"],
                          { dryRun },
                      );

            await expect(result).rejects.toMatchObject({
                code: "CONFIG_CONFLICT",
            });
            expectNoArtifactCalls(fixture.store);
        },
    );

    it("updates shared lock entries only for selected projects and validates all plans before writing", async () => {
        const root = await directory();
        await initWorkspace(root, ["servers/*"]);
        for (const name of ["alpha", "beta"])
            await initProject(path.join(root, "servers", name), {
                name,
                kind: "paper",
                version: "26.1",
            });
        const projects = await selectProjects(root, path.join(root, "home"), {
            recursive: true,
        });
        const { store } = artifactStore(root);
        await installProjects(projects, store);
        const old = await readLock(root);
        const first = projects[0];
        const second = projects[1];
        if (!first || !second) throw new Error("Fixture members missing");
        await installProjects([first], store, { updateServer: true });
        const updated = await readLock(root);
        expect(updated.projects[second.lockKey]).toEqual(
            old.projects[second.lockKey],
        );
        expect(updated.projects[first.lockKey]?.server.version).toBe("2");
        const before = await Promise.all([
            metadata(first.dir),
            metadata(second.dir),
            readFile(path.join(root, "crafleet-lock.yaml"), "utf8"),
        ]);
        second.manifest.plugins.Example = "modrinth:renamed@1.0.0";
        await expect(installProjects(projects, store)).rejects.toMatchObject({
            code: "PLUGIN_IDENTITY",
        });
        expect(
            await Promise.all([
                metadata(first.dir),
                metadata(second.dir),
                readFile(path.join(root, "crafleet-lock.yaml"), "utf8"),
            ]),
        ).toEqual(before);
    });

    it("does not modify project metadata while another mutation owns the workspace lock", async () => {
        const fixture = await project();
        await mkdir(path.join(fixture.dir, ".crafleet/operation.lock"));
        const before = await metadata(fixture.dir);
        await expect(
            installProjects([fixture.context], fixture.store),
        ).rejects.toMatchObject({ code: "BUSY" });
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("recovers a partial first install, deleting only files created by the interrupted transaction", async () => {
        const fixture = await project({ installed: false });
        const before = await metadata(fixture.dir);
        const write = io.atomicWrite;
        const fault = vi
            .spyOn(io, "atomicWrite")
            .mockImplementation(async (file, content, mode) => {
                if (file === path.join(fixture.dir, "crafleet-lock.yaml"))
                    throw new Error("injected lock write failure");
                return write(file, content, mode);
            });
        await expect(
            installProjects([fixture.context], fixture.store),
        ).rejects.toMatchObject({ code: "MANIFEST_INTERRUPTED" });
        fault.mockRestore();
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/state.json")),
        ).toBe(true);
        expect(
            await io.exists(
                path.join(fixture.dir, ".crafleet/manifest-transaction.json"),
            ),
        ).toBe(true);
        const interrupted = await metadata(fixture.dir);
        await expect(recoverManifests(fixture.dir, true)).resolves.toBe(true);
        expect(await metadata(fixture.dir)).toEqual(interrupted);
        await expect(recoverManifests(fixture.dir)).resolves.toBe(true);
        expect(await metadata(fixture.dir)).toEqual(before);
        await expect(recoverManifests(fixture.dir)).resolves.toBe(false);
    });

    it("rolls back a partial update's YAML and state together", async () => {
        const fixture = await project();
        const before = await metadata(fixture.dir);
        const write = io.atomicWrite;
        const fault = vi
            .spyOn(io, "atomicWrite")
            .mockImplementation(async (file, content, mode) => {
                if (file === path.join(fixture.dir, "crafleet-lock.yaml"))
                    throw new Error("injected lock write failure");
                return write(file, content, mode);
            });
        await expect(
            installProjects([fixture.context], fixture.store, {
                updateAllPlugins: true,
            }),
        ).rejects.toMatchObject({ code: "MANIFEST_INTERRUPTED" });
        fault.mockRestore();
        expect(await contents(fixture.dir, "crafleet.yaml")).not.toBe(
            before["crafleet.yaml"],
        );
        await recoverManifests(fixture.dir);
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("refuses recovery if an operator edited any target after interruption", async () => {
        const root = await directory();
        await put(root, "crafleet.yaml", "operator edit");
        await put(root, "crafleet-lock.yaml", "lock after");
        await put(
            root,
            ".crafleet/manifest-transaction.json",
            JSON.stringify({
                schemaVersion: 1,
                phase: "writing",
                changes: [
                    {
                        relative: "crafleet.yaml",
                        before: "before",
                        after: "after",
                    },
                    {
                        relative: "crafleet-lock.yaml",
                        before: "lock before",
                        after: "lock after",
                    },
                ],
            }),
        );
        const before = await metadata(root);
        await expect(recoverManifests(root)).rejects.toMatchObject({
            code: "RECOVERY_CONFLICT",
        });
        expect(await metadata(root)).toEqual(before);
    });

    it("refuses metadata path traversal before touching any recovery target", async () => {
        const root = await directory();
        const target = path.join(root, "project");
        await put(root, "crafleet.yaml", "outside");
        await put(target, "crafleet-lock.yaml", "after");
        await put(
            target,
            ".crafleet/manifest-transaction.json",
            JSON.stringify({
                schemaVersion: 1,
                phase: "writing",
                changes: [
                    {
                        relative: "../crafleet.yaml",
                        before: "outside",
                        after: "outside",
                    },
                    {
                        relative: "crafleet-lock.yaml",
                        before: "before",
                        after: "after",
                    },
                ],
            }),
        );
        await expect(recoverManifests(target)).rejects.toMatchObject({
            code: "PATH_ESCAPE",
        });
        expect(await contents(root, "crafleet.yaml")).toBe("outside");
        expect(await contents(target, "crafleet-lock.yaml")).toBe("after");
    });

    it.each([
        null,
        { relative: 42, before: null, after: "after" },
        { relative: "crafleet.yaml", before: {}, after: "after" },
    ])(
        "rejects malformed recovery entries without TypeError or mutation: %j",
        async (change) => {
            const root = await directory();
            await put(root, "crafleet.yaml", "after");
            await put(
                root,
                ".crafleet/manifest-transaction.json",
                JSON.stringify({
                    schemaVersion: 1,
                    phase: "writing",
                    changes: [change],
                }),
            );
            const before = await metadata(root);
            await expect(recoverManifests(root)).rejects.toMatchObject({
                code: "JOURNAL_INVALID",
            });
            expect(await metadata(root)).toEqual(before);
        },
    );

    it("validates all linked recovery targets before rolling back any safe target", async () => {
        const root = await directory();
        const target = path.join(root, "project");
        const outside = path.join(root, "outside");
        await put(outside, "crafleet.yaml", "linked before");
        await put(target, "crafleet-lock.yaml", "safe after");
        await symlink(
            outside,
            path.join(target, "linked"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await put(
            target,
            ".crafleet/manifest-transaction.json",
            JSON.stringify({
                schemaVersion: 1,
                phase: "writing",
                changes: [
                    {
                        relative: "linked/crafleet.yaml",
                        before: "linked before",
                        after: "linked after",
                    },
                    {
                        relative: "crafleet-lock.yaml",
                        before: "safe before",
                        after: "safe after",
                    },
                ],
            }),
        );
        await expect(recoverManifests(target)).rejects.toMatchObject({
            code: "SYMLINK_UNSAFE",
        });
        expect(await contents(target, "crafleet-lock.yaml")).toBe("safe after");
        expect(await contents(outside, "crafleet.yaml")).toBe("linked before");
    });

    it("does not recover manifests while another operation holds the workspace mutex", async () => {
        const root = await directory();
        await put(root, "crafleet.yaml", "after");
        await put(
            root,
            ".crafleet/manifest-transaction.json",
            JSON.stringify({
                schemaVersion: 1,
                phase: "writing",
                changes: [
                    {
                        relative: "crafleet.yaml",
                        before: "before",
                        after: "after",
                    },
                ],
            }),
        );
        await mkdir(path.join(root, ".crafleet/operation.lock"));
        await expect(recoverManifests(root)).rejects.toMatchObject({
            code: "BUSY",
        });
        expect(await contents(root, "crafleet.yaml")).toBe("after");
    });
});

describe("deployment ownership and rollback", () => {
    it.each([
        ".crafleet/restore.json",
        ".crafleet/group-operation.json",
        ".crafleet/manifest-transaction.json",
        ".crafleet/deploy.json",
    ])("blocks preflight while %s requires recovery", async (file) => {
        const fixture = await project();
        await put(fixture.dir, file, "{}");
        fixture.store.ensure.mockClear();
        await expect(fixture.manager.preflight(true)).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
        expect(fixture.store.ensure).not.toHaveBeenCalled();
        expect(
            await io.exists(path.join(fixture.dir, "runtime/server.jar")),
        ).toBe(false);
    });

    it("requires a backup before ensuring pending artifacts over existing data", async () => {
        const fixture = await project();
        await put(fixture.dir, "runtime/world/level.dat", "existing world");
        vi.spyOn(java, "inspectJava").mockResolvedValue({
            executable: "fixture-java",
            major: 25,
            diagnostics: [],
        });
        fixture.store.ensure.mockClear();

        await expect(
            fixture.manager.preflight(true, false),
        ).rejects.toMatchObject({ code: "BACKUP_REQUIRED" });
        expect(fixture.store.ensure).not.toHaveBeenCalled();
    });

    it.each(["server.jar", "plugins/Example.jar"])(
        "rejects unknown different-content %s before journaling; recover is a no-op",
        async (relative) => {
            const fixture = await project();
            const file = await put(
                fixture.dir,
                `runtime/${relative}`,
                "operator-owned jar bytes",
            );
            const timestamp = new Date("2001-01-01T00:00:00Z");
            await utimes(file, timestamp, timestamp);
            const before = await metadata(fixture.dir);
            const fileBefore = await stat(file);
            await expect(fixture.manager.applyPrepared()).rejects.toMatchObject(
                { code: "UNMANAGED_JAR" },
            );
            expect(await fixture.manager.recover()).toEqual({
                recovered: false,
            });
            expect(await metadata(fixture.dir)).toEqual(before);
            expect(await readFile(file, "utf8")).toBe(
                "operator-owned jar bytes",
            );
            expect((await stat(file)).mtimeMs).toBe(fileBefore.mtimeMs);
        },
    );

    it("refuses unmanaged extra plugin JARs without writing managed JARs", async () => {
        const fixture = await project();
        await put(fixture.dir, "runtime/plugins/Manual.jar", "manual");
        await expect(fixture.manager.applyPrepared()).rejects.toMatchObject({
            code: "UNMANAGED_JAR",
        });
        expect(
            await io.exists(path.join(fixture.dir, "runtime/server.jar")),
        ).toBe(false);
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/deploy.json")),
        ).toBe(false);
        expect(await contents(fixture.dir, "runtime/plugins/Manual.jar")).toBe(
            "manual",
        );
    });

    it("adopts matching existing JARs without copying or changing their modification times", async () => {
        const fixture = await project();
        const next = await pending(fixture.dir);
        const plugin = next.lock.plugins.Example;
        if (!plugin) throw new Error("Plugin fixture missing");
        const entries = [
            ["server.jar", next.lock.server],
            ["plugins/Example.jar", plugin],
        ] as const;
        for (const [relative, artifact] of entries) {
            const file = await put(
                fixture.dir,
                `runtime/${relative}`,
                await readFile(
                    await fixture.store.ensure(artifact, {
                        projectDir: fixture.dir,
                        serverKind: "paper",
                    }),
                ),
            );
            await utimes(file, new Date("2001-01-01"), new Date("2001-01-01"));
        }
        fixture.store.ensure.mockClear();
        await fixture.manager.applyPrepared();
        expect(fixture.store.ensure).not.toHaveBeenCalled();
        for (const [relative] of entries)
            expect(
                (await stat(path.join(fixture.dir, "runtime", relative)))
                    .mtimeMs,
            ).toBe(new Date("2001-01-01").getTime());
        expect((await readState(fixture.dir)).active?.id).toBe(next.id);
        expect((await readState(fixture.dir)).pending).toBeUndefined();
    });

    it("preserves an initially adopted JAR during rollback and removes only newly created JARs", async () => {
        const fixture = await project();
        const next = await pending(fixture.dir);
        const server = path.join(fixture.dir, "runtime/server.jar");
        await copyFile(
            await fixture.store.ensure(next.lock.server, {
                projectDir: fixture.dir,
                serverKind: "paper",
            }),
            server,
        );
        await utimes(server, new Date("2001-01-01"), new Date("2001-01-01"));
        const original = await readFile(server);
        const interrupted = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            async (stage) => {
                if (stage === "jar:plugins/Example.jar")
                    throw new Error("injected interruption");
            },
        );
        await expect(interrupted.applyPrepared()).rejects.toMatchObject({
            code: "DEPLOY_INTERRUPTED",
        });
        expect(
            await io.readJson(path.join(fixture.dir, ".crafleet/deploy.json")),
        ).toMatchObject({ createdJars: ["plugins/Example.jar"] });
        expect(
            await io.exists(
                path.join(fixture.dir, "runtime/plugins/Example.jar"),
            ),
        ).toBe(true);
        await fixture.manager.recover();
        expect(await readFile(server)).toEqual(original);
        expect((await stat(server)).mtimeMs).toBe(
            new Date("2001-01-01").getTime(),
        );
        expect(
            await io.exists(
                path.join(fixture.dir, "runtime/plugins/Example.jar"),
            ),
        ).toBe(false);
        expect((await readState(fixture.dir)).active).toBeUndefined();
        expect((await pending(fixture.dir)).id).toBe(next.id);
    });

    it.each(["changed", "missing"] as const)(
        "blocks %s active JARs before update writes or journal creation",
        async (change) => {
            const fixture = await project();
            await fixture.manager.applyPrepared();
            await installProjects([fixture.context], fixture.store, {
                updateServer: true,
            });
            if (change === "changed")
                await put(
                    fixture.dir,
                    "runtime/server.jar",
                    "externally replaced",
                );
            else await rm(path.join(fixture.dir, "runtime/server.jar"));
            const before = await metadata(fixture.dir);
            await expect(fixture.manager.applyPrepared()).rejects.toMatchObject(
                { code: "JAR_DRIFT" },
            );
            expect(await fixture.manager.recover()).toEqual({
                recovered: false,
            });
            expect(await metadata(fixture.dir)).toEqual(before);
        },
    );

    it("restores previous JARs and tokenized configuration after a mid-update failure", async () => {
        const fixture = await project({ installed: false });
        await put(fixture.dir, "config/settings.json", '{"max":10}\n');
        await installProjects([fixture.context], fixture.store);
        await fixture.manager.applyPrepared();
        const old = (await readState(fixture.dir)).active;
        const originalJar = await readFile(
            path.join(fixture.dir, "runtime/server.jar"),
        );
        const originalConfig = await contents(
            fixture.dir,
            "runtime/settings.json",
        );
        const originalState = await contents(
            fixture.dir,
            ".crafleet/config-state.json",
        );
        await put(fixture.dir, "config/settings.json", '{"max":20}\n');
        await installProjects([fixture.context], fixture.store, {
            updateServer: true,
            updateAllPlugins: true,
        });
        const next = await pending(fixture.dir);
        const interrupted = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            async (stage) => {
                if (stage === "configuration")
                    throw new Error("injected interruption");
            },
        );
        await expect(interrupted.applyPrepared()).rejects.toMatchObject({
            code: "DEPLOY_INTERRUPTED",
        });
        expect(await contents(fixture.dir, "runtime/settings.json")).toBe(
            '{"max":20}\n',
        );
        const dry = await metadata(fixture.dir);
        await expect(fixture.manager.recover(true)).resolves.toEqual({
            recovered: true,
        });
        expect(await metadata(fixture.dir)).toEqual(dry);
        await fixture.manager.recover();
        expect(
            await readFile(path.join(fixture.dir, "runtime/server.jar")),
        ).toEqual(originalJar);
        expect(await contents(fixture.dir, "runtime/settings.json")).toBe(
            originalConfig,
        );
        expect(await contents(fixture.dir, ".crafleet/config-state.json")).toBe(
            originalState,
        );
        expect(await contents(fixture.dir, "config/settings.json")).toBe(
            '{"max":20}\n',
        );
        expect((await readState(fixture.dir)).active?.id).toBe(old?.id);
        expect((await pending(fixture.dir)).id).toBe(next.id);
        await fixture.manager.applyPrepared();
        expect((await readState(fixture.dir)).active?.id).toBe(next.id);
    });

    it("refuses to recover over an externally replaced JAR", async () => {
        const fixture = await project();
        const interrupted = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            async () => {
                throw new Error("injected interruption");
            },
        );
        await expect(interrupted.applyPrepared()).rejects.toMatchObject({
            code: "DEPLOY_INTERRUPTED",
        });
        await put(
            fixture.dir,
            "runtime/server.jar",
            "external edit after interruption",
        );
        const before = await metadata(fixture.dir);
        await expect(fixture.manager.recover()).rejects.toMatchObject({
            code: "JAR_DRIFT",
        });
        expect(await contents(fixture.dir, "runtime/server.jar")).toBe(
            "external edit after interruption",
        );
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("finishes state bookkeeping for an already applied deployment without rolling back its JARs", async () => {
        const fixture = await project();
        const next = await pending(fixture.dir);
        await fixture.manager.applyPrepared();
        const jarBefore = await readFile(
            path.join(fixture.dir, "runtime/server.jar"),
        );
        await put(
            fixture.dir,
            ".crafleet/deploy.json",
            JSON.stringify({
                schemaVersion: 1,
                phase: "applied",
                previous: null,
                next,
                createdJars: ["server.jar", "plugins/Example.jar"],
            }),
        );
        await expect(fixture.manager.recover()).resolves.toEqual({
            recovered: true,
        });
        expect(
            await readFile(path.join(fixture.dir, "runtime/server.jar")),
        ).toEqual(jarBefore);
        expect((await readState(fixture.dir)).active?.id).toBe(next.id);
        expect((await readState(fixture.dir)).pending).toBeUndefined();
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/deploy.json")),
        ).toBe(false);
    });

    it("checks configuration recovery before changing any interrupted JAR", async () => {
        const fixture = await project({ installed: false });
        await put(fixture.dir, "config/settings.json", '{"max":10}\n');
        await installProjects([fixture.context], fixture.store);
        const interrupted = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            async () => {
                throw new Error("injected interruption");
            },
        );
        await expect(interrupted.applyPrepared()).rejects.toMatchObject({
            code: "DEPLOY_INTERRUPTED",
        });
        await put(fixture.dir, "runtime/settings.json", '{"max":99}\n');
        const jarBefore = await readFile(
            path.join(fixture.dir, "runtime/server.jar"),
        );
        const before = await metadata(fixture.dir);
        await expect(fixture.manager.recover(true)).rejects.toMatchObject({
            code: "CONFIG_RECOVERY_REQUIRED",
        });
        await expect(fixture.manager.recover()).rejects.toMatchObject({
            code: "CONFIG_RECOVERY_REQUIRED",
        });
        expect(
            await readFile(path.join(fixture.dir, "runtime/server.jar")),
        ).toEqual(jarBefore);
        expect(await contents(fixture.dir, "runtime/settings.json")).toBe(
            '{"max":99}\n',
        );
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("does not implicitly adopt a new unmanaged JAR into an existing active deployment", async () => {
        const fixture = await project({ plugin: false });
        await fixture.manager.applyPrepared();
        fixture.context.manifest.plugins.Example = "modrinth:example@1.0.0";
        await installProjects([fixture.context], fixture.store);
        const next = await pending(fixture.dir);
        const plugin = next.lock.plugins.Example;
        if (!plugin) throw new Error("Fixture plugin missing");
        const bytes = await readFile(
            await fixture.store.ensure(plugin, {
                projectDir: fixture.dir,
                serverKind: "paper",
            }),
        );
        await put(fixture.dir, "runtime/plugins/Example.jar", bytes);
        await expect(fixture.manager.applyPrepared()).rejects.toMatchObject({
            code: "UNMANAGED_JAR",
        });
        expect(await fixture.manager.recover()).toEqual({ recovered: false });
        expect(
            await readFile(
                path.join(fixture.dir, "runtime/plugins/Example.jar"),
            ),
        ).toEqual(bytes);
    });

    it("checks copied artifact bytes against the lock before replacing runtime targets", async () => {
        const fixture = await project();
        const next = await pending(fixture.dir);
        const cache = fixture.files.get(next.lock.server.sha256);
        if (!cache) throw new Error("Fixture cache missing");
        await writeFile(cache, "corrupted cache");
        await expect(fixture.manager.applyPrepared()).rejects.toMatchObject({
            code: "DEPLOY_INTERRUPTED",
        });
        expect(
            await io.exists(path.join(fixture.dir, "runtime/server.jar")),
        ).toBe(false);
        expect(
            (await readdir(path.join(fixture.dir, "runtime"))).some((file) =>
                file.endsWith(".tmp"),
            ),
        ).toBe(false);
        await fixture.manager.recover();
        expect((await readState(fixture.dir)).active).toBeUndefined();
    });

    it("rejects plugin filenames derived from unsafe persisted identity metadata", async () => {
        const fixture = await project();
        const next = await pending(fixture.dir);
        const plugin = next.lock.plugins.Example;
        if (!plugin?.identity) throw new Error("Fixture plugin missing");
        const unsafe = "../../outside";
        next.lock.plugins = {
            [unsafe]: {
                ...plugin,
                identity: { ...plugin.identity, id: unsafe },
            },
        };
        await saveState(fixture.dir, { schemaVersion: 1, pending: next });
        await put(fixture.root, "outside.jar", "outside sentinel");
        const before = await metadata(fixture.dir);
        await expect(fixture.manager.applyPrepared()).rejects.toMatchObject({
            code: "JAR_PATH",
        });
        expect(await contents(fixture.root, "outside.jar")).toBe(
            "outside sentinel",
        );
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it.each([["../outside.jar"], ["server.jar", "server.jar"]])(
        "rejects unsafe or duplicated created-JAR journal entries: %j",
        async (...createdJars) => {
            const fixture = await project();
            const next = await pending(fixture.dir);
            await put(
                fixture.dir,
                ".crafleet/deploy.json",
                JSON.stringify({
                    schemaVersion: 1,
                    phase: "applying",
                    previous: null,
                    next,
                    createdJars,
                }),
            );
            const before = await metadata(fixture.dir);
            await expect(fixture.manager.recover()).rejects.toMatchObject({
                code: "JOURNAL_INVALID",
            });
            expect(await metadata(fixture.dir)).toEqual(before);
        },
    );

    it("refuses writes without confirmed stop, but permits read-only planning", async () => {
        const fixture = await project();
        vi.spyOn(fixture.manager.controller, "status").mockResolvedValue({
            status: "unknown",
        });
        const before = await metadata(fixture.dir);
        await expect(fixture.manager.applyPrepared()).rejects.toMatchObject({
            code: "NOT_STOPPED",
        });
        await expect(fixture.manager.recover()).rejects.toMatchObject({
            code: "NOT_STOPPED",
        });
        await expect(fixture.manager.apply(true)).resolves.toMatchObject({
            status: { status: "unknown" },
            pending: (await pending(fixture.dir)).id,
        });
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("discards pending only when no deployment recovery is outstanding", async () => {
        const fixture = await project();
        const before = await metadata(fixture.dir);
        await fixture.manager.discard(true);
        expect(await metadata(fixture.dir)).toEqual(before);
        await put(fixture.dir, ".crafleet/deploy.json", "{}");
        await expect(fixture.manager.discard()).rejects.toMatchObject({
            code: "RECOVERY_REQUIRED",
        });
        expect((await readState(fixture.dir)).pending).toBeDefined();
        await rm(path.join(fixture.dir, ".crafleet/deploy.json"));
        await fixture.manager.discard();
        expect((await readState(fixture.dir)).pending).toBeUndefined();
    });

    it("cold backup resumes the active installation and leaves persisted pending untouched", async () => {
        const fixture = await project();
        await fixture.manager.applyPrepared();
        const active = (await readState(fixture.dir)).active;
        if (!active) throw new Error("Fixture active missing");
        await installProjects([fixture.context], fixture.store, {
            updateServer: true,
        });
        await put(fixture.dir, "runtime/eula.txt", "eula=true\n");
        const before = await metadata(fixture.dir);
        const unsupported = async (): Promise<never> => {
            throw new Error("Unexpected backup method");
        };
        const backup: BackupService = {
            config: { files: [] },
            prepare: vi.fn(async () => ({
                path: "fixture-restic",
                version: "fixture",
            })),
            preflight: vi.fn(async () => ({
                roots: [],
                files: [],
                bytes: 0,
                stagingBytes: 0,
                databaseIds: [],
                warnings: [],
            })),
            create: vi.fn(async (value) => ({
                snapshotId: "saved",
                repository: "fixture",
                fileCount: 0,
                bytes: 0,
                metadata: {
                    format: 1 as const,
                    projectId: "fixture",
                    createdAt: "2026-08-29",
                    active: value,
                    roots: [],
                    files: [],
                    databases: [],
                },
            })),
            setup: unsupported,
            plan: unsupported,
            list: unsupported,
            show: unsupported,
            diff: unsupported,
            check: unsupported,
            planRestore: unsupported,
            restore: unsupported,
            prune: unsupported,
        };
        const signal = new AbortController().signal;
        const manager = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            backup,
            undefined,
            undefined,
            { offline: true, signal },
        );
        let status: "running" | "stopped" = "running";
        vi.spyOn(manager.controller, "status").mockImplementation(async () =>
            status === "running"
                ? { status, activeId: active.id }
                : { status, clean: true },
        );
        vi.spyOn(manager.controller, "stop").mockImplementation(async () => {
            status = "stopped";
            return { status, clean: true };
        });
        const start = vi
            .spyOn(manager.controller, "start")
            .mockImplementation(async () => {
                expect(status).toBe("stopped");
                status = "running";
                return { status, activeId: active.id };
            });
        const apply = vi.spyOn(manager, "applyPrepared");
        expect(await manager.createBackup()).toMatchObject({
            resumed: true,
            backup: { snapshotId: "saved" },
        });
        expect(start).toHaveBeenCalledWith(active.id);
        expect(backup.prepare).toHaveBeenCalledWith({ offline: true, signal });
        expect(backup.preflight).toHaveBeenCalledWith({ signal });
        expect(backup.create).toHaveBeenCalledWith(
            { installation: active },
            { signal },
        );
        expect(apply).not.toHaveBeenCalled();
        expect(await metadata(fixture.dir)).toEqual(before);
    });

    it("passes offline and cancellation through artifact preflight before starting", async () => {
        const fixture = await project();
        await put(fixture.dir, "runtime/eula.txt", "eula=true\n");
        vi.spyOn(java, "inspectJava").mockResolvedValue({
            executable: "fixture-java",
            major: 25,
            diagnostics: [],
        });
        const controller = new AbortController();
        const manager = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            undefined,
            { offline: true, signal: controller.signal },
        );
        fixture.store.ensure.mockClear();
        await manager.preflight(true);
        expect(fixture.store.ensure).toHaveBeenCalledTimes(2);
        expect(
            fixture.store.ensure.mock.calls.every(
                ([, context]) =>
                    context.offline && context.signal === controller.signal,
            ),
        ).toBe(true);
        controller.abort(new Error("cancelled"));
        fixture.store.ensure.mockClear();
        await expect(manager.preflight(true)).rejects.toThrow("cancelled");
        expect(fixture.store.ensure).not.toHaveBeenCalled();
        expect(
            await io.exists(path.join(fixture.dir, ".crafleet/deploy.json")),
        ).toBe(false);
    });

    it("checks the runtime volume before stopping instead of relying on cache or backup staging capacity", async () => {
        const fixture = await project();
        const installation = await pending(fixture.dir);
        installation.lock.server.size = Number.MAX_SAFE_INTEGER - 4096;
        await saveState(fixture.dir, {
            schemaVersion: 1,
            pending: installation,
        });
        await put(fixture.dir, "runtime/eula.txt", "eula=true\n");
        vi.spyOn(java, "inspectJava").mockResolvedValue({
            executable: "fixture-java",
            major: 25,
            diagnostics: [],
        });
        vi.spyOn(fixture.manager.controller, "status").mockResolvedValue({
            status: "running",
        });
        const stop = vi.spyOn(fixture.manager.controller, "stop");
        const before = await treeBytes(fixture.dir);
        await expect(fixture.manager.restart()).rejects.toMatchObject({
            code: "RUNTIME_SPACE",
        });
        expect(stop).not.toHaveBeenCalled();
        expect(await treeBytes(fixture.dir)).toEqual(before);
    });

    it("uses the runtime path and conservative replacement bytes and propagates unknown capacity errors", async () => {
        const fixture = await project();
        await put(fixture.dir, "runtime/eula.txt", "eula=true\n");
        vi.spyOn(java, "inspectJava").mockResolvedValue({
            executable: "fixture-java",
            major: 25,
            diagnostics: [],
        });
        const check = vi.spyOn(backupFiles, "checkBackupSpace");
        const installation = await pending(fixture.dir);
        await fixture.manager.preflight(true);
        expect(check).toHaveBeenCalledWith(
            path.join(fixture.dir, "runtime"),
            installation.lock.server.size +
                Object.values(installation.lock.plugins).reduce(
                    (sum, item) => sum + item.size,
                    0,
                ),
        );
        const failure = Object.assign(
            new Error("fixture unavailable filesystem"),
            { code: "EIO" },
        );
        check.mockRejectedValue(failure);
        await expect(fixture.manager.preflight(true)).rejects.toBe(failure);
        installation.lock.server.size = Number.MAX_SAFE_INTEGER;
        await saveState(fixture.dir, {
            schemaVersion: 1,
            pending: installation,
        });
        await expect(fixture.manager.preflight(true)).rejects.toMatchObject({
            code: "RUNTIME_SPACE",
        });
    });
});

describe("explicit Paper EULA consent", () => {
    const java25 = () =>
        vi.spyOn(java, "inspectJava").mockResolvedValue({
            executable: "fixture-java",
            major: 25,
            diagnostics: [],
        });

    it("does not create a project or receipt when initial consent is declined", async () => {
        const root = await directory();
        const home = path.join(root, "home");
        const target = path.join(root, "paper");
        const decline = vi.fn(async () => {
            throw new CrafleetError(
                "CONFIRMATION_REQUIRED",
                "Explicit consent was not provided.",
                3,
            );
        });
        await expect(
            initProject(target, {
                name: "paper",
                kind: "paper",
                version: "26.1",
                eula: { home, requestConsent: decline },
            }),
        ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
        expect(decline).toHaveBeenCalledOnce();
        expect(await io.listFiles(root)).toEqual([]);
        expect(await io.exists(path.join(target, "crafleet.yaml"))).toBe(false);
        expect(await io.exists(path.join(home, "eula.json"))).toBe(false);
    });

    it("remembers consent for later Paper initialization without creating runtime eula.txt", async () => {
        const root = await directory();
        const home = path.join(root, "home");
        const accept = vi.fn(async () => undefined);
        await initProject(path.join(root, "first"), {
            name: "first",
            kind: "paper",
            version: "26.1",
            eula: { home, requestConsent: accept },
        });
        const refuseSecondPrompt = vi.fn(async () => {
            throw new Error("must not prompt again");
        });
        await initProject(path.join(root, "second"), {
            name: "second",
            kind: "paper",
            version: "26.1",
            eula: { home, requestConsent: refuseSecondPrompt },
        });
        expect(accept).toHaveBeenCalledOnce();
        expect(refuseSecondPrompt).not.toHaveBeenCalled();
        expect(
            JSON.parse(await readFile(path.join(home, "eula.json"), "utf8")),
        ).toMatchObject({
            schemaVersion: 1,
            url: "https://www.minecraft.net/eula",
            accepted: true,
        });
        expect(await io.exists(path.join(root, "first/runtime/eula.txt"))).toBe(
            false,
        );
        expect(
            await io.exists(path.join(root, "second/runtime/eula.txt")),
        ).toBe(false);
    });

    it("does not prompt or write during a dry-run initialization", async () => {
        const root = await directory();
        const home = path.join(root, "home");
        const request = vi.fn(async () => undefined);
        await initProject(path.join(root, "preview"), {
            name: "preview",
            kind: "paper",
            version: "26.1",
            dryRun: true,
            eula: { home, requestConsent: request },
        });
        expect(request).not.toHaveBeenCalled();
        expect(await io.listFiles(root)).toEqual([]);
        expect(await io.exists(home)).toBe(false);
    });

    it("rejects an unsafe init target before requesting or recording consent", async () => {
        const root = await directory();
        const external = path.join(root, "external");
        const target = path.join(root, "linked");
        const home = path.join(root, "home");
        await mkdir(external);
        await symlink(
            external,
            target,
            process.platform === "win32" ? "junction" : "dir",
        );
        const request = vi.fn(async () => undefined);
        await expect(
            initProject(target, {
                name: "unsafe",
                kind: "paper",
                version: "26.1",
                eula: { home, requestConsent: request },
            }),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
        expect(request).not.toHaveBeenCalled();
        expect(await readdir(external)).toEqual([]);
        expect(await io.exists(path.join(home, "eula.json"))).toBe(false);
    });

    it.each(["manifest", "symlink"] as const)(
        "revalidates a %s target change made while consent is open",
        async (kind) => {
            const root = await directory();
            const target = path.join(root, "paper");
            const home = path.join(root, "home");
            const external = path.join(root, "external");
            if (kind === "symlink") await mkdir(external);
            const request = vi.fn(async () => {
                if (kind === "manifest") {
                    await mkdir(target, { recursive: true });
                    await writeFile(
                        path.join(target, "crafleet.yaml"),
                        "existing project\n",
                    );
                } else
                    await symlink(
                        external,
                        target,
                        process.platform === "win32" ? "junction" : "dir",
                    );
            });

            await expect(
                initProject(target, {
                    name: "paper",
                    kind: "paper",
                    version: "26.1",
                    eula: { home, requestConsent: request },
                }),
            ).rejects.toMatchObject({
                code: kind === "manifest" ? "PROJECT_EXISTS" : "SYMLINK_UNSAFE",
            });

            expect(request).toHaveBeenCalledOnce();
            expect(await io.exists(path.join(home, "eula.json"))).toBe(true);
            if (kind === "manifest")
                expect(
                    await readFile(path.join(target, "crafleet.yaml"), "utf8"),
                ).toBe("existing project\n");
            else expect(await readdir(external)).toEqual([]);
            expect(await io.exists(path.join(target, "config"))).toBe(false);
            expect(await io.exists(path.join(target, "runtime"))).toBe(false);
        },
    );

    it.each(["corrupt", "oversized", "hard-linked"] as const)(
        "fails closed for a %s saved consent record",
        async (kind) => {
            const root = await directory();
            const home = path.join(root, "home");
            await ensurePrivateDirectory(home);
            const file = path.join(home, "eula.json");
            if (kind === "corrupt") await io.atomicWrite(file, "{}\n");
            else if (kind === "oversized")
                await io.atomicWrite(file, "x".repeat(64 * 1024 + 1));
            else {
                const external = await put(
                    root,
                    "external.json",
                    `${JSON.stringify(
                        {
                            schemaVersion: 1,
                            url: "https://www.minecraft.net/eula",
                            accepted: true,
                            acceptedAt: new Date().toISOString(),
                        },
                        null,
                        4,
                    )}\n`,
                );
                await link(external, file);
            }
            const request = vi.fn(async () => undefined);
            await expect(
                ensureUserEulaConsent(home, request),
            ).rejects.toMatchObject({ code: "EULA_CONSENT_INVALID" });
            expect(request).not.toHaveBeenCalled();
            expect(await io.exists(path.join(home, "eula.lock"))).toBe(false);
        },
    );

    it.runIf(process.platform !== "win32")(
        "rejects a saved consent record readable by another OS user",
        async () => {
            const root = await directory();
            const home = path.join(root, "home");
            const file = await put(
                home,
                "eula.json",
                `${JSON.stringify(
                    {
                        schemaVersion: 1,
                        url: "https://www.minecraft.net/eula",
                        accepted: true,
                        acceptedAt: new Date().toISOString(),
                    },
                    null,
                    4,
                )}\n`,
            );
            await chmod(file, 0o644);
            const request = vi.fn(async () => undefined);
            await expect(
                ensureUserEulaConsent(home, request),
            ).rejects.toMatchObject({ code: "EULA_CONSENT_INVALID" });
            expect(request).not.toHaveBeenCalled();
        },
    );

    it("recovers a consent lock only after its recorded process has exited", async () => {
        const root = await directory();
        const home = path.join(root, "home");
        await ensurePrivateDirectory(home);
        let deadPid = 2_000_000_000;
        while (!processDefinitelyExited(deadPid) && deadPid > 1_999_999_000)
            deadPid--;
        if (!processDefinitelyExited(deadPid))
            throw new Error("Could not reserve a dead fixture PID");
        const lock = path.join(home, "eula.lock");
        await ensurePrivateDirectory(lock);
        const owner = path.join(lock, "owner.json");
        await io.atomicWrite(
            owner,
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    pid: deadPid,
                    startedAt: new Date().toISOString(),
                },
                null,
                4,
            )}\n`,
        );
        await ensurePrivateFile(owner);
        const request = vi.fn(async () => undefined);
        await expect(ensureUserEulaConsent(home, request)).resolves.toBe(true);
        expect(request).toHaveBeenCalledOnce();
        expect(await io.exists(lock)).toBe(false);
        expect(await io.exists(path.join(home, "eula.json"))).toBe(true);
    });

    it("retains a consent lock owned by a live process", async () => {
        const root = await directory();
        const home = path.join(root, "home");
        await ensurePrivateDirectory(home);
        const lock = path.join(home, "eula.lock");
        await ensurePrivateDirectory(lock);
        const owner = path.join(lock, "owner.json");
        await io.atomicWrite(
            owner,
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    pid: process.pid,
                    startedAt: new Date().toISOString(),
                },
                null,
                4,
            )}\n`,
        );
        await ensurePrivateFile(owner);
        const request = vi.fn(async () => undefined);
        await expect(
            ensureUserEulaConsent(home, request),
        ).rejects.toMatchObject({ code: "BUSY" });
        expect(request).not.toHaveBeenCalled();
        expect(await io.exists(lock)).toBe(true);
    });

    it.runIf(process.platform === "darwin")(
        "removes directory ACL inheritance and rejects an ACL on the saved receipt",
        async () => {
            const root = await directory();
            const home = path.join(root, "home");
            await mkdir(home);
            const execute = promisify(execFile);
            await execute(
                "/bin/chmod",
                ["+a", "everyone allow read,write", home],
                { env: { ...process.env, LC_ALL: "C" } },
            );
            await ensurePrivateDirectory(home);
            const listing = await execute("/bin/ls", ["-lde", home], {
                env: { ...process.env, LC_ALL: "C" },
            });
            expect(String(listing.stdout)).not.toMatch(/^\s*\d+:/m);

            await ensureUserEulaConsent(home, async () => undefined);
            const receipt = path.join(home, "eula.json");
            await execute(
                "/bin/chmod",
                ["+a", "everyone allow read,write", receipt],
                { env: { ...process.env, LC_ALL: "C" } },
            );
            const request = vi.fn(async () => undefined);
            await expect(
                ensureUserEulaConsent(home, request),
            ).rejects.toMatchObject({ code: "EULA_CONSENT_INVALID" });
            expect(request).not.toHaveBeenCalled();
        },
    );

    it("records consent in preflight, then materializes it only at launch", async () => {
        const fixture = await project();
        java25();
        const request = vi.fn(async (document) => {
            expect(document.path).toBe(
                path.join(fixture.dir, "runtime/eula.txt"),
            );
            expect(document.text).toContain("eula=false");
            expect(document.url).toBe("https://www.minecraft.net/eula");
        });
        const manager = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            undefined,
            { requestEulaConsent: request },
        );
        const start = vi
            .spyOn(manager.controller, "start")
            .mockResolvedValue({ status: "running" });
        const before = await metadata(fixture.dir);
        await manager.preflight(true);
        const eulaFile = path.join(fixture.dir, "runtime/eula.txt");
        const receipt = path.join(fixture.home, "eula.json");
        expect(await io.exists(eulaFile)).toBe(false);
        expect(request).toHaveBeenCalledOnce();
        expect(await metadata(fixture.dir)).toEqual(before);
        const receiptBytes = await readFile(receipt);
        const receiptTime = (await stat(receipt)).mtimeMs;
        await manager.preflight(true);
        expect(request).toHaveBeenCalledOnce();
        expect(await io.exists(eulaFile)).toBe(false);
        expect(await readFile(receipt)).toEqual(receiptBytes);
        expect((await stat(receipt)).mtimeMs).toBe(receiptTime);

        await manager.applyPrepared();
        await manager.spawnActive();
        expect(await readFile(eulaFile, "utf8")).toBe("eula=true\n");
        const eulaBytes = await readFile(eulaFile);
        const eulaTime = (await stat(eulaFile)).mtimeMs;
        await manager.spawnActive();
        expect(start).toHaveBeenCalledTimes(2);
        expect(await readFile(eulaFile)).toEqual(eulaBytes);
        expect((await stat(eulaFile)).mtimeMs).toBe(eulaTime);
        expect(await readFile(receipt)).toEqual(receiptBytes);
        expect((await stat(receipt)).mtimeMs).toBe(receiptTime);
        expect(await readEulaDocument(fixture.context)).toMatchObject({
            path: eulaFile,
            text: "eula=true\n",
        });
    });

    it("uses an existing runtime acceptance without creating host consent", async () => {
        const fixture = await project();
        java25();
        await put(fixture.dir, "runtime/eula.txt", "# imported\neula=TRUE\n");
        const request = vi.fn(async () => {
            throw new Error("must not prompt");
        });
        const manager = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            undefined,
            { requestEulaConsent: request },
        );
        await manager.preflight(true);
        expect(request).not.toHaveBeenCalled();
        expect(await io.exists(path.join(fixture.home, "eula.json"))).toBe(
            false,
        );
        expect(await contents(fixture.dir, "runtime/eula.txt")).toBe(
            "# imported\neula=TRUE\n",
        );
    });

    it.each([
        {
            active: "paper" as const,
            desired: "velocity" as const,
            prompts: true,
        },
        {
            active: "velocity" as const,
            desired: "paper" as const,
            prompts: false,
        },
    ])(
        "uses the active $active server type during a declared migration to $desired",
        async ({ active, desired, prompts }) => {
            const root = await directory();
            const dir = path.join(root, "project");
            const home = path.join(root, "home");
            await initProject(dir, {
                name: "migration",
                kind: active,
                version: active === "paper" ? "26.1" : "4.1.1",
            });
            const original = await loadProject(dir, home);
            const provider = artifactStore(root);
            await installProjects([original], provider.store);
            await new NodeDeploymentManager(
                original,
                provider.store,
            ).applyPrepared();
            const declaration = await loadProject(dir, home);
            await writeYaml(path.join(dir, "crafleet.yaml"), {
                ...declaration.manifest,
                server: {
                    type: desired,
                    version: desired === "paper" ? "26.1" : "4.1.1",
                    build: "1",
                },
            });
            const current = await loadProject(dir, home);
            java25();
            const request = vi.fn(async () => undefined);
            await new NodeDeploymentManager(
                current,
                provider.store,
                undefined,
                undefined,
                undefined,
                { requestEulaConsent: request },
            ).preflight(false);
            expect(request).toHaveBeenCalledTimes(prompts ? 1 : 0);
            expect(await io.exists(path.join(dir, "runtime/eula.txt"))).toBe(
                false,
            );
            expect(await io.exists(path.join(home, "eula.json"))).toBe(prompts);
        },
    );

    it("keeps Velocity running through consent preflight and materializes Paper consent after restart stops it", async () => {
        const root = await directory();
        const dir = path.join(root, "migration");
        const home = path.join(root, "home");
        await initProject(dir, {
            name: "migration",
            kind: "velocity",
            version: "4.1.1",
        });
        const provider = artifactStore(root);
        const original = await loadProject(dir, home);
        await installProjects([original], provider.store);
        await new NodeDeploymentManager(
            original,
            provider.store,
        ).applyPrepared();
        const declaration = await loadProject(dir, home);
        await writeYaml(path.join(dir, "crafleet.yaml"), {
            ...declaration.manifest,
            server: { type: "paper", version: "26.1", build: "1" },
        });
        const current = await loadProject(dir, home);
        await installProjects([current], provider.store);

        const unsupported = async (): Promise<never> => {
            throw new Error("Unexpected backup method");
        };
        const backup: BackupService = {
            config: { files: [] },
            prepare: vi.fn(async () => ({
                path: "fixture-restic",
                version: "fixture",
            })),
            preflight: vi.fn(async () => ({
                roots: [],
                files: [],
                bytes: 0,
                stagingBytes: 0,
                databaseIds: [],
                warnings: [],
            })),
            create: vi.fn(async (value) => ({
                snapshotId: "saved",
                repository: "fixture",
                fileCount: 0,
                bytes: 0,
                metadata: {
                    format: 1 as const,
                    projectId: "fixture",
                    createdAt: "2026-08-29",
                    active: value,
                    roots: [],
                    files: [],
                    databases: [],
                },
            })),
            setup: unsupported,
            plan: unsupported,
            list: unsupported,
            show: unsupported,
            diff: unsupported,
            check: unsupported,
            planRestore: unsupported,
            restore: unsupported,
            prune: unsupported,
        };
        java25();
        let status: "running" | "stopped" = "running";
        const events: string[] = [];
        vi.spyOn(NodeServerController.prototype, "status").mockImplementation(
            async () => ({ status }),
        );
        vi.spyOn(NodeServerController.prototype, "stop").mockImplementation(
            async () => {
                events.push("stop");
                status = "stopped";
                return { status };
            },
        );
        vi.spyOn(NodeServerController.prototype, "start").mockImplementation(
            async (activeId) => {
                events.push("spawn");
                expect(status).toBe("stopped");
                expect(await contents(dir, "runtime/eula.txt")).toBe(
                    "eula=true\n",
                );
                status = "running";
                return { status, activeId };
            },
        );
        const request = vi.fn(async () => {
            events.push("consent");
            expect(status).toBe("running");
            expect(await io.exists(path.join(dir, "runtime/eula.txt"))).toBe(
                false,
            );
        });
        const manager = new NodeDeploymentManager(
            current,
            provider.store,
            backup,
            undefined,
            undefined,
            { requestEulaConsent: request },
        );
        await expect(manager.restart()).resolves.toMatchObject({
            status: "running",
        });
        expect(request).toHaveBeenCalledOnce();
        expect(events).toEqual(["consent", "stop", "spawn"]);
        expect((await readState(dir)).active?.manifest.server.type).toBe(
            "paper",
        );
        expect(await io.exists(path.join(home, "eula.json"))).toBe(true);
    });

    it("does not request consent for preparation-only preflight", async () => {
        const fixture = await project();
        java25();
        const request = vi.fn(async () => undefined);
        const manager = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            undefined,
            { requestEulaConsent: request },
        );
        await manager.preflight(true, false);
        expect(request).not.toHaveBeenCalled();
        expect(
            await io.exists(path.join(fixture.dir, "runtime/eula.txt")),
        ).toBe(false);
        expect(await io.exists(path.join(fixture.home, "eula.json"))).toBe(
            false,
        );
    });

    it("records consent without rewriting runtime while Paper is running", async () => {
        const fixture = await project();
        java25();
        vi.spyOn(NodeServerController.prototype, "status").mockResolvedValue({
            status: "running",
        });
        const request = vi.fn(async () => undefined);
        const manager = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            undefined,
            { requestEulaConsent: request },
        );
        await manager.preflight(true);
        expect(request).toHaveBeenCalledOnce();
        expect(
            await io.exists(path.join(fixture.dir, "runtime/eula.txt")),
        ).toBe(false);
        expect(await io.exists(path.join(fixture.home, "eula.json"))).toBe(
            true,
        );
    });

    it("refuses a managed unaccepted EULA without changing declarations or pending state", async () => {
        const fixture = await project();
        java25();
        await put(fixture.dir, "config/eula.txt", "eula=false\n");
        await installProjects([fixture.context], fixture.store);
        const request = vi.fn(async () => undefined);
        const manager = new NodeDeploymentManager(
            fixture.context,
            fixture.store,
            undefined,
            undefined,
            undefined,
            { requestEulaConsent: request },
        );
        const before = await metadata(fixture.dir);
        await expect(manager.preflight(true)).rejects.toMatchObject({
            code: "EULA_MANAGED",
        });
        expect(request).not.toHaveBeenCalled();
        expect(await metadata(fixture.dir)).toEqual(before);
        expect(
            await io.exists(path.join(fixture.dir, "runtime/eula.txt")),
        ).toBe(false);
        expect(await io.exists(path.join(fixture.home, "eula.json"))).toBe(
            false,
        );
    });

    it("parses Java properties without substring false positives", () => {
        expect(hasAcceptedEula("e\\u0075la : \\u0074rue\n")).toBe(true);
        expect(hasAcceptedEula("eula=true \n")).toBe(false);
        expect(hasAcceptedEula("note=value\\\neula=true\n")).toBe(false);
        expect(() => hasAcceptedEula("eula=true\neula=false\n")).toThrow(
            expect.objectContaining({ code: "EULA_INVALID" }),
        );
    });
});

describe("filesystem and persisted state guards", () => {
    it("replaces files atomically and removes temporary files after a write failure", async () => {
        const root = await directory();
        const target = await put(root, "state.json", "before");
        await io.atomicWrite(target, "after");
        expect(await readFile(target, "utf8")).toBe("after");
        // An invalid adapter payload makes the real FileHandle.writeFile fail after opening the temporary file.
        await expect(
            io.atomicWrite(target, {} as Uint8Array),
        ).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe("after");
        expect(await readdir(root)).toEqual(["state.json"]);
    });

    it("removes the temporary file when atomic rename cannot replace a directory", async () => {
        const root = await directory();
        const target = path.join(root, "directory");
        await mkdir(target);
        await expect(io.atomicWrite(target, "after")).rejects.toThrow();
        expect(await readdir(root)).toEqual(["directory"]);
        expect(await readdir(target)).toEqual([]);
    });

    it("lists regular files deterministically and refuses a linked traversal root", async () => {
        const root = await directory();
        const real = path.join(root, "real");
        await put(real, "b/two", "2");
        await put(real, "a", "1");
        expect(await io.listFiles(real)).toEqual(["a", "b/two"]);
        expect(await io.listFiles(path.join(root, "absent"))).toEqual([]);
        await symlink(
            real,
            path.join(root, "linked"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(
            io.listFiles(path.join(root, "linked")),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
    });

    it("rejects lock and file writes through linked parents before any action", async () => {
        const root = await directory();
        const real = path.join(root, "real");
        await mkdir(real);
        const linked = path.join(root, "linked");
        await symlink(
            real,
            linked,
            process.platform === "win32" ? "junction" : "dir",
        );
        const action = vi.fn(async () => "unexpected");
        await expect(
            io.withMutex(path.join(linked, "operation.lock"), action),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
        await expect(
            io.atomicWrite(path.join(linked, "state.json"), "unexpected"),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
        expect(action).not.toHaveBeenCalled();
        expect(await readdir(real)).toEqual([]);
    });

    it("records mutex ownership, rejects reentry and cleans up after action failure", async () => {
        const root = await directory();
        const lock = path.join(root, "operation.lock");
        await expect(
            io.withMutex(lock, async () => {
                expect(
                    await io.readJson(path.join(lock, "owner.json")),
                ).toMatchObject({ pid: process.pid });
                await expect(
                    io.withMutex(lock, async () => undefined),
                ).rejects.toMatchObject({ code: "BUSY" });
                throw new Error("action failed");
            }),
        ).rejects.toThrow("action failed");
        expect(await io.exists(lock)).toBe(false);
        await expect(io.withMutex(lock, async () => "reused")).resolves.toBe(
            "reused",
        );
    });

    it.each([
        "not json: private-value",
        JSON.stringify({ schemaVersion: 2, password: "private-value" }),
        JSON.stringify({ schemaVersion: 1, active: { id: "invalid" } }),
    ])("fails closed on malformed persisted state", async (text) => {
        const root = await directory();
        await put(root, ".crafleet/state.json", text);
        await expect(readState(root)).rejects.toMatchObject({
            code: "STATE_INVALID",
        });
        await expect(readState(root)).rejects.not.toThrow("private-value");
        expect(await contents(root, ".crafleet/state.json")).toBe(text);
    });

    it("checks managed path containment without resolving outside targets", async () => {
        const root = await directory();
        expect(io.containedPath(root, "sub/file")).toBe(
            path.join(root, "sub/file"),
        );
        expect(io.containedPath(root, ".")).toBe(root);
        expect(() => io.containedPath(root, "../outside")).toThrow(
            CrafleetError,
        );
        await expect(
            io.assertNoSymlinks(root, "../outside"),
        ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    });
});
