import { homedir } from "node:os";
import path from "node:path";
import {
    type BackupRepository,
    CrafleetError,
    SecretSchema,
    validateBackupIdentifier,
} from "@crafleet/core";
import { type } from "arktype";
import { NodeBackupService } from "../restic/backup-service.js";
import {
    assertNoSymlinks,
    exists,
    readJson,
    withMutex,
    writeJson,
} from "./io.js";
import { ensurePrivateDirectory } from "./private.js";
import { loadProject, type ProjectContext, writeYaml } from "./projects.js";

const RepositoriesSchema = type({
    "[string]": {
        "+": "reject",
        path: "string > 0",
        password: SecretSchema,
        "id?": "string > 0",
    },
});

function sameRepository(
    first: BackupRepository,
    second: BackupRepository,
): boolean {
    return (
        path.resolve(first.path) === path.resolve(second.path) &&
        JSON.stringify(first.password) === JSON.stringify(second.password)
    );
}

export function crafleetHome(): string {
    return path.resolve(
        process.env.CRAFLEET_HOME || path.join(homedir(), ".crafleet"),
    );
}
export async function readRepositories(
    home: string,
): Promise<Record<string, BackupRepository>> {
    const file = path.join(home, "repositories.json");
    await assertNoSymlinks(home, "repositories.json");
    if (!(await exists(file))) return {};
    try {
        const input = await readJson<unknown>(file);
        if (input === null || typeof input !== "object" || Array.isArray(input))
            throw new Error("Invalid registry");
        const result = RepositoriesSchema(input);
        if (result instanceof type.errors) throw new Error("Invalid registry");
        for (const alias of Object.keys(result))
            validateBackupIdentifier(alias, "repository");
        return result;
    } catch {
        throw new CrafleetError(
            "REPOSITORIES_INVALID",
            "Invalid host repository registry; values are omitted.",
            2,
        );
    }
}
export async function backupService(
    project: ProjectContext,
    alias?: string,
): Promise<NodeBackupService | undefined> {
    const repository = alias ?? project.manifest.backup?.repository;
    if (!repository) return undefined;
    return new NodeBackupService(project.dir, project.home, {
        ...project.manifest.backup,
        repository,
        repositories: await readRepositories(project.home),
        files: project.manifest.backup?.files ?? [],
        ...(project.manifest.id ? { projectId: project.manifest.id } : {}),
    });
}
export async function setupBackup(
    project: ProjectContext,
    alias: string,
    repository: BackupRepository,
    options: {
        initialize?: boolean;
        confirm?: boolean;
        dryRun?: boolean;
        offline?: boolean;
    } = {},
): Promise<unknown> {
    validateBackupIdentifier(alias, "repository");
    if (!path.isAbsolute(repository.path))
        throw new CrafleetError(
            "BACKUP_ABSOLUTE",
            "Backup destinations must be absolute paths.",
            2,
        );
    if (options.dryRun) {
        const repositories = await readRepositories(project.home);
        const old = repositories[alias];
        if (old && !sameRepository(old, repository))
            throw new CrafleetError(
                "REPOSITORY_EXISTS",
                "Repository alias already identifies another destination or password reference.",
                3,
            );
        return {
            alias,
            path: path.resolve(repository.path),
            initialize: Boolean(options.initialize),
        };
    }
    await ensurePrivateDirectory(project.home);
    return withMutex(path.join(project.home, "repositories.lock"), () =>
        withMutex(
            path.join(project.lockRoot, ".crafleet/operation.lock"),
            async () => {
                const repositories = await readRepositories(project.home);
                const old = repositories[alias];
                if (old && !sameRepository(old, repository))
                    throw new CrafleetError(
                        "REPOSITORY_EXISTS",
                        "Repository alias already points to a different destination or password reference. Choose another alias.",
                        3,
                    );
                const candidate = {
                    ...repository,
                    ...(old?.id ? { id: old.id } : {}),
                };
                const service = new NodeBackupService(
                    project.dir,
                    project.home,
                    {
                        ...project.manifest.backup,
                        repository: alias,
                        repositories: { ...repositories, [alias]: candidate },
                        files: project.manifest.backup?.files ?? [],
                        ...(project.manifest.id
                            ? { projectId: project.manifest.id }
                            : {}),
                    },
                );
                await service.prepare({ offline: options.offline ?? false });
                const result = await service.setup(alias, {
                    initialize: options.initialize ?? false,
                    confirm: options.confirm ?? false,
                });
                await writeJson(path.join(project.home, "repositories.json"), {
                    ...repositories,
                    [alias]: { ...candidate, path: result.path, id: result.id },
                });
                const latest = await loadProject(project.dir, project.home);
                await writeYaml(path.join(project.dir, "crafleet.yaml"), {
                    ...latest.manifest,
                    backup: {
                        ...latest.manifest.backup,
                        files: latest.manifest.backup?.files ?? [],
                        repository: alias,
                    },
                });
                return result;
            },
        ),
    );
}
