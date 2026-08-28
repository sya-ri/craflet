import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactStore,
    type LockedArtifact,
    parseSource,
} from "@craflet/core";
import { NodeDeploymentManager } from "../../packages/adapters/src/filesystem/deployment.js";
import {
    type BackupBatch,
    createGroupBackupService,
} from "../../packages/adapters/src/filesystem/groups.js";
import { installProjects } from "../../packages/adapters/src/filesystem/installations.js";
import { writeJson } from "../../packages/adapters/src/filesystem/io.js";
import {
    initProject,
    initWorkspace,
    loadProject,
    type ProjectContext,
    writeYaml,
} from "../../packages/adapters/src/filesystem/projects.js";
import { artifactZip } from "./artifacts-fixture.js";
import {
    backupTestDirectory,
    FixtureRestic,
    TEST_REPOSITORY_ID,
    writeBackupTestFile,
} from "./backup-fixtures.js";

type FixtureProject = ProjectContext & {
    manifest: ProjectContext["manifest"] & {
        id: string;
        backup: NonNullable<ProjectContext["manifest"]["backup"]>;
    };
};

export function requireGroupFixture<T>(value: T | undefined | null): T {
    if (value === undefined || value === null)
        throw new Error("A required group test fixture value is missing");
    return value;
}

export async function backupGroupFixture() {
    const root = await backupTestDirectory();
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    const repository = path.join(root, "repository");
    await mkdir(repository);
    const passwordFile = await writeBackupTestFile(
        home,
        "password",
        "disposable-group-password",
    );
    await writeJson(path.join(home, "repositories.json"), {
        local: {
            path: repository,
            id: TEST_REPOSITORY_ID,
            password: { file: passwordFile },
        },
    });
    await initWorkspace(workspace, ["servers/*"]);
    await writeBackupTestFile(
        workspace,
        "shared/players.dat",
        "shared player original",
    );
    const projects: FixtureProject[] = [];
    for (const name of ["alpha", "beta"]) {
        const dir = path.join(workspace, "servers", name);
        const manifest = await initProject(dir, {
            name,
            kind: "paper",
            version: "26.1",
            build: "1",
        });
        manifest.backup = {
            group: "network",
            repository: "local",
            files: ["runtime/**", "../../shared/**", "!**/*.[jJ][aA][rR]"],
            retention: { keepLast: 2 },
        };
        await writeYaml(path.join(dir, "craflet.yaml"), manifest);
        await writeBackupTestFile(
            dir,
            "runtime/world/players.dat",
            `${name} original`,
        );
        const loaded = await loadProject(dir, home);
        if (!loaded.manifest.id || !loaded.manifest.backup)
            throw new Error("Incomplete group fixture manifest");
        projects.push({
            ...loaded,
            manifest: {
                ...loaded.manifest,
                id: loaded.manifest.id,
                backup: loaded.manifest.backup,
            },
        });
    }
    const [alpha, beta] = projects;
    if (!alpha || !beta) throw new Error("Group fixture requires two projects");
    const members: [FixtureProject, FixtureProject] = [alpha, beta];
    const blobs = new Map<string, string>();
    const store: ArtifactStore = {
        async resolve(input): Promise<LockedArtifact> {
            const source = parseSource(input);
            if (source.provider !== "paper")
                throw new Error(
                    "Group fixture supports only Paper server artifacts",
                );
            if (source.build === "latest") source.build = "1";
            const bytes = artifactZip([
                {
                    name: "META-INF/MANIFEST.MF",
                    content: `Manifest-Version: 1.0\nImplementation-Version: ${source.build}\n`,
                },
            ]);
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const file = await writeBackupTestFile(
                root,
                `artifacts/${sha256}.jar`,
                bytes,
            );
            blobs.set(sha256, file);
            return {
                source,
                version: source.version,
                size: bytes.length,
                sha256,
            };
        },
        async ensure(artifact) {
            const file = blobs.get(artifact.sha256);
            if (!file) throw new Error("Fixture artifact is not cached");
            return file;
        },
        async inspect() {
            throw new Error("No fixture plugins are used");
        },
        async latest(input) {
            return parseSource(input);
        },
    };
    await installProjects(projects, store);
    for (const project of projects)
        await new NodeDeploymentManager(project, store).applyPrepared();
    const engine = new FixtureRestic();
    async function makeBackup() {
        const backup = await createGroupBackupService(
            "network",
            projects,
            undefined,
            {
                runner: engine.runner,
                bootstrap: {
                    prepare: async () => ({
                        path: "fixture-restic",
                        version: "0.19.1",
                    }),
                },
            },
        );
        if (!backup) throw new Error("Missing group fixture backup");
        return backup;
    }
    const backup = await makeBackup();
    const batch = {
        group: "network",
        projects: members,
        backup,
    } satisfies BackupBatch;
    async function stageNext() {
        for (const project of projects) {
            project.manifest.server.build = "2";
            await writeYaml(
                path.join(project.dir, "craflet.yaml"),
                project.manifest,
            );
            Object.assign(
                project,
                await loadProject(project.dir, project.home),
            );
        }
        await installProjects(projects, store, { updateServer: true });
    }
    return {
        root,
        workspace,
        home,
        repository,
        projects: members,
        store,
        engine,
        backup,
        batch,
        makeBackup,
        stageNext,
    };
}
