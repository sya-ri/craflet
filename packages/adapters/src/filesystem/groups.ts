import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactStore,
    assertStopped,
    type BackupConfig,
    type BackupPlan,
    type BackupRoot,
    CrafletError,
    coldGroupBackup,
    type DatabaseBackupConfig,
    DEFAULT_BACKUP_FILES,
    type GroupBackupMember,
    stableStringify,
    validateBackupIdentifier,
} from "@craflet/core";
import { type } from "arktype";
import {
    type NodeBackupDependencies,
    NodeBackupService,
} from "../restic/backup-service.js";
import { pathsOverlap } from "./backup-files.js";
import { NodeDeploymentManager } from "./deployment.js";
import {
    createOwnedEulaOperationJournal,
    type OwnedEulaOperationJournal,
} from "./eula.js";
import type { RequestEulaConsent } from "./eula-consent.js";
import { backupService, readRepositories } from "./host.js";
import {
    assertNoSymlinks,
    exists,
    readJson,
    withMutex,
    writeJson,
} from "./io.js";
import { ensurePrivateDirectory } from "./private.js";
import {
    loadProject,
    type ProjectContext,
    workspaceProjects,
} from "./projects.js";
import { type Installation, readState } from "./state.js";

const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 32);
export const runtimeRootId = (project: ProjectContext) =>
    `server-${project.manifest.id ?? digest(project.lockKey)}`;
export const projectBackupId = (project: ProjectContext) =>
    project.manifest.id ?? digest(path.resolve(project.dir));

function pathKey(value: string): string {
    const absolute = path.resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function contains(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return (
        relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
    );
}

export function validateRecoveryGroup(
    group: string,
    projects: readonly ProjectContext[],
): ProjectContext {
    validateBackupIdentifier(group, "Recovery group");
    const first = projects[0];
    if (!first)
        throw new CrafletError(
            "EMPTY_SELECTION",
            "The recovery group is empty.",
            2,
        );
    const keys = new Set<string>();
    const directories = new Set<string>();
    const identities = new Set<string>();
    for (const project of projects) {
        if (
            pathKey(project.lockRoot) !== pathKey(first.lockRoot) ||
            pathKey(project.home) !== pathKey(first.home) ||
            project.manifest.backup?.group !== group
        )
            throw new CrafletError(
                "BACKUP_GROUP_MEMBERSHIP",
                "A recovery group must contain members of the same declared group, workspace, and Craflet home.",
                3,
            );
        if (
            keys.has(project.lockKey) ||
            directories.has(pathKey(project.dir)) ||
            identities.has(runtimeRootId(project))
        )
            throw new CrafletError(
                "BACKUP_GROUP_MEMBERSHIP",
                "Recovery group members must have distinct project paths and persistent IDs.",
                3,
            );
        keys.add(project.lockKey);
        directories.add(pathKey(project.dir));
        identities.add(runtimeRootId(project));
    }
    return first;
}
function databaseIdentity(
    project: ProjectContext,
    config: DatabaseBackupConfig,
): string {
    return config.kind === "sqlite"
        ? `sqlite:${pathKey(path.resolve(project.dir, config.path))}`
        : `sql:${config.host.toLowerCase()}:${config.port ?? 3306}/${config.database}`;
}
function absoluteDatabase(
    project: ProjectContext,
    config: DatabaseBackupConfig,
): DatabaseBackupConfig {
    if (config.kind === "sqlite")
        return { ...config, path: path.resolve(project.dir, config.path) };
    const executable = (command: string) =>
        /[\\/]/u.test(command) ? path.resolve(project.dir, command) : command;
    return {
        ...config,
        password:
            "file" in config.password
                ? { file: path.resolve(project.dir, config.password.file) }
                : config.password,
        ...(config.sslCa
            ? { sslCa: path.resolve(project.dir, config.sslCa) }
            : {}),
        ...(config.command ? { command: executable(config.command) } : {}),
        ...(config.restoreCommand
            ? { restoreCommand: executable(config.restoreCommand) }
            : {}),
    };
}

export interface BackupBatch {
    group?: string;
    projects: ProjectContext[];
    backup?: NodeBackupService;
}

export type GroupBackupActive = {
    group: {
        name: string;
        members: {
            key: string;
            projectId: string;
            name: string;
            runtimeRootId: string;
            installation: Installation | null;
        }[];
    };
};
export async function collectGroupBackupMetadata(
    group: string,
    projects: ProjectContext[],
    expected?: ReadonlyMap<string, string | null>,
): Promise<GroupBackupActive> {
    validateRecoveryGroup(group, projects);
    const members = await Promise.all(
        projects.map(async (project) => {
            const installation = (await readState(project.dir)).active ?? null;
            if (
                expected &&
                expected.get(project.lockKey) !== (installation?.id ?? null)
            )
                throw new CrafletError(
                    "BACKUP_GROUP_STATE_CHANGED",
                    "A group member's active installation changed during the operation.",
                    4,
                );
            return {
                key: project.lockKey,
                projectId: projectBackupId(project),
                name: project.manifest.name,
                runtimeRootId: runtimeRootId(project),
                installation,
            };
        }),
    );
    return { group: { name: group, members } };
}

export async function assertCleanRecoveryGroup(
    projects: readonly ProjectContext[],
): Promise<void> {
    const first = projects[0];
    if (!first)
        throw new CrafletError(
            "EMPTY_SELECTION",
            "The recovery group is empty.",
            2,
        );
    const journals = [
        path.join(first.lockRoot, ".craflet/group-operation.json"),
        path.join(first.lockRoot, ".craflet/group-restore.json"),
        path.join(first.lockRoot, ".craflet/manifest-transaction.json"),
        ...projects.flatMap((project) =>
            ["deploy.json", "restore.json", "import-incomplete.json"].map(
                (name) => path.join(project.dir, ".craflet", name),
            ),
        ),
    ];
    for (const file of journals) {
        await assertNoSymlinks(file);
        if (await exists(file))
            throw new CrafletError(
                "RECOVERY_REQUIRED",
                "Recover the interrupted member or group operation first.",
                4,
            );
    }
}
export async function resolveBackupBatches(
    projects: ProjectContext[],
    options: { complete?: boolean; repository?: string } = {},
): Promise<BackupBatch[]> {
    const first = projects[0];
    if (
        !first ||
        projects.some((project) => project.lockRoot !== first.lockRoot)
    )
        throw new CrafletError(
            "WORKSPACE_ROOT",
            "Select projects from one workspace.",
            2,
        );
    const directories = await workspaceProjects(first.lockRoot);
    const discovered = directories.length
        ? await Promise.all(
              directories.map((directory) =>
                  loadProject(directory, first.home),
              ),
          )
        : [];
    const all = [
        ...new Map(
            [...projects, ...discovered].map((project) => [
                pathKey(project.dir),
                project,
            ]),
        ).values(),
    ];
    const writers = new Map<string, ProjectContext[]>();
    for (const project of all)
        for (const database of project.manifest.backup?.databases ?? []) {
            const key = databaseIdentity(project, database);
            const members = writers.get(key) ?? [];
            if (
                !members.some(
                    (member) => pathKey(member.dir) === pathKey(project.dir),
                )
            )
                members.push(project);
            writers.set(key, members);
        }
    for (const members of writers.values())
        if (
            members.length > 1 &&
            (!members[0]?.manifest.backup?.group ||
                members.some(
                    (member) =>
                        member.manifest.backup?.group !==
                        members[0]?.manifest.backup?.group,
                ))
        )
            throw new CrafletError(
                "BACKUP_GROUP_REQUIRED",
                "Projects sharing a configured database must declare the same backup.group.",
                3,
            );
    const selected = new Set(projects.map((project) => pathKey(project.dir)));
    const visited = new Set<string>();
    const batches: BackupBatch[] = [];
    for (const project of projects) {
        if (visited.has(pathKey(project.dir))) continue;
        const group = project.manifest.backup?.group;
        if (!group) {
            visited.add(pathKey(project.dir));
            const backup = await backupService(project, options.repository);
            batches.push({
                projects: [project],
                ...(backup ? { backup } : {}),
            });
            continue;
        }
        validateBackupIdentifier(group, "Recovery group");
        const members = all
            .filter((member) => member.manifest.backup?.group === group)
            .sort((a, b) => a.lockKey.localeCompare(b.lockKey, "en"));
        if (
            options.complete &&
            members.some((member) => !selected.has(pathKey(member.dir)))
        )
            throw new CrafletError(
                "BACKUP_GROUP_PARTIAL",
                `Recovery group ${group} must be selected in full. Use -r or filters that select every member.`,
                3,
            );
        for (const member of members) visited.add(pathKey(member.dir));
        const backup = await createGroupBackupService(
            group,
            members,
            options.repository,
        );
        batches.push({
            group,
            projects: members,
            ...(backup ? { backup } : {}),
        });
    }
    return batches;
}

export async function createGroupBackupService(
    group: string,
    projects: ProjectContext[],
    override?: string,
    dependencies: NodeBackupDependencies = {},
): Promise<NodeBackupService | undefined> {
    const first = validateRecoveryGroup(group, projects);
    const repository = override ?? first.manifest.backup?.repository;
    if (!repository) return undefined;
    if (
        !override &&
        projects.some(
            (project) => project.manifest.backup?.repository !== repository,
        )
    )
        throw new CrafletError(
            "BACKUP_GROUP_REPOSITORY",
            "Every recovery group member must use the same repository alias.",
            3,
        );
    const repositories = await readRepositories(first.home);
    const databases = new Map<string, DatabaseBackupConfig>();
    const identities = new Map<string, string>();
    for (const project of projects)
        for (const database of project.manifest.backup?.databases ?? []) {
            validateBackupIdentifier(database.id, "Database backup ID");
            const identity = databaseIdentity(project, database);
            const config = absoluteDatabase(project, database);
            if (
                identities.has(identity) &&
                identities.get(identity) !== database.id
            )
                throw new CrafletError(
                    "BACKUP_GROUP_DATABASE",
                    "Use the same backup database ID for every reference to a shared database.",
                    3,
                );
            if (
                databases.has(database.id) &&
                stableStringify(databases.get(database.id)) !==
                    stableStringify(config)
            )
                throw new CrafletError(
                    "BACKUP_GROUP_DATABASE",
                    "A group database ID maps to different database settings.",
                    3,
                );
            identities.set(identity, database.id);
            databases.set(database.id, config);
        }
    const retention = first.manifest.backup?.retention;
    if (
        projects.some(
            (project) =>
                stableStringify(project.manifest.backup?.retention) !==
                stableStringify(retention),
        )
    )
        throw new CrafletError(
            "BACKUP_GROUP_RETENTION",
            "Every recovery group member must use the same retention policy.",
            3,
        );
    const config: BackupConfig = {
        repository,
        repositories,
        group,
        projectId: digest(
            `craflet-group-v1:${group}:${projects
                .map((project) => project.manifest.id ?? project.lockKey)
                .sort()
                .join(",")}`,
        ),
        files: [],
        databases: [...databases.values()],
        ...(retention ? { retention } : {}),
    };
    const services = projects.map(
        (project) =>
            new NodeBackupService(project.dir, project.home, {
                ...project.manifest.backup,
                repository,
                repositories,
                files: project.manifest.backup?.files ?? [
                    ...DEFAULT_BACKUP_FILES,
                ],
            }),
    );
    return new NodeBackupService(first.dir, first.home, config, undefined, {
        ...dependencies,
        planFiles: async () => {
            const roots = new Map<string, BackupRoot>();
            const files: BackupPlan["files"] = [];
            const sources = new Set<string>();
            const warnings: string[] = [];
            const forbidden = projects.flatMap((project) => [
                path.join(project.dir, ".craflet"),
                path.join(project.dir, ".git"),
            ]);
            const plans = await Promise.all(
                services.map((service) => service.plan()),
            );
            const runtimeRoots: BackupRoot[] = [];
            const additionalRoots = new Map<string, BackupRoot>();
            for (const [index, plan] of plans.entries()) {
                const project = projects[index];
                if (!project) throw new Error("Missing group member");
                for (const root of plan.roots) {
                    if (forbidden.some((file) => pathsOverlap(root.path, file)))
                        throw new CrafletError(
                            "BACKUP_SELF_INCLUSION",
                            "A group root overlaps a member's private state or Git directory.",
                            3,
                        );
                    const id = root.external
                        ? `data-${digest(root.path)}`
                        : runtimeRootId(project);
                    const mapped = { ...root, id, external: true };
                    if (root.external)
                        additionalRoots.set(pathKey(root.path), mapped);
                    else runtimeRoots.push(mapped);
                }
            }
            for (const root of runtimeRoots) roots.set(root.id, root);
            const candidates = [...additionalRoots.values()].filter(
                (root) =>
                    !runtimeRoots.some((runtime) =>
                        contains(runtime.path, root.path),
                    ),
            );
            const additional = candidates.filter(
                (root) =>
                    !candidates.some(
                        (parent) =>
                            parent !== root &&
                            parent.kind === "directory" &&
                            contains(parent.path, root.path),
                    ),
            );
            for (const root of additional) roots.set(root.id, root);
            for (const [index, plan] of plans.entries()) {
                const project = projects[index];
                if (!project) throw new Error("Missing group member");
                for (const file of plan.files) {
                    if (sources.has(pathKey(file.source))) continue;
                    sources.add(pathKey(file.source));
                    const root =
                        runtimeRoots.find((candidate) =>
                            contains(candidate.path, file.source),
                        ) ??
                        additional.find((candidate) =>
                            candidate.kind === "file"
                                ? pathKey(candidate.path) ===
                                  pathKey(file.source)
                                : contains(candidate.path, file.source),
                        );
                    if (!root)
                        throw new CrafletError(
                            "BACKUP_ROOT",
                            "A selected group file has no declared root.",
                            3,
                        );
                    const suffix =
                        root.kind === "file"
                            ? path.basename(file.source)
                            : path
                                  .relative(root.path, file.source)
                                  .replaceAll(path.sep, "/");
                    files.push({
                        ...file,
                        rootId: root.id,
                        destination: `data/external/${root.id}/${suffix}`,
                    });
                }
                warnings.push(
                    ...plan.warnings.map(
                        (warning) => `${project.manifest.name}: ${warning}`,
                    ),
                );
            }
            const bytes = files.reduce((total, file) => total + file.size, 0);
            if (!Number.isSafeInteger(bytes))
                throw new CrafletError(
                    "BACKUP_FILE_SIZE",
                    "The selected group backup exceeds the supported size range.",
                    3,
                );
            return {
                roots: [...roots.values()],
                files: files.sort((a, b) =>
                    a.destination.localeCompare(b.destination, "en"),
                ),
                bytes,
                stagingBytes: bytes,
                databaseIds: [...databases.keys()],
                warnings,
            };
        },
    });
}

const GroupJournalSchema = type({
    "+": "reject",
    schemaVersion: "1",
    group: "string > 0",
    phase: "'applying' | 'applied' | 'spawned'",
    members: type({
        "+": "reject",
        key: "string",
        activeId: "string | null",
        nextId: "string | null",
    }).array(),
    "backupId?": "string",
});

export class NodeRecoveryGroup {
    readonly managers: NodeDeploymentManager[];
    private readonly root: string;
    private readonly groupName: string;
    constructor(
        readonly batch: BackupBatch,
        readonly store: ArtifactStore,
        readonly runnerEntry?: string,
        readonly options: {
            offline?: boolean;
            signal?: AbortSignal;
            requestEulaConsent?: RequestEulaConsent;
        } = {},
    ) {
        if (!batch.group || !batch.projects[0])
            throw new CrafletError(
                "BACKUP_GROUP",
                "Expected a complete recovery group.",
                2,
            );
        this.root = validateRecoveryGroup(batch.group, batch.projects).lockRoot;
        this.groupName = batch.group;
        this.managers = batch.projects.map(
            (project) =>
                new NodeDeploymentManager(
                    project,
                    store,
                    batch.backup,
                    runnerEntry,
                    undefined,
                    options,
                ),
        );
    }
    private get journalFile(): string {
        return path.join(this.root, ".craflet/group-operation.json");
    }
    private backup(): NodeBackupService {
        if (!this.batch.backup)
            throw new CrafletError(
                "BACKUP_REQUIRED",
                "Configure a repository for every recovery group member.",
                3,
            );
        return this.batch.backup;
    }
    private async metadata(expected?: ReadonlyMap<string, string | null>) {
        return collectGroupBackupMetadata(
            this.groupName,
            this.batch.projects,
            expected,
        );
    }
    async createBackup(leaveStopped = false, dryRun = false): Promise<unknown> {
        const backup = this.backup();
        if (dryRun) return backup.plan();
        await ensurePrivateDirectory(path.join(this.root, ".craflet"));
        return withMutex(
            path.join(this.root, ".craflet/operation.lock"),
            async () => {
                await assertCleanRecoveryGroup(this.batch.projects);
                const fixed = new Map(
                    (await this.metadata()).group.members.map((member) => [
                        member.key,
                        member.installation?.id ?? null,
                    ]),
                );
                const members: GroupBackupMember[] = this.managers.map(
                    (manager) => ({
                        name: manager.context.lockKey,
                        status: () => manager.controller.status(),
                        stop: () => manager.controller.stop(),
                        startActive: async () => {
                            const activeId = fixed.get(manager.context.lockKey);
                            if (!activeId)
                                throw new CrafletError(
                                    "ACTIVE_MISSING",
                                    "The group member has no active installation.",
                                    3,
                                );
                            return manager.spawnActive(activeId);
                        },
                    }),
                );
                return coldGroupBackup(
                    members,
                    async () => {
                        await backup.prepare(this.options);
                        await backup.preflight(this.options);
                    },
                    async () =>
                        backup.create(await this.metadata(fixed), this.options),
                    leaveStopped,
                );
            },
        );
    }
    async operate(
        action: "start" | "restart" | "apply",
        activeOnly = false,
        dryRun = false,
    ): Promise<unknown> {
        if (dryRun)
            return Promise.all(this.managers.map((manager) => manager.plan()));
        await ensurePrivateDirectory(path.join(this.root, ".craflet"));
        return withMutex(
            path.join(this.root, ".craflet/operation.lock"),
            async () => {
                await assertCleanRecoveryGroup(this.batch.projects);
                const statuses = await Promise.all(
                    this.managers.map((manager) => manager.controller.status()),
                );
                const states = await Promise.all(
                    this.managers.map((manager) =>
                        readState(manager.context.dir),
                    ),
                );
                const pending =
                    !activeOnly && states.some((state) => state.pending);
                if (
                    action === "start" &&
                    statuses.every((status) => status.status === "running")
                )
                    return statuses.map((status, index) => ({
                        project:
                            this.managers[index]?.context.manifest.name ??
                            `Member ${index + 1}`,
                        status,
                    }));
                for (const status of statuses)
                    if (action === "apply" || status.status !== "running")
                        assertStopped(status.status);
                if (
                    action === "start" &&
                    pending &&
                    statuses.some((status) => status.status === "running")
                )
                    throw new CrafletError(
                        "GROUP_RESTART_REQUIRED",
                        "Use restart with the complete group to apply pending while any member is running.",
                        3,
                    );
                for (const [index, manager] of this.managers.entries())
                    await manager.preflight(
                        Boolean(!activeOnly && states[index]?.pending),
                        action !== "apply",
                    );
                const backup = pending ? this.backup() : undefined;
                if (backup) {
                    await backup.prepare(this.options);
                    await backup.preflight(this.options);
                }
                if (action === "restart")
                    for (const [index, manager] of this.managers.entries())
                        if (statuses[index]?.status === "running")
                            await manager.controller.stop();
                let ownedJournal: OwnedEulaOperationJournal | undefined;
                if (pending) {
                    for (const manager of this.managers)
                        assertStopped(
                            (await manager.controller.status()).status,
                        );
                    const saved = await backup?.create(
                        await this.metadata(),
                        this.options,
                    );
                    const journal = {
                        schemaVersion: 1 as const,
                        group: this.groupName,
                        phase: "applying" as const,
                        members: this.managers.map((manager, index) => ({
                            key: manager.context.lockKey,
                            activeId: states[index]?.active?.id ?? null,
                            nextId:
                                states[index]?.pending?.id ??
                                states[index]?.active?.id ??
                                null,
                        })),
                        ...(saved ? { backupId: saved.snapshotId } : {}),
                    };
                    await writeJson(
                        await assertNoSymlinks(this.journalFile),
                        journal,
                    );
                    for (const manager of this.managers)
                        await manager.applyPrepared();
                    const ready = {
                        ...journal,
                        phase: action === "apply" ? "applied" : "spawned",
                    } as const;
                    await writeJson(this.journalFile, ready);
                    if (action !== "apply") {
                        const content = `${JSON.stringify(ready, null, 4)}\n`;
                        ownedJournal = createOwnedEulaOperationJournal(
                            this.journalFile,
                            content,
                        );
                    }
                }
                const result = [];
                if (action !== "apply")
                    for (const manager of this.managers) {
                        const active = (await readState(manager.context.dir))
                            .active;
                        if (!active)
                            throw new CrafletError(
                                "ACTIVE_MISSING",
                                "The group member has no active installation.",
                                3,
                            );
                        result.push({
                            project: manager.context.manifest.name,
                            status: await manager.spawnActive(
                                active.id,
                                ownedJournal,
                            ),
                        });
                    }
                if (pending) await rm(this.journalFile);
                return result;
            },
        );
    }
    async recover(dryRun = false): Promise<boolean> {
        if (!(await exists(this.journalFile))) return false;
        const journal = GroupJournalSchema(
            await readJson<unknown>(
                await assertNoSymlinks(
                    this.root,
                    ".craflet/group-operation.json",
                ),
            ),
        );
        if (
            journal instanceof type.errors ||
            journal.group !== this.batch.group ||
            journal.members.length !== this.managers.length ||
            new Set(journal.members.map((member) => member.key)).size !==
                journal.members.length ||
            journal.members.some(
                (member) =>
                    !this.managers.some(
                        (manager) => manager.context.lockKey === member.key,
                    ),
            )
        )
            throw new CrafletError(
                "GROUP_JOURNAL",
                "The recovery group membership does not match the operation journal.",
                4,
            );
        for (const manager of this.managers)
            assertStopped((await manager.controller.status()).status);
        if (dryRun) return true;
        // Per-project recovery takes the same workspace lock itself.
        if (journal.phase === "applying")
            for (const manager of this.managers) await manager.recover();
        return withMutex(
            path.join(this.root, ".craflet/operation.lock"),
            async () => {
                if (journal.phase === "applying")
                    for (const manager of this.managers) {
                        const state = await readState(manager.context.dir);
                        const intended = journal.members.find(
                            (member) => member.key === manager.context.lockKey,
                        )?.nextId;
                        if (state.active?.id === intended) continue;
                        if (!state.pending || state.pending.id !== intended)
                            throw new CrafletError(
                                "GROUP_RECOVERY_CONFLICT",
                                "A group member changed after interruption; it was not overwritten.",
                                4,
                            );
                        await manager.applyPrepared();
                    }
                for (const manager of this.managers) {
                    const current =
                        (await readState(manager.context.dir)).active?.id ??
                        null;
                    const intended = journal.members.find(
                        (member) => member.key === manager.context.lockKey,
                    )?.nextId;
                    if (current !== intended)
                        throw new CrafletError(
                            "GROUP_RECOVERY_CONFLICT",
                            "A recovered group member no longer matches the recorded active installation.",
                            4,
                        );
                }
                // Once spawning began, recovery never rolls back individual JARs.
                await rm(this.journalFile);
                return true;
            },
        );
    }
}
