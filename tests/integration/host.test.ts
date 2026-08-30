import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeArtifactStore } from "../../packages/adapters/src/filesystem/artifact-store.js";
import { NodeConfigManager } from "../../packages/adapters/src/filesystem/config.js";
import { diagnoseProject } from "../../packages/adapters/src/filesystem/doctor.js";
import {
    backupService,
    crafleetHome,
    readRepositories,
    setupBackup,
} from "../../packages/adapters/src/filesystem/host.js";
import { installProjects } from "../../packages/adapters/src/filesystem/installations.js";
import {
    initProject,
    loadProject,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import {
    readState,
    saveState,
} from "../../packages/adapters/src/filesystem/state.js";
import { NodeBackupService } from "../../packages/adapters/src/restic/backup-service.js";
import * as java from "../../packages/adapters/src/runtime/java.js";
import { artifactZip } from "./artifacts-fixture.js";

let root: string;
const temporaryParent = await realpath(tmpdir());
let project: string;
let home: string;
let repository: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(temporaryParent, "crafleet-host-"));
    project = path.join(root, "project");
    home = path.join(root, "home");
    repository = path.join(root, "repository");
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
    await initProject(project, {
        name: "host",
        kind: "velocity",
        version: "4.1.1",
        source: `file:${source}`,
    });
    vi.spyOn(java, "inspectJava").mockResolvedValue({
        major: 25,
        diagnostics: [
            {
                id: "java.version",
                status: "pass",
                message: "Java 25 (bounded probe fixture)",
            },
        ],
    });
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (
        path.dirname(root) !== temporaryParent ||
        !path.basename(root).startsWith("crafleet-host-")
    )
        throw new Error("Unsafe cleanup target");
    await rm(root, { recursive: true, force: true });
});
async function registry(value: unknown) {
    await mkdir(home, { recursive: true });
    await writeFile(
        path.join(home, "repositories.json"),
        JSON.stringify(value),
    );
}
function fakeRepositoryTool() {
    const prepare = vi
        .spyOn(NodeBackupService.prototype, "prepare")
        .mockResolvedValue({ path: "unused-restic", version: "test" });
    const setup = vi
        .spyOn(NodeBackupService.prototype, "setup")
        .mockImplementation(async (alias) => ({
            alias,
            path: repository,
            id: "a".repeat(64),
        }));
    return { prepare, setup };
}
describe("host repository registration", () => {
    it("uses the test home override without changing the user profile", async () => {
        vi.stubEnv("CRAFLEET_HOME", home);
        expect(crafleetHome()).toBe(home);
        expect(await readRepositories(home)).toEqual({});
        expect(
            await backupService(await loadProject(project, home)),
        ).toBeUndefined();
    });
    it("uses the Crafleet directory under the user profile by default", () => {
        vi.stubEnv("CRAFLEET_HOME", "");
        expect(crafleetHome()).toBe(path.resolve(homedir(), ".crafleet"));
    });

    it.each(
        [
            null,
            [],
            { main: { path: "x", password: "plaintext-secret" } },
            { constructor: { path: "x", password: { env: "PW" } } },
        ].map((value) => ({ value })),
    )("redacts invalid registry input", async ({ value }) => {
        await registry(value);
        await expect(readRepositories(home)).rejects.toMatchObject({
            code: "REPOSITORIES_INVALID",
        });
    });
    it("turns JSON parser errors into a safe diagnostic", async () => {
        await mkdir(home);
        await writeFile(
            path.join(home, "repositories.json"),
            '{"plaintext-secret":',
        );
        await expect(readRepositories(home)).rejects.toMatchObject({
            code: "REPOSITORIES_INVALID",
            message: "Invalid host repository registry; values are omitted.",
        });
    });
    it("records only a verified repository identity and secret reference, preserving rules and concurrent authored fields", async () => {
        const tools = fakeRepositoryTool();
        const context = await loadProject(project, home);
        tools.setup.mockImplementation(async (alias) => {
            await writeYaml(path.join(project, "crafleet.yaml"), {
                ...context.manifest,
                java: { args: ["-Xmx3G"] },
            });
            return { alias, path: repository, id: "a".repeat(64) };
        });
        await setupBackup(
            context,
            "main",
            { path: repository, password: { env: "BACKUP_PASSWORD" } },
            { initialize: true, confirm: true, offline: true },
        );
        expect(tools.prepare).toHaveBeenCalledWith({ offline: true });
        expect(tools.setup).toHaveBeenCalledWith("main", {
            initialize: true,
            confirm: true,
        });
        expect((await readRepositories(home)).main).toEqual({
            path: repository,
            password: { env: "BACKUP_PASSWORD" },
            id: "a".repeat(64),
        });
        const saved = (await loadProject(project, home)).manifest;
        expect(saved.java?.args).toEqual(["-Xmx3G"]);
        expect(saved.backup?.files).toEqual(context.manifest.backup?.files);
        expect(
            (await backupService(await loadProject(project, home)))?.config
                .repository,
        ).toBe("main");
        await setupBackup(await loadProject(project, home), "main", {
            path: repository,
            password: { env: "BACKUP_PASSWORD" },
        });
        expect((await readRepositories(home)).main?.id).toBe("a".repeat(64));
    });
    it.each([true, false])(
        "never rebinds an existing alias to a different destination (preview=%s)",
        async (dryRun) => {
            const tools = fakeRepositoryTool();
            await registry({
                main: {
                    path: repository,
                    id: "a".repeat(64),
                    password: { env: "PW" },
                },
            });
            await expect(
                setupBackup(
                    await loadProject(project, home),
                    "main",
                    {
                        path: path.join(root, "different"),
                        password: { env: "PW" },
                    },
                    { dryRun },
                ),
            ).rejects.toMatchObject({ code: "REPOSITORY_EXISTS" });
            expect(tools.prepare).not.toHaveBeenCalled();
            expect((await readRepositories(home)).main?.path).toBe(repository);
        },
    );
    it("refuses concurrent registration and never writes a partial manifest on tool failure", async () => {
        const tools = fakeRepositoryTool();
        const context = await loadProject(project, home);
        const before = await readFile(
            path.join(project, "crafleet.yaml"),
            "utf8",
        );
        await mkdir(path.join(home, "repositories.lock"), { recursive: true });
        await expect(
            setupBackup(context, "main", {
                path: repository,
                password: { env: "PW" },
            }),
        ).rejects.toMatchObject({ code: "BUSY" });
        await rm(path.join(home, "repositories.lock"), { recursive: true });
        tools.setup.mockRejectedValue(new Error("repository failure"));
        await expect(
            setupBackup(context, "main", {
                path: repository,
                password: { env: "PW" },
            }),
        ).rejects.toThrow("repository failure");
        expect(await readRepositories(home)).toEqual({});
        expect(
            await readFile(path.join(project, "crafleet.yaml"), "utf8"),
        ).toBe(before);
    });
    it("rejects unsafe alias or relative destination before touching registry", async () => {
        const context = await loadProject(project, home);
        await expect(
            setupBackup(context, "../escape", {
                path: repository,
                password: { env: "PW" },
            }),
        ).rejects.toThrow();
        await expect(
            setupBackup(
                context,
                "main",
                { path: "relative", password: { env: "PW" } },
                { dryRun: true },
            ),
        ).rejects.toMatchObject({ code: "BACKUP_ABSOLUTE" });
    });
});

describe("read-only doctor", () => {
    const item = async (id: string) =>
        (await diagnoseProject(project, home)).find((entry) => entry.id === id);
    it("reports lock, config, process and backup prerequisites without creating private state", async () => {
        const results = await diagnoseProject(project, home);
        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: "project.manifest",
                    status: "pass",
                }),
                expect.objectContaining({ id: "project.lock", status: "warn" }),
                expect.objectContaining({
                    id: "config.syntax",
                    status: "pass",
                }),
                expect.objectContaining({
                    id: "config.plugin-semantics",
                    status: "unknown",
                }),
                expect.objectContaining({
                    id: "runtime.identity",
                    status: "pass",
                }),
                expect.objectContaining({
                    id: "backup.repository",
                    status: "warn",
                }),
            ]),
        );
        await expect(
            readFile(path.join(project, ".crafleet/state.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("detects missing, matched and changed active JARs by streaming their actual bytes", async () => {
        const context = await loadProject(project, home);
        const store = new NodeArtifactStore(home);
        await installProjects([context], store, {});
        expect(await item("deployment.pending")).toMatchObject({
            status: "warn",
        });
        expect(await item("project.lock")).toMatchObject({ status: "pass" });
        const active = (await readState(project)).pending;
        if (!active) throw new Error("Fixture missing");
        await saveState(project, { schemaVersion: 1, active });
        expect(await item("jar.server.jar")).toMatchObject({ status: "fail" });
        await copyFile(
            path.join(root, "server.jar"),
            path.join(project, "runtime/server.jar"),
        );
        expect(await item("jar.server.jar")).toMatchObject({ status: "pass" });
        await writeFile(path.join(project, "runtime/server.jar"), "tampered");
        expect(await item("jar.server.jar")).toMatchObject({ status: "fail" });
    });
    it("reports config drift, conflicts and syntax failure without exposing values", async () => {
        const file = path.join(project, "runtime/server.properties");
        await writeFile(file, "motd=initial\n");
        const config = new NodeConfigManager(project);
        await config.capture({ initial: true, kind: "paper" });
        await writeFile(file, "motd=runtime\n");
        expect(await item("config.drift")).toMatchObject({ status: "warn" });
        await writeFile(
            path.join(project, "config/server.properties"),
            "motd=base\n",
        );
        expect(await item("config.conflicts")).toMatchObject({
            status: "fail",
        });
        await writeFile(
            path.join(project, "config/malformed.json"),
            '{"secret": invalid}',
        );
        const result = await diagnoseProject(project, home);
        expect(result).toContainEqual(
            expect.objectContaining({
                id: "config.validation",
                status: "fail",
            }),
        );
        expect(JSON.stringify(result)).not.toContain("invalid}");
    });
    it.each([
        "deploy.json",
        "restore.json",
        "group-operation.json",
        "group-restore.json",
        "manifest-transaction.json",
        "import-incomplete.json",
    ])("detects interrupted %s", async (name) => {
        await mkdir(path.join(project, ".crafleet"));
        await writeFile(path.join(project, ".crafleet", name), "{}");
        expect(await item("deployment.recovery")).toMatchObject({
            status: "fail",
        });
    });
    it("identifies malformed lock and state independently", async () => {
        await writeFile(
            path.join(project, "crafleet-lock.yaml"),
            "invalid: true",
        );
        await mkdir(path.join(project, ".crafleet"));
        await writeFile(path.join(project, ".crafleet/state.json"), "{");
        expect(await item("project.lock")).toMatchObject({ status: "fail" });
        expect(await item("deployment.state")).toMatchObject({
            status: "fail",
        });
    });
    it("does not mistake a missing NAS, unregistered alias or plain file for a repository", async () => {
        const context = await loadProject(project, home);
        await writeYaml(path.join(project, "crafleet.yaml"), {
            ...context.manifest,
            backup: { ...context.manifest.backup, repository: "main" },
        });
        expect(await item("backup.repository")).toMatchObject({
            status: "fail",
        });
        await registry({
            main: {
                path: repository,
                id: "a".repeat(64),
                password: { env: "PW" },
            },
        });
        expect(await item("backup.repository")).toMatchObject({
            status: "fail",
        });
        await writeFile(repository, "not a repository directory");
        expect(await item("backup.repository")).toMatchObject({
            status: "fail",
        });
        await rm(repository);
        await mkdir(repository);
        expect(await item("backup.repository")).toMatchObject({
            status: "pass",
        });
        expect(await item("backup.restore-readiness")).toMatchObject({
            status: "unknown",
        });
        await registry({ main: { password: "secret" } });
        expect(await item("backup.repository")).toMatchObject({
            status: "fail",
        });
    });
});
