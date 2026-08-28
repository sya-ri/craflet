import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactStore,
    assertStopped,
    CrafletError,
    stableStringify,
} from "@craflet/core";
import { type } from "arktype";
import { NodeDatabaseBackupAdapter } from "../database/backup.js";
import { NodeServerController } from "../runtime/controller.js";
import { hashBackupFile, pathsOverlap } from "./backup-files.js";
import {
    createGroupRestoreWorkspace,
    type GroupRestoreInspection,
    type GroupRestoreProjection,
    type GroupRestoreWorkspace,
    groupRestoreContext,
    groupRestoreDigest,
    groupRestorePathKey,
    groupRestorePolicyFingerprint,
    inspectGroupBackupRestore,
    loadGroupRestoreWorkspace,
    removeGroupRestoreWorkspace,
    requireGroupBackup,
} from "./group-restore-layout.js";
import {
    assertCleanRecoveryGroup,
    type BackupBatch,
    collectGroupBackupMetadata,
    projectBackupId,
} from "./groups.js";
import { artifactContext } from "./installations.js";
import {
    assertNoSymlinks,
    exists,
    readJson,
    withMutex,
    writeJson,
} from "./io.js";
import { ensurePrivateDirectory } from "./private.js";
import {
    executePreparedRestore,
    inspectBackupRestore,
    type PreparedRestoreApplication,
    prepareRestoreApplication,
    type RestoreApplyOptions,
    type RestoreChange,
    recoverBackupRestore,
    verifyRuntimeJars,
} from "./restore.js";
import { installationJars, readState } from "./state.js";

const Hash = type(/^[a-f0-9]{64}$/);
const ChangeSchema = type({
    "+": "reject",
    target: "string > 0",
    before: Hash.or("null"),
    after: Hash.or("null"),
    kind: "'data' | 'jar' | 'database'",
});
const MemberSchema = type({
    "+": "reject",
    projectId: "string > 0",
    key: "string > 0",
    source: "string > 0",
    fingerprint: Hash,
    policyFingerprint: Hash,
    stateFingerprint: Hash,
    changes: ChangeSchema.array(),
    nextInstallationId: "string.uuid",
    createdAt: "string",
    completed: "boolean",
    options: {
        "+": "reject",
        mappings: { "[string]": "string" },
        databases: "string[]",
        offline: "boolean",
    },
});
const JournalSchema = type({
    "+": "reject",
    schemaVersion: "1",
    group: "string > 0",
    source: "string > 0",
    fingerprint: Hash,
    policyFingerprint: Hash,
    directory: "string > 0",
    workId: "string.uuid",
    backupId: Hash,
    members: MemberSchema.array(),
});
type GroupRestoreJournal = typeof JournalSchema.infer;
type GroupRestoreJournalMember = typeof MemberSchema.infer;

export interface GroupRestoreApplyOptions extends RestoreApplyOptions {
    /** Fault-injection seam used by tests; never serialized into a journal. */
    checkpoint?: (stage: string) => Promise<void>;
}

export interface GroupRestoreRecoveryOptions {
    dryRun?: boolean;
    offline?: boolean;
    signal?: AbortSignal;
    checkpoint?: (stage: string) => Promise<void>;
}

function journalPath(batch: BackupBatch): string {
    const { first } = groupRestoreContext(batch);
    return path.join(first.lockRoot, ".craflet/group-restore.json");
}

function memberJournal(projection: GroupRestoreProjection): string {
    return path.join(projection.project.dir, ".craflet/restore.json");
}

async function assertAllStopped(batch: BackupBatch): Promise<void> {
    for (const project of batch.projects)
        assertStopped(
            (await new NodeServerController(project.dir, project.home).status())
                .status,
        );
}

function immutablePlan(
    prepared: Pick<
        PreparedRestoreApplication,
        | "source"
        | "fingerprint"
        | "policyFingerprint"
        | "stateFingerprint"
        | "changes"
    >,
) {
    return {
        source: prepared.source,
        fingerprint: prepared.fingerprint,
        policyFingerprint: prepared.policyFingerprint,
        stateFingerprint: prepared.stateFingerprint,
        changes: prepared.changes,
    };
}

function journalMember(
    projection: GroupRestoreProjection,
    prepared: PreparedRestoreApplication,
): GroupRestoreJournalMember {
    return {
        ...immutablePlan(prepared),
        projectId: projectBackupId(projection.project),
        key: projection.project.lockKey,
        nextInstallationId: prepared.nextInstallationId,
        createdAt: prepared.createdAt,
        completed: false,
        options: {
            mappings: prepared.options.mappings ?? {},
            databases: prepared.options.databases ?? [],
            offline: prepared.options.offline ?? false,
        },
    };
}

function assertDistinctGroupChanges(
    members: readonly { changes: readonly RestoreChange[] }[],
): void {
    const keys = new Set<string>();
    for (const change of members.flatMap((member) => member.changes)) {
        const key = groupRestorePathKey(change.target);
        if (
            !path.isAbsolute(change.target) ||
            path.resolve(change.target) !== change.target ||
            keys.has(key)
        )
            throw new CrafletError(
                "RESTORE_COLLISION",
                "Two group members restore or remove the same target.",
                3,
            );
        keys.add(key);
    }
    for (const key of keys) {
        let parent = path.dirname(key);
        while (parent !== path.dirname(parent)) {
            if (keys.has(parent))
                throw new CrafletError(
                    "RESTORE_COLLISION",
                    "A group file target overlaps another target's parent directory.",
                    3,
                );
            parent = path.dirname(parent);
        }
    }
}

async function assertBackedUpTargets(
    batch: BackupBatch,
    inspection: GroupRestoreInspection,
    prepared: readonly PreparedRestoreApplication[],
    workspace: GroupRestoreWorkspace,
): Promise<void> {
    const plan = await requireGroupBackup(batch).plan();
    if (
        plan.files.some(
            (file) =>
                pathsOverlap(file.source, inspection.source) ||
                pathsOverlap(file.source, workspace.directory),
        )
    )
        throw new CrafletError(
            "BACKUP_SELF_INCLUSION",
            "The group backup selects its restore extraction or temporary projection.",
            3,
        );
    const files = new Set(
        plan.files.map((file) => groupRestorePathKey(file.source)),
    );
    for (const change of prepared.flatMap((member) => member.changes))
        if (
            change.kind === "data" &&
            change.before !== null &&
            !files.has(groupRestorePathKey(change.target))
        )
            throw new CrafletError(
                "RESTORE_UNPROTECTED_TARGET",
                "An existing group restore target is absent from the actual pre-restore backup selection.",
                3,
            );
}

async function verifyCompleted(
    projection: GroupRestoreProjection,
    member: GroupRestoreJournalMember,
): Promise<void> {
    const verified = await inspectBackupRestore(
        projection.project,
        projection.source,
        projection.options,
        projection.backup,
    );
    if (verified.fingerprint !== member.fingerprint)
        throw new CrafletError(
            "RESTORE_CHANGED",
            "The completed member's extraction changed after planning.",
            4,
        );
    await verifyRuntimeJars(projection.project, verified.installation);
    const current = await readState(projection.project.dir);
    const expected = {
        schemaVersion: 1,
        active: {
            ...verified.installation,
            id: member.nextInstallationId,
            createdAt: member.createdAt,
        },
    };
    if (stableStringify(current) !== stableStringify(expected))
        throw new CrafletError(
            "RESTORE_CONFLICT",
            "An already restored member's installation state changed; it was not overwritten.",
            4,
        );
    for (const change of member.changes) {
        await assertNoSymlinks(change.target);
        const hash = (await exists(change.target))
            ? (await hashBackupFile(change.target)).sha256
            : null;
        if (hash !== change.after)
            throw new CrafletError(
                "RESTORE_CONFLICT",
                "An already restored group target changed; automatic recovery stopped.",
                4,
            );
    }
}

async function validateMemberJournal(
    projection: GroupRestoreProjection,
    member: GroupRestoreJournalMember,
    backupId: string,
): Promise<void> {
    const file = await assertNoSymlinks(memberJournal(projection));
    if ((await lstat(file)).size > 128 * 1024 * 1024)
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "A member restore journal exceeds the supported size limit.",
            4,
        );
    let value: Partial<GroupRestoreJournalMember> & {
        backupId?: string;
        mappings?: Record<string, string>;
        databases?: string[];
    };
    try {
        value = await readJson(file);
    } catch {
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "A member restore journal cannot be read.",
            4,
        );
    }
    if (
        !value ||
        stableStringify({
            source: value.source,
            fingerprint: value.fingerprint,
            policyFingerprint: value.policyFingerprint,
            stateFingerprint: value.stateFingerprint,
            changes: value.changes,
        }) !== stableStringify(immutablePlan(member)) ||
        value.nextInstallationId !== member.nextInstallationId ||
        value.createdAt !== member.createdAt ||
        value.backupId !== backupId ||
        stableStringify(value.mappings) !==
            stableStringify(member.options.mappings) ||
        stableStringify(value.databases) !==
            stableStringify(member.options.databases)
    )
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "A member restore journal differs from its group plan.",
            4,
        );
}

function interrupted(error: unknown): never {
    if (error instanceof CrafletError) throw error;
    throw new CrafletError(
        "GROUP_RESTORE_INTERRUPTED",
        "Group restore interrupted. Keep every member stopped and run recover with the complete group. Its pre-restore snapshot and exact file plan were retained.",
        4,
    );
}

async function cleanup(
    inspection: GroupRestoreInspection,
    workspace: GroupRestoreWorkspace,
): Promise<boolean> {
    try {
        await removeGroupRestoreWorkspace(inspection, workspace);
        return true;
    } catch {
        return false;
    }
}

/** Applies one complete group snapshot; it never starts servers or updates the shared lock. */
export async function applyGroupBackupRestore(
    batch: BackupBatch,
    directory: string,
    options: GroupRestoreApplyOptions,
    store: ArtifactStore,
    runnerEntry?: string,
): Promise<unknown> {
    const backup = requireGroupBackup(batch);
    const { group, first } = groupRestoreContext(batch);
    const checkpoint = options.checkpoint;
    const inspection = await inspectGroupBackupRestore(
        batch,
        directory,
        options,
    );
    const perform = async () => {
        await assertCleanRecoveryGroup(batch.projects);
        const workspace = await createGroupRestoreWorkspace(
            batch,
            inspection,
            options,
        );
        let retain = false;
        let result: Record<string, unknown> | undefined;
        try {
            const plan = await backup.plan();
            const preview = {
                group: batch.group,
                projects: inspection.members.map(
                    (member) => member.project.manifest.name,
                ),
                databases: inspection.databases,
                startAfterApply: false,
                sharedLockUnchanged: true,
                backupStagingBytes: plan.stagingBytes,
                projectionCopyBytesUpperBound:
                    inspection.metadata.files.reduce(
                        (total, file) => total + file.size,
                        0,
                    ) +
                    inspection.metadata.databases.reduce(
                        (total, database) => total + database.bytes,
                        0,
                    ),
            };
            if (options.dryRun) {
                const prepared = await Promise.all(
                    workspace.projections.map((projection) =>
                        prepareRestoreApplication(
                            projection.project,
                            projection.source,
                            projection.options,
                            store,
                            projection.backup,
                        ),
                    ),
                );
                assertDistinctGroupChanges(prepared);
                await assertBackedUpTargets(
                    batch,
                    inspection,
                    prepared,
                    workspace,
                );
                result = {
                    ...preview,
                    changes: prepared.flatMap((member) => member.changes),
                    unresolved: [
                        "Exact JAR cache availability and database clients are checked before stopping the group.",
                    ],
                };
                return result;
            }
            const controllers = inspection.members.map(
                (member) =>
                    new NodeServerController(
                        member.project.dir,
                        member.project.home,
                        runnerEntry,
                    ),
            );
            const statuses = await Promise.all(
                controllers.map((controller) => controller.status()),
            );
            for (const status of statuses)
                if (status.status !== "running") assertStopped(status.status);
            const active = await collectGroupBackupMetadata(
                group,
                batch.projects,
            );
            const fixed = new Map(
                active.group.members.map((member) => [
                    member.key,
                    member.installation?.id ?? null,
                ]),
            );
            for (const projection of workspace.projections) {
                const verified = await inspectBackupRestore(
                    projection.project,
                    projection.source,
                    projection.options,
                    projection.backup,
                );
                await verifyRuntimeJars(
                    projection.project,
                    verified.installation,
                );
                for (const artifact of installationJars(
                    verified.installation,
                ).values()) {
                    const source = await store.ensure(
                        artifact,
                        artifactContext(
                            {
                                ...projection.project,
                                manifest: verified.installation.manifest,
                            },
                            options,
                        ),
                    );
                    const integrity = await hashBackupFile(source);
                    if (
                        integrity.sha256 !== artifact.sha256 ||
                        integrity.bytes !== artifact.size
                    )
                        throw new CrafletError(
                            "RESTORE_HASH",
                            "An exact locked group JAR is unavailable.",
                            3,
                        );
                }
            }
            await backup.prepare({
                offline: options.offline ?? false,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            await backup.preflight(
                options.signal ? { signal: options.signal } : {},
            );
            await new NodeDatabaseBackupAdapter(
                first.dir,
                first.home,
            ).preflightRestore(
                (backup.config.databases ?? []).filter((database) =>
                    inspection.databases.includes(database.id),
                ),
                options.signal,
            );
            for (const [index, controller] of controllers.entries())
                if (statuses[index]?.status === "running")
                    assertStopped((await controller.stop()).status);
            await assertAllStopped(batch);
            const rechecked = await inspectGroupBackupRestore(
                batch,
                directory,
                options,
            );
            if (
                rechecked.fingerprint !== inspection.fingerprint ||
                rechecked.policyFingerprint !== inspection.policyFingerprint
            )
                throw new CrafletError(
                    "RESTORE_CHANGED",
                    "The group extraction or policy changed during preflight.",
                    3,
                );
            const operations: {
                projection: GroupRestoreProjection;
                prepared: PreparedRestoreApplication;
                member: GroupRestoreJournalMember;
            }[] = [];
            for (const projection of workspace.projections) {
                const prepared = await prepareRestoreApplication(
                    projection.project,
                    projection.source,
                    projection.options,
                    store,
                    projection.backup,
                );
                operations.push({
                    projection,
                    prepared,
                    member: journalMember(projection, prepared),
                });
            }
            const prepared = operations.map((operation) => operation.prepared);
            assertDistinctGroupChanges(prepared);
            await assertBackedUpTargets(batch, inspection, prepared, workspace);
            const saved = await backup.create(
                await collectGroupBackupMetadata(group, batch.projects, fixed),
                options.signal ? { signal: options.signal } : {},
            );
            const journal: GroupRestoreJournal = {
                schemaVersion: 1,
                group,
                source: inspection.source,
                fingerprint: inspection.fingerprint,
                policyFingerprint: inspection.policyFingerprint,
                directory: workspace.directory,
                workId: workspace.id,
                backupId: saved.snapshotId,
                members: operations.map((operation) => operation.member),
            };
            const file = await assertNoSymlinks(journalPath(batch));
            await writeJson(file, journal);
            retain = true;
            try {
                await options.checkpoint?.("group:prepared");
                for (const { projection, prepared, member } of operations) {
                    await assertAllStopped(batch);
                    await executePreparedRestore(
                        projection.project,
                        prepared,
                        store,
                        projection.backup,
                        {
                            operationLockHeld: true,
                            preRestoreSnapshot: saved.snapshotId,
                            ...(options.signal
                                ? { signal: options.signal }
                                : {}),
                            ...(checkpoint
                                ? {
                                      checkpoint: (stage: string) =>
                                          checkpoint(
                                              `${projection.project.lockKey}:${stage}`,
                                          ),
                                  }
                                : {}),
                        },
                    );
                    member.completed = true;
                    await writeJson(file, journal);
                    await options.checkpoint?.(
                        `${projection.project.lockKey}:complete`,
                    );
                }
                for (const { projection, member } of operations)
                    await verifyCompleted(projection, member);
                await options.checkpoint?.("group:applied");
                await rm(file);
                retain = false;
            } catch (error) {
                interrupted(error);
            }
            result = {
                ...preview,
                applied: true,
                pendingDiscarded: true,
                preRestoreSnapshot: saved.snapshotId,
            };
            return result;
        } finally {
            if (!retain && !(await cleanup(inspection, workspace)) && result)
                result.cleanupRequired = workspace.directory;
        }
    };
    if (options.dryRun) return perform();
    await ensurePrivateDirectory(path.join(first.lockRoot, ".craflet"));
    return withMutex(
        path.join(first.lockRoot, ".craflet/operation.lock"),
        perform,
    );
}

async function readJournal(batch: BackupBatch): Promise<GroupRestoreJournal> {
    const file = await assertNoSymlinks(journalPath(batch));
    if ((await lstat(file)).size > 128 * 1024 * 1024)
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "The group restore journal exceeds the supported size limit.",
            4,
        );
    let raw: unknown;
    try {
        raw = await readJson(file);
    } catch {
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "The group restore journal cannot be read.",
            4,
        );
    }
    const journal = JournalSchema(raw);
    if (
        journal instanceof type.errors ||
        journal.group !== batch.group ||
        journal.members.length !== batch.projects.length ||
        new Set(journal.members.map((member) => member.projectId)).size !==
            journal.members.length ||
        journal.members.some(
            (member) =>
                Array.isArray(member.options.mappings) ||
                !batch.projects.some(
                    (project) =>
                        projectBackupId(project) === member.projectId &&
                        project.lockKey === member.key,
                ) ||
                !Number.isFinite(Date.parse(member.createdAt)),
        ) ||
        journal.members.reduce(
            (total, member) => total + member.changes.length,
            0,
        ) > 300000
    )
        throw new CrafletError(
            "GROUP_RESTORE_JOURNAL",
            "The journal does not identify exactly the current group and a bounded file plan.",
            4,
        );
    assertDistinctGroupChanges(journal.members);
    return journal;
}

/** Returns false when no group restore is interrupted; deployment recovery can then run. */
export async function recoverGroupBackupRestore(
    batch: BackupBatch,
    store: ArtifactStore,
    options: GroupRestoreRecoveryOptions = {},
): Promise<boolean> {
    const { first } = groupRestoreContext(batch);
    const checkpoint = options.checkpoint;
    const file = await assertNoSymlinks(journalPath(batch));
    if (!(await exists(file))) return false;
    const perform = async () => {
        await assertAllStopped(batch);
        const journal = await readJournal(batch);
        if (journal.policyFingerprint !== groupRestorePolicyFingerprint(batch))
            throw new CrafletError(
                "RESTORE_CHANGED",
                "The group backup or secret policy changed after interruption.",
                4,
            );
        const allMappings = Object.fromEntries(
            journal.members.flatMap((member) =>
                Object.entries(member.options.mappings),
            ),
        );
        const allDatabases = journal.members.flatMap(
            (member) => member.options.databases,
        );
        const inspection = await inspectGroupBackupRestore(
            batch,
            journal.source,
            {
                mappings: allMappings,
                databases: allDatabases,
                ...(options.signal ? { signal: options.signal } : {}),
            },
        );
        if (inspection.fingerprint !== journal.fingerprint)
            throw new CrafletError(
                "RESTORE_CHANGED",
                "The original group extraction changed after interruption.",
                4,
            );
        const workspace = await loadGroupRestoreWorkspace(
            batch,
            inspection,
            journal.directory,
            journal.workId,
            {
                offline: options.offline ?? true,
                ...(options.signal ? { signal: options.signal } : {}),
            },
        );
        const actions: (
            | {
                  kind: "completed" | "recover";
                  projection: GroupRestoreProjection;
                  member: GroupRestoreJournalMember;
              }
            | {
                  kind: "execute";
                  projection: GroupRestoreProjection;
                  member: GroupRestoreJournalMember;
                  prepared: PreparedRestoreApplication;
              }
        )[] = [];
        for (const projection of workspace.projections) {
            const member = journal.members.find(
                (entry) =>
                    entry.projectId === projectBackupId(projection.project),
            );
            if (!member)
                throw new CrafletError(
                    "GROUP_RESTORE_JOURNAL",
                    "A group member is missing from the restore journal.",
                    4,
                );
            if (
                member.source !== projection.source ||
                stableStringify(member.options.mappings) !==
                    stableStringify(projection.options.mappings) ||
                stableStringify(member.options.databases) !==
                    stableStringify(projection.options.databases)
            )
                throw new CrafletError(
                    "GROUP_RESTORE_JOURNAL",
                    "The group journal's member projection or database ownership changed.",
                    4,
                );
            const state = await readState(projection.project.dir);
            if (await exists(memberJournal(projection))) {
                await validateMemberJournal(
                    projection,
                    member,
                    journal.backupId,
                );
                await recoverBackupRestore(
                    projection.project,
                    store,
                    projection.backup,
                    true,
                    {
                        operationLockHeld: true,
                        ...(options.signal ? { signal: options.signal } : {}),
                    },
                );
                actions.push({ kind: "recover", projection, member });
            } else if (
                member.completed ||
                state.active?.id === member.nextInstallationId
            ) {
                await verifyCompleted(projection, member);
                actions.push({ kind: "completed", projection, member });
            } else {
                const prepared = await prepareRestoreApplication(
                    projection.project,
                    projection.source,
                    {
                        ...projection.options,
                        ...(options.dryRun ? { dryRun: true } : {}),
                    },
                    store,
                    projection.backup,
                );
                if (
                    groupRestoreDigest(immutablePlan(prepared)) !==
                    groupRestoreDigest(immutablePlan(member))
                )
                    throw new CrafletError(
                        "RESTORE_CONFLICT",
                        "An untouched member changed after group restore stopped; its new files were not deleted.",
                        4,
                    );
                prepared.nextInstallationId = member.nextInstallationId;
                prepared.createdAt = member.createdAt;
                actions.push({ kind: "execute", projection, member, prepared });
            }
        }
        if (options.dryRun) return true;
        try {
            for (const action of actions) {
                options.signal?.throwIfAborted();
                await assertAllStopped(batch);
                if (action.kind === "recover")
                    await recoverBackupRestore(
                        action.projection.project,
                        store,
                        action.projection.backup,
                        false,
                        {
                            operationLockHeld: true,
                            ...(options.signal
                                ? { signal: options.signal }
                                : {}),
                        },
                    );
                else if (action.kind === "execute")
                    await executePreparedRestore(
                        action.projection.project,
                        action.prepared,
                        store,
                        action.projection.backup,
                        {
                            operationLockHeld: true,
                            preRestoreSnapshot: journal.backupId,
                            ...(options.signal
                                ? { signal: options.signal }
                                : {}),
                            ...(checkpoint
                                ? {
                                      checkpoint: (stage: string) =>
                                          checkpoint(
                                              `${action.projection.project.lockKey}:${stage}`,
                                          ),
                                  }
                                : {}),
                        },
                    );
                action.member.completed = true;
                await writeJson(file, journal);
                await options.checkpoint?.(
                    `${action.projection.project.lockKey}:complete`,
                );
            }
            for (const action of actions)
                await verifyCompleted(action.projection, action.member);
            await options.checkpoint?.("group:applied");
            await rm(file);
        } catch (error) {
            interrupted(error);
        }
        if (!(await cleanup(inspection, workspace)))
            throw new CrafletError(
                "RESTORE_CLEANUP",
                `The group was restored and remains stopped, but its private working directory could not be removed: ${workspace.directory}. Inspect it before manual cleanup.`,
                3,
            );
        return true;
    };
    return options.dryRun
        ? perform()
        : withMutex(
              path.join(first.lockRoot, ".craflet/operation.lock"),
              perform,
          );
}
