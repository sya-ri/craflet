import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
    type BackupMetadata,
    type BackupPlan,
    type BackupRoot,
    CrafletError,
    DEFAULT_BACKUP_FILES,
    stableStringify,
} from "@craflet/core";
import { type } from "arktype";
import { NodeBackupService } from "../restic/backup-service.js";
import {
    backupArchiveFiles,
    MAX_BACKUP_METADATA_BYTES,
    validateBackupMetadata,
} from "../restic/metadata.js";
import { verifyBackupRestoreLayout } from "../restic/restore-archive.js";
import {
    checkBackupSpace,
    hashBackupFile,
    pathsOverlap,
    privateBackupDirectory,
    removePrivateBackupDirectory,
} from "./backup-files.js";
import {
    type BackupBatch,
    projectBackupId,
    runtimeRootId,
    validateRecoveryGroup,
} from "./groups.js";
import {
    assertNoSymlinks,
    exists,
    pathContains,
    readJson,
    writeJson,
} from "./io.js";
import type { ProjectContext } from "./projects.js";
import type { RestoreApplyOptions } from "./restore.js";
import { type Installation, validateInstallation } from "./state.js";

export function groupRestoreDigest(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function groupRestorePathKey(value: string): string {
    return path.resolve(value).normalize("NFC").toLowerCase();
}

const GroupActiveSchema = type({
    "+": "reject",
    group: {
        "+": "reject",
        name: "string > 0",
        members: type({
            "+": "reject",
            key: "string > 0",
            projectId: "string > 0",
            name: "string > 0",
            runtimeRootId: "string > 0",
            installation: "unknown",
        }).array(),
    },
});

export interface GroupRestoreMember {
    project: ProjectContext;
    installation: Installation;
    runtimeRoot: BackupRoot;
}

export interface GroupRestoreInspection {
    source: string;
    fingerprint: string;
    policyFingerprint: string;
    metadata: BackupMetadata;
    members: GroupRestoreMember[];
    sharedRoots: BackupRoot[];
    mappings: Record<string, string>;
    databases: string[];
}

export interface GroupRestoreProjection {
    project: ProjectContext;
    source: string;
    backup: NodeBackupService;
    options: RestoreApplyOptions;
}

export interface GroupRestoreWorkspace {
    directory: string;
    id: string;
    projections: GroupRestoreProjection[];
}

export function groupRestoreContext(batch: BackupBatch): {
    group: string;
    first: ProjectContext;
} {
    if (!batch.group)
        throw new CrafletError(
            "RESTORE_GROUP",
            "Select a complete declared recovery group.",
            3,
        );
    return {
        group: batch.group,
        first: validateRecoveryGroup(batch.group, batch.projects),
    };
}

export function requireGroupBackup(batch: BackupBatch): NodeBackupService {
    groupRestoreContext(batch);
    if (!batch.backup)
        throw new CrafletError(
            "BACKUP_REQUIRED",
            "A group restore requires a configured repository for its pre-restore snapshot.",
            3,
        );
    return batch.backup;
}

export function groupRestorePolicyFingerprint(batch: BackupBatch): string {
    const backup = requireGroupBackup(batch);
    return groupRestoreDigest({
        group: batch.group,
        backup: backup.config,
        projects: [...batch.projects]
            .sort((a, b) => a.lockKey.localeCompare(b.lockKey, "en"))
            .map((project) => ({
                id: projectBackupId(project),
                directory: project.dir,
                home: project.home,
                lockRoot: project.lockRoot,
                files: project.manifest.backup?.files ?? DEFAULT_BACKUP_FILES,
                secrets: project.manifest.secrets ?? {},
            })),
    });
}

function protectedPaths(batch: BackupBatch, source: string): string[] {
    const backup = requireGroupBackup(batch);
    const { first } = groupRestoreContext(batch);
    return [
        source,
        first.home,
        ...[
            ".craflet",
            ".git",
            "craflet-lock.yaml",
            "craflet-workspace.yaml",
        ].map((name) => path.join(first.lockRoot, name)),
        ...batch.projects.flatMap((project) => [
            ...[".craflet", ".git", "config", "imports", "craflet.yaml"].map(
                (name) => path.join(project.dir, name),
            ),
            ...Object.values(project.manifest.secrets ?? {}).flatMap(
                (reference) =>
                    "file" in reference
                        ? [path.resolve(project.dir, reference.file)]
                        : [],
            ),
        ]),
        ...Object.values(backup.config.repositories ?? {}).flatMap(
            (repository) => [
                repository.path,
                ...("file" in repository.password
                    ? [path.resolve(first.dir, repository.password.file)]
                    : []),
            ],
        ),
        ...(backup.config.databases ?? []).flatMap((database) =>
            database.kind === "sqlite"
                ? []
                : [
                      ...("file" in database.password
                          ? [path.resolve(first.dir, database.password.file)]
                          : []),
                      ...(database.sslCa
                          ? [path.resolve(first.dir, database.sslCa)]
                          : []),
                  ],
        ),
    ];
}

async function readBoundedJson(
    file: string,
    limit = MAX_BACKUP_METADATA_BYTES,
): Promise<unknown> {
    await assertNoSymlinks(file);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > limit)
        throw new CrafletError(
            "RESTORE_METADATA",
            "Restore metadata is not a regular file within the supported size limit.",
            3,
        );
    try {
        return await readJson<unknown>(file);
    } catch {
        throw new CrafletError(
            "RESTORE_METADATA",
            "Restore metadata cannot be read; its contents are omitted.",
            3,
        );
    }
}

/** Inspect the whole extraction before constructing any per-member view. */
export async function inspectGroupBackupRestore(
    batch: BackupBatch,
    directory: string,
    options: RestoreApplyOptions,
): Promise<GroupRestoreInspection> {
    const backup = requireGroupBackup(batch);
    const { first } = groupRestoreContext(batch);
    if (
        options.mappings !== undefined &&
        (options.mappings === null ||
            Array.isArray(options.mappings) ||
            typeof options.mappings !== "object")
    )
        throw new CrafletError(
            "RESTORE_MAPPING",
            "Restore mappings must be an object keyed by shared root ID.",
            2,
        );
    const source = path.resolve(directory);
    await assertNoSymlinks(source);
    if (
        batch.projects.some(
            (project) =>
                pathsOverlap(source, project.dir) ||
                pathsOverlap(source, project.home),
        ) ||
        Object.values(backup.config.repositories ?? {}).some((repository) =>
            pathsOverlap(source, repository.path),
        )
    )
        throw new CrafletError(
            "RESTORE_OVERLAP",
            "The extraction must be separate from every group project, Craflet home, and backup repository.",
            3,
        );
    if (await exists(path.join(source, ".craflet-restore-incomplete.json")))
        throw new CrafletError(
            "RESTORE_INCOMPLETE",
            "The extraction did not finish verification. Restore into a separate empty directory first.",
            3,
        );
    const metadata = validateBackupMetadata(
        await readBoundedJson(path.join(source, "metadata/backup.json")),
        backup.config.projectId ?? "",
    );
    if (
        stableStringify(
            await readBoundedJson(path.join(source, "metadata/active.json")),
        ) !== stableStringify(metadata.active)
    )
        throw new CrafletError(
            "RESTORE_METADATA",
            "The group active metadata differs from its manifest.",
            3,
        );
    const active = GroupActiveSchema(metadata.active);
    if (
        active instanceof type.errors ||
        active.group.name !== batch.group ||
        active.group.members.length !== batch.projects.length ||
        new Set(active.group.members.map((member) => member.projectId)).size !==
            batch.projects.length ||
        new Set(active.group.members.map((member) => member.runtimeRootId))
            .size !== batch.projects.length ||
        new Set(active.group.members.map((member) => member.key)).size !==
            batch.projects.length
    )
        throw new CrafletError(
            "RESTORE_GROUP_MEMBERSHIP",
            "The snapshot does not contain exactly the selected recovery group members.",
            3,
        );
    const members: GroupRestoreMember[] = [];
    for (const project of [...batch.projects].sort((a, b) =>
        a.lockKey.localeCompare(b.lockKey, "en"),
    )) {
        const member = active.group.members.find(
            (item) => item.projectId === projectBackupId(project),
        );
        const root = metadata.roots.find(
            (item) => item.id === member?.runtimeRootId,
        );
        if (
            !member ||
            !root ||
            root.id !== runtimeRootId(project) ||
            !root.external ||
            root.kind !== "directory"
        )
            throw new CrafletError(
                "RESTORE_GROUP_MEMBERSHIP",
                "A group runtime root does not match its project's persistent identity.",
                3,
            );
        if (!member.installation)
            throw new CrafletError(
                "RESTORE_NO_INSTALLATION",
                "Every member requires a known active installation for group production restore.",
                3,
            );
        const installation = validateInstallation(
            structuredClone(member.installation),
        );
        if (
            installation.manifest.id &&
            installation.manifest.id !== project.manifest.id
        )
            throw new CrafletError(
                "RESTORE_PROJECT",
                "A member's active installation belongs to another project.",
                3,
            );
        members.push({ project, installation, runtimeRoot: root });
    }
    if (metadata.roots.some((root) => !root.external))
        throw new CrafletError(
            "RESTORE_GROUP_MEMBERSHIP",
            "A group snapshot must identify each runtime explicitly.",
            3,
        );
    const sharedRoots = metadata.roots.filter(
        (root) => !members.some((member) => member.runtimeRoot.id === root.id),
    );
    const mappings: Record<string, string> = Object.create(null);
    const mapped: string[] = members.map((member) =>
        path.join(member.project.dir, "runtime"),
    );
    const protectedTargets = protectedPaths(batch, source);
    for (const root of sharedRoots) {
        const target = options.mappings?.[root.id];
        if (
            !target &&
            !metadata.files.some((file) =>
                file.destination.startsWith(`data/external/${root.id}/`),
            )
        )
            continue;
        if (!target || !path.isAbsolute(target))
            throw new CrafletError(
                "RESTORE_MAPPING",
                `Shared root ${root.id} needs an explicit absolute mapping; snapshot source paths are not write targets.`,
                3,
            );
        const absolute = path.resolve(target);
        if (
            protectedTargets.some((protectedPath) =>
                pathsOverlap(absolute, protectedPath),
            )
        )
            throw new CrafletError(
                "RESTORE_MAPPING",
                "A shared restore root overlaps protected group files.",
                3,
            );
        if (mapped.some((other) => pathsOverlap(absolute, other)))
            throw new CrafletError(
                "RESTORE_COLLISION",
                "Shared restore mappings overlap another shared root or a member runtime.",
                3,
            );
        await assertNoSymlinks(absolute);
        mappings[root.id] = absolute;
        mapped.push(absolute);
    }
    for (const id of Object.keys(options.mappings ?? {}))
        if (!sharedRoots.some((root) => root.id === id))
            throw new CrafletError(
                "RESTORE_MAPPING",
                "A mapping is not a shared data root of this group snapshot.",
                2,
            );
    const databases = options.databases ?? [];
    if (
        new Set(databases).size !== databases.length ||
        databases.length !== metadata.databases.length ||
        databases.some(
            (id) => !metadata.databases.some((database) => database.id === id),
        )
    )
        throw new CrafletError(
            "RESTORE_DATABASE",
            "Explicitly select exactly the database dumps in this group snapshot.",
            3,
        );
    for (const dump of metadata.databases) {
        const config = backup.config.databases?.find(
            (database) =>
                database.id === dump.id && database.kind === dump.kind,
        );
        if (!config)
            throw new CrafletError(
                "RESTORE_DATABASE",
                "A group database dump has no matching current target configuration.",
                3,
            );
        if (config.kind === "sqlite") {
            const target = path.resolve(first.dir, config.path);
            if (
                protectedTargets.some((protectedPath) =>
                    pathsOverlap(target, protectedPath),
                )
            )
                throw new CrafletError(
                    "RESTORE_MAPPING",
                    "A database restore target overlaps protected group files.",
                    3,
                );
            await assertNoSymlinks(target);
        }
    }
    await verifyBackupRestoreLayout(source, backupArchiveFiles(metadata));
    for (const file of [
        ...metadata.files.map((item) => ({
            path: item.destination,
            sha256: item.sha256,
            size: item.size,
        })),
        ...metadata.databases.map((item) => ({
            path: item.file,
            sha256: item.sha256,
            size: item.bytes,
        })),
    ]) {
        options.signal?.throwIfAborted();
        const integrity = await hashBackupFile(
            await assertNoSymlinks(source, file.path),
        );
        if (integrity.sha256 !== file.sha256 || integrity.bytes !== file.size)
            throw new CrafletError(
                "RESTORE_HASH",
                "The group extraction failed its file size or SHA-256 verification.",
                3,
            );
    }
    return {
        source,
        fingerprint: groupRestoreDigest(metadata),
        policyFingerprint: groupRestorePolicyFingerprint(batch),
        metadata,
        members,
        sharedRoots,
        mappings,
        databases: [...databases],
    };
}

function projectionMetadata(
    inspection: GroupRestoreInspection,
    member: GroupRestoreMember,
    shared: boolean,
): BackupMetadata {
    const prefix = `data/external/${member.runtimeRoot.id}/`;
    const sharedIds = new Set(inspection.sharedRoots.map((root) => root.id));
    return {
        format: 1,
        projectId: projectBackupId(member.project),
        createdAt: inspection.metadata.createdAt,
        active: { installation: structuredClone(member.installation) },
        roots: [
            { ...member.runtimeRoot, id: "runtime", external: false },
            ...(shared ? inspection.sharedRoots : []),
        ],
        files: inspection.metadata.files.flatMap((file) =>
            file.destination.startsWith(prefix)
                ? [
                      {
                          ...file,
                          destination: `data/runtime/${file.destination.slice(prefix.length)}`,
                      },
                  ]
                : shared && sharedIds.has(file.destination.split("/")[2] ?? "")
                  ? [{ ...file }]
                  : [],
        ),
        databases: shared ? inspection.metadata.databases : [],
    };
}

function projectionBackup(
    batch: BackupBatch,
    inspection: GroupRestoreInspection,
    member: GroupRestoreMember,
    shared: boolean,
): NodeBackupService {
    const groupBackup = requireGroupBackup(batch);
    const project = member.project;
    const roots: BackupRoot[] = [
        {
            id: "runtime",
            path: path.join(project.dir, "runtime"),
            external: false,
            kind: "directory",
        },
        ...(shared
            ? inspection.sharedRoots.flatMap((root) => {
                  const target = inspection.mappings[root.id];
                  return target ? [{ ...root, path: target }] : [];
              })
            : []),
    ];
    return new NodeBackupService(
        project.dir,
        project.home,
        {
            ...groupBackup.config,
            projectId: projectBackupId(project),
            files: project.manifest.backup?.files ?? [...DEFAULT_BACKUP_FILES],
            databases: shared ? (groupBackup.config.databases ?? []) : [],
        },
        undefined,
        {
            filePolicies: [...batch.projects]
                .sort((a, b) => a.lockKey.localeCompare(b.lockKey, "en"))
                .map((item) => ({
                    baseDirectory: item.dir,
                    files: item.manifest.backup?.files ?? [
                        ...DEFAULT_BACKUP_FILES,
                    ],
                })),
            planFiles: async (): Promise<BackupPlan> => {
                const plan = await groupBackup.plan();
                const files = plan.files.flatMap((file) => {
                    const root = roots.find((item) =>
                        item.kind === "file"
                            ? groupRestorePathKey(item.path) ===
                              groupRestorePathKey(file.source)
                            : pathContains(item.path, file.source),
                    );
                    if (!root) return [];
                    const suffix =
                        root.kind === "file"
                            ? path.basename(file.source)
                            : path
                                  .relative(root.path, file.source)
                                  .split(path.sep)
                                  .join("/");
                    return [
                        {
                            ...file,
                            rootId: root.id,
                            destination: root.external
                                ? `data/external/${root.id}/${suffix}`
                                : `data/runtime/${suffix}`,
                        },
                    ];
                });
                const bytes = files.reduce(
                    (total, file) => total + file.size,
                    0,
                );
                return {
                    ...plan,
                    roots,
                    files,
                    bytes,
                    stagingBytes: bytes,
                    databaseIds: shared ? plan.databaseIds : [],
                };
            },
        },
    );
}

async function projectedPayload(
    source: string,
    target: string,
    size: number,
    createLink: typeof link,
): Promise<void> {
    await assertNoSymlinks(source);
    await assertNoSymlinks(target);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
        await createLink(source, target);
    } catch (error) {
        if (
            !(error instanceof Error) ||
            ![
                "EXDEV",
                "EPERM",
                "EACCES",
                "ENOTSUP",
                "EOPNOTSUPP",
                "ENOSYS",
            ].includes((error as NodeJS.ErrnoException).code ?? "")
        )
            throw error;
        await checkBackupSpace(path.dirname(target), size);
        await copyFile(source, target, constants.COPYFILE_EXCL);
    }
}

function projectionDirectory(
    directory: string,
    project: ProjectContext,
): string {
    return path.join(directory, `member-${projectBackupId(project)}`);
}

function makeProjection(
    batch: BackupBatch,
    inspection: GroupRestoreInspection,
    member: GroupRestoreMember,
    directory: string,
    index: number,
    options: RestoreApplyOptions,
): GroupRestoreProjection {
    return {
        project: member.project,
        source: projectionDirectory(directory, member.project),
        backup: projectionBackup(batch, inspection, member, index === 0),
        options: {
            mappings: index === 0 ? { ...inspection.mappings } : {},
            databases: index === 0 ? inspection.databases : [],
            ...(options.offline !== undefined
                ? { offline: options.offline }
                : {}),
            ...(options.dryRun ? { dryRun: true } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
        },
    };
}

export async function createGroupRestoreWorkspace(
    batch: BackupBatch,
    inspection: GroupRestoreInspection,
    options: RestoreApplyOptions,
    operations: { link?: typeof link } = {},
): Promise<GroupRestoreWorkspace> {
    const directory = await privateBackupDirectory(
        path.dirname(inspection.source),
        ".craflet-group-restore-",
    );
    const id = randomUUID();
    try {
        await writeJson(path.join(directory, "owner.json"), {
            id,
            source: inspection.source,
            fingerprint: inspection.fingerprint,
        });
        const projections: GroupRestoreProjection[] = [];
        for (const [index, member] of inspection.members.entries()) {
            options.signal?.throwIfAborted();
            const metadata = projectionMetadata(
                inspection,
                member,
                index === 0,
            );
            const source = projectionDirectory(directory, member.project);
            await mkdir(source, { mode: 0o700 });
            const runtimePrefix = `data/external/${member.runtimeRoot.id}/`;
            for (const file of metadata.files) {
                options.signal?.throwIfAborted();
                const original = file.destination.startsWith("data/runtime/")
                    ? runtimePrefix +
                      file.destination.slice("data/runtime/".length)
                    : file.destination;
                await projectedPayload(
                    await assertNoSymlinks(inspection.source, original),
                    await assertNoSymlinks(source, file.destination),
                    file.size,
                    operations.link ?? link,
                );
            }
            for (const database of metadata.databases)
                await projectedPayload(
                    await assertNoSymlinks(inspection.source, database.file),
                    await assertNoSymlinks(source, database.file),
                    database.bytes,
                    operations.link ?? link,
                );
            await writeJson(
                path.join(source, "metadata/backup.json"),
                metadata,
            );
            await writeJson(
                path.join(source, "metadata/active.json"),
                metadata.active,
            );
            projections.push(
                makeProjection(
                    batch,
                    inspection,
                    member,
                    directory,
                    index,
                    options,
                ),
            );
        }
        return { directory, id, projections };
    } catch (error) {
        await removePrivateBackupDirectory(
            path.dirname(inspection.source),
            directory,
        );
        throw error;
    }
}

async function validateWorkspaceOwner(
    inspection: GroupRestoreInspection,
    directory: string,
    id: string,
): Promise<void> {
    if (
        path.dirname(directory) !== path.dirname(inspection.source) ||
        !/^\.craflet-group-restore-[A-Za-z0-9]{6}$/u.test(
            path.basename(directory),
        )
    )
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "The restore workspace leaves its recorded temporary location.",
            4,
        );
    await assertNoSymlinks(directory);
    const owner = await readBoundedJson(
        path.join(directory, "owner.json"),
        16384,
    );
    if (
        stableStringify(owner) !==
        stableStringify({
            id,
            source: inspection.source,
            fingerprint: inspection.fingerprint,
        })
    )
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "The group restore workspace ownership marker does not match its journal.",
            4,
        );
}

export async function loadGroupRestoreWorkspace(
    batch: BackupBatch,
    inspection: GroupRestoreInspection,
    directory: string,
    id: string,
    options: RestoreApplyOptions,
): Promise<GroupRestoreWorkspace> {
    await validateWorkspaceOwner(inspection, directory, id);
    const expected = new Set([
        "owner.json",
        ...inspection.members.map((member) =>
            path.basename(projectionDirectory(directory, member.project)),
        ),
    ]);
    const actual = await readdir(directory);
    if (
        actual.length !== expected.size ||
        actual.some((entry) => !expected.has(entry))
    )
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "Unexpected files appeared in the private group restore workspace.",
            4,
        );
    const projections: GroupRestoreProjection[] = [];
    for (const [index, member] of inspection.members.entries()) {
        const source = projectionDirectory(directory, member.project);
        const expectedMetadata = projectionMetadata(
            inspection,
            member,
            index === 0,
        );
        const actualMetadata = await readBoundedJson(
            path.join(source, "metadata/backup.json"),
        );
        if (
            stableStringify(expectedMetadata) !==
            stableStringify(actualMetadata)
        )
            throw new CrafletError(
                "RESTORE_CHANGED",
                "A member's restore projection changed after the group was planned.",
                4,
            );
        await verifyBackupRestoreLayout(
            source,
            backupArchiveFiles(expectedMetadata),
        );
        projections.push(
            makeProjection(
                batch,
                inspection,
                member,
                directory,
                index,
                options,
            ),
        );
    }
    return { directory, id, projections };
}

export async function removeGroupRestoreWorkspace(
    inspection: GroupRestoreInspection,
    workspace: Pick<GroupRestoreWorkspace, "directory" | "id">,
): Promise<void> {
    await validateWorkspaceOwner(inspection, workspace.directory, workspace.id);
    await removePrivateBackupDirectory(
        path.dirname(inspection.source),
        workspace.directory,
    );
}
