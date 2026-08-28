import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactStore,
    assertStopped,
    type BackupMetadata,
    type BackupService,
    CrafletError,
    createBackupSelector,
    type DatabaseBackupConfig,
    portablePluginJarName,
    stableStringify,
} from "@craflet/core";
import { type } from "arktype";
import { NodeDatabaseBackupAdapter } from "../database/backup.js";
import {
    validateBackupMetadata,
    validateBackupRelativePath,
} from "../restic/backup-service.js";
import { NodeServerController } from "../runtime/controller.js";
import { hashBackupFile, pathsOverlap } from "./backup-files.js";
import { NodeConfigManager } from "./config.js";
import { artifactContext } from "./installations.js";
import {
    assertNoSymlinks,
    exists,
    listFiles,
    readJson,
    withMutex,
    writeJson,
} from "./io.js";
import type { ProjectContext } from "./projects.js";
import {
    type Installation,
    installationJars,
    readState,
    saveState,
    validateInstallation,
} from "./state.js";

export interface RestoreApplyOptions {
    dryRun?: boolean;
    offline?: boolean;
    mappings?: Record<string, string>;
    databases?: string[];
    signal?: AbortSignal;
}
const Hash = type(/^[a-f0-9]{64}$/);
const ChangeSchema = type({
    "+": "reject",
    target: "string > 0",
    before: Hash.or("null"),
    after: Hash.or("null"),
    kind: "'data' | 'jar' | 'database'",
});
const RestoreJournalSchema = type({
    "+": "reject",
    schemaVersion: "1",
    source: "string > 0",
    fingerprint: Hash,
    policyFingerprint: Hash,
    stateFingerprint: Hash,
    backupId: "string > 0",
    mappings: { "[string]": "string" },
    databases: "string[]",
    changes: ChangeSchema.array(),
    nextInstallationId: "string.uuid",
    createdAt: "string",
    phase: "'applying' | 'database' | 'applied'",
    completedDatabases: "string[]",
    "databaseInProgress?": "string",
});
type RestoreJournal = typeof RestoreJournalSchema.infer;
export type RestoreChange = typeof ChangeSchema.infer;
interface RestoreFile {
    source: string;
    target: string;
    sha256: string;
    size: number;
    mode: number;
    kind: RestoreChange["kind"];
}
export interface VerifiedRestore {
    metadata: BackupMetadata;
    installation: Installation;
    fingerprint: string;
    files: RestoreFile[];
    roots: { id: string; path: string; kind: "file" | "directory" }[];
    databases: {
        config: DatabaseBackupConfig;
        source: string;
        sha256: string;
        size: number;
    }[];
}
export interface PreparedRestoreApplication {
    source: string;
    fingerprint: string;
    policyFingerprint: string;
    stateFingerprint: string;
    changes: RestoreChange[];
    verified: VerifiedRestore;
    nextInstallationId: string;
    createdAt: string;
    options: RestoreApplyOptions;
}
export interface RestoreExecutionContext {
    /** The coordinator holds the shared workspace operation mutex for the full application. */
    operationLockHeld: true;
    preRestoreSnapshot: string;
    signal?: AbortSignal;
    checkpoint?: (stage: string) => Promise<void>;
}

function digest(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}
function pathKey(value: string): string {
    return path.resolve(value).normalize("NFC").toLowerCase();
}
function within(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (
        relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
    );
}
function policyFingerprint(
    project: ProjectContext,
    backup: BackupService,
): string {
    return digest({
        project: project.manifest.id ?? project.dir,
        files: backup.config.files,
        filePolicies: backup.filePolicies ?? null,
        databases: backup.config.databases ?? [],
        secrets: project.manifest.secrets ?? {},
    });
}
function protectedPaths(
    project: ProjectContext,
    source: string,
    backup: BackupService,
): string[] {
    return [
        project.home,
        source,
        ...["config", ".craflet", ".git", "imports", "craflet.yaml"].map(
            (name) => path.join(project.dir, name),
        ),
        ...[".craflet", "craflet-lock.yaml", "craflet-workspace.yaml"].map(
            (name) => path.join(project.lockRoot, name),
        ),
        ...Object.values(project.manifest.secrets ?? {}).flatMap((reference) =>
            "file" in reference
                ? [path.resolve(project.dir, reference.file)]
                : [],
        ),
        ...Object.values(backup.config.repositories ?? {}).map((repository) =>
            path.resolve(repository.path),
        ),
    ];
}

function backupIncludes(
    project: ProjectContext,
    backup: BackupService,
): (target: string) => boolean {
    const policies = (
        backup.filePolicies ?? [
            { baseDirectory: project.dir, files: backup.config.files },
        ]
    ).map((policy) => ({
        baseDirectory: policy.baseDirectory,
        select: createBackupSelector(policy.files),
    }));
    return (target) =>
        policies.some(
            (policy) =>
                policy.select(
                    path
                        .relative(policy.baseDirectory, target)
                        .split(path.sep)
                        .join("/"),
                    target.split(path.sep).join("/"),
                ).included,
        );
}
function assertDataTarget(
    project: ProjectContext,
    source: string,
    backup: BackupService,
    target: string,
): void {
    if (
        !path.isAbsolute(target) ||
        protectedPaths(project, source, backup).some((protectedPath) =>
            pathsOverlap(target, protectedPath),
        )
    )
        throw new CrafletError(
            "RESTORE_MAPPING",
            "A restored data target overlaps protected declarations, secrets, artifacts, repository or extraction files.",
            3,
        );
}
function inRoots(verified: VerifiedRestore, target: string): boolean {
    return verified.roots.some((root) =>
        root.kind === "file"
            ? pathKey(root.path) === pathKey(target)
            : within(root.path, target),
    );
}
function assertDistinctTargets(targets: readonly string[]): void {
    const keys = new Set<string>();
    for (const target of targets) {
        const key = pathKey(target);
        if (keys.has(key))
            throw new CrafletError(
                "RESTORE_COLLISION",
                "Multiple restored entries target the same file.",
                3,
            );
        keys.add(key);
    }
    for (const target of targets) {
        let parent = path.dirname(target);
        while (parent !== path.dirname(parent)) {
            if (keys.has(pathKey(parent)))
                throw new CrafletError(
                    "RESTORE_COLLISION",
                    "A restored file collides with another target's directory.",
                    3,
                );
            parent = path.dirname(parent);
        }
    }
}
async function currentHash(target: string): Promise<string | null> {
    await assertNoSymlinks(target);
    if (!(await exists(target))) return null;
    if (!(await lstat(target)).isFile())
        throw new CrafletError(
            "RESTORE_TARGET",
            "A restore target is not a regular file.",
            3,
        );
    return (await hashBackupFile(target)).sha256;
}
async function sqliteReady(target: string, source: string): Promise<void> {
    for (const suffix of ["-wal", "-shm", "-journal"])
        if (
            (await exists(`${target}${suffix}`)) ||
            (await exists(`${source}${suffix}`))
        )
            throw new CrafletError(
                "DATABASE_SQLITE_BUSY",
                "SQLite restore requires a cleanly closed target and a standalone verified dump without sidecar files.",
                3,
            );
    const { DatabaseSync } = await import("node:sqlite");
    let database: InstanceType<typeof DatabaseSync> | undefined;
    try {
        database = new DatabaseSync(source, {
            readOnly: true,
            allowExtension: false,
            timeout: 5000,
        });
        const result = database.prepare("PRAGMA quick_check").all();
        if (result.length !== 1 || Object.values(result[0] ?? {})[0] !== "ok")
            throw new Error("Invalid SQLite dump");
    } catch {
        throw new CrafletError(
            "DATABASE_SQLITE_CHECK",
            "The SQLite restore dump failed its integrity check.",
            3,
        );
    } finally {
        database?.close();
    }
}

export async function inspectBackupRestore(
    project: ProjectContext,
    directory: string,
    options: RestoreApplyOptions,
    backup: BackupService,
): Promise<VerifiedRestore> {
    const source = path.resolve(directory);
    await assertNoSymlinks(source);
    if (pathsOverlap(source, project.dir) || pathsOverlap(source, project.home))
        throw new CrafletError(
            "RESTORE_OVERLAP",
            "The extraction directory must be separate from the project and CRAFLET_HOME.",
            3,
        );
    if (await exists(path.join(source, ".craflet-restore-incomplete.json")))
        throw new CrafletError(
            "RESTORE_INCOMPLETE",
            "This extraction did not finish verification. Restore the snapshot again into an empty directory.",
            3,
        );
    const projectId =
        backup.config.projectId ??
        createHash("sha256")
            .update(path.resolve(project.dir))
            .digest("hex")
            .slice(0, 32);
    const metadataFile = await assertNoSymlinks(source, "metadata/backup.json");
    const activeFile = await assertNoSymlinks(source, "metadata/active.json");
    for (const [file, limit] of [
        [metadataFile, 64 * 1024 * 1024],
        [activeFile, 4 * 1024 * 1024],
    ] as const) {
        const info = await lstat(file);
        if (!info.isFile() || info.size > limit)
            throw new CrafletError(
                "RESTORE_METADATA",
                "Backup metadata exceeds its size limit or is not a regular file.",
                3,
            );
    }
    const metadata = validateBackupMetadata(
        await readJson<unknown>(metadataFile),
        projectId,
    );
    const active = await readJson<unknown>(activeFile);
    if (stableStringify(active) !== stableStringify(metadata.active))
        throw new CrafletError(
            "RESTORE_METADATA",
            "The extracted active metadata does not match its manifest.",
            3,
        );
    if (!metadata.active.installation)
        throw new CrafletError(
            "RESTORE_NO_INSTALLATION",
            "This snapshot has no known active JAR set. Its data can be extracted, but automatic production application is unsafe.",
            3,
        );
    const fingerprint = digest(metadata);
    const installation = validateInstallation(
        structuredClone(metadata.active.installation),
    );
    if (
        installation.manifest.id &&
        installation.manifest.id !== project.manifest.id
    )
        throw new CrafletError(
            "RESTORE_PROJECT",
            "The snapshot installation belongs to a different project.",
            3,
        );
    installationJars(installation);
    installation.config = await new NodeConfigManager(
        project.dir,
        installation.manifest.secrets,
    ).prepareRestoredBundle(
        installation.config,
        Boolean(
            installation.manifest.id &&
                installation.manifest.id === project.manifest.id,
        ),
    );
    const allowed = new Set([
        "metadata/backup.json",
        "metadata/active.json",
        ...metadata.files.map((file) => file.destination),
        ...metadata.databases.map((database) => database.file),
    ]);
    const actual = await listFiles(source);
    if (
        actual.length !== allowed.size ||
        actual.some((file) => !allowed.has(file))
    )
        throw new CrafletError(
            "RESTORE_CONTENTS",
            "The extracted backup contains missing or unexpected files.",
            3,
        );
    const mappings = options.mappings ?? {};
    for (const name of Object.keys(mappings))
        if (!metadata.roots.some((root) => root.id === name && root.external))
            throw new CrafletError(
                "RESTORE_MAPPING",
                "An additional-root mapping does not belong to this snapshot.",
                2,
            );
    const roots: VerifiedRestore["roots"] = [];
    for (const root of metadata.roots) {
        const base = root.external
            ? mappings[root.id]
            : path.join(project.dir, "runtime");
        if (
            !base &&
            root.external &&
            !metadata.files.some((file) =>
                file.destination.startsWith(`data/external/${root.id}/`),
            )
        )
            continue;
        if (!base || !path.isAbsolute(base))
            throw new CrafletError(
                "RESTORE_MAPPING",
                `Additional root ${root.id} requires an explicit absolute mapping. Snapshot source paths are never used as write targets.`,
                3,
            );
        const target = path.resolve(base);
        if (root.external) {
            assertDataTarget(project, source, backup, target);
            if (pathsOverlap(target, path.join(project.dir, "runtime")))
                throw new CrafletError(
                    "RESTORE_MAPPING",
                    "An additional data root cannot overlap the runtime root.",
                    3,
                );
        }
        if (roots.some((existing) => pathsOverlap(existing.path, target)))
            throw new CrafletError(
                "RESTORE_COLLISION",
                "Mapped restore roots overlap one another.",
                3,
            );
        await assertNoSymlinks(target);
        roots.push({ id: root.id, path: target, kind: root.kind });
    }
    const files: RestoreFile[] = [];
    for (const file of metadata.files) {
        options.signal?.throwIfAborted();
        const segments = file.destination.split("/");
        const external = segments[1] === "external";
        const root = roots.find(
            (candidate) =>
                candidate.id === (external ? segments[2] : "runtime"),
        );
        if (!root)
            throw new CrafletError(
                "RESTORE_ROOT",
                "A restored file has no mapped root.",
                3,
            );
        const suffix = segments.slice(external ? 3 : 2).join("/");
        validateBackupRelativePath(suffix);
        if (root.kind === "file" && suffix.includes("/"))
            throw new CrafletError(
                "RESTORE_ROOT",
                "A single-file root contains a nested path.",
                3,
            );
        const target =
            root.kind === "file" ? root.path : path.resolve(root.path, suffix);
        if (!within(root.path, target))
            throw new CrafletError(
                "RESTORE_MAPPING",
                "A restore file leaves its mapped root.",
                3,
            );
        assertDataTarget(project, source, backup, target);
        await assertNoSymlinks(target);
        const payload = await assertNoSymlinks(source, file.destination);
        const integrity = await hashBackupFile(payload);
        if (integrity.sha256 !== file.sha256 || integrity.bytes !== file.size)
            throw new CrafletError(
                "RESTORE_HASH",
                "A restored data file failed size or SHA-256 verification.",
                3,
            );
        files.push({
            source: payload,
            target,
            sha256: file.sha256,
            size: file.size,
            mode: file.mode,
            kind: "data",
        });
    }
    const databases: VerifiedRestore["databases"] = [];
    for (const dump of metadata.databases) {
        if (!options.databases?.includes(dump.id))
            throw new CrafletError(
                "RESTORE_DATABASE",
                `Explicitly confirm database ${dump.id} before applying it.`,
                3,
            );
        const config = backup.config.databases?.find(
            (entry) => entry.id === dump.id && entry.kind === dump.kind,
        );
        if (!config)
            throw new CrafletError(
                "RESTORE_DATABASE",
                "A database dump does not match a currently configured target.",
                3,
            );
        const payload = await assertNoSymlinks(source, dump.file);
        const integrity = await hashBackupFile(payload);
        if (integrity.sha256 !== dump.sha256 || integrity.bytes !== dump.bytes)
            throw new CrafletError(
                "RESTORE_HASH",
                "A database dump failed size or SHA-256 verification.",
                3,
            );
        databases.push({
            config,
            source: payload,
            sha256: dump.sha256,
            size: dump.bytes,
        });
        if (config.kind === "sqlite") {
            const target = path.resolve(project.dir, config.path);
            assertDataTarget(project, source, backup, target);
            await assertNoSymlinks(target);
        }
    }
    for (const id of options.databases ?? [])
        if (!metadata.databases.some((entry) => entry.id === id))
            throw new CrafletError(
                "RESTORE_DATABASE",
                "A selected database does not exist in this snapshot.",
                2,
            );
    assertDistinctTargets([
        ...files.map((file) => file.target),
        ...[...installationJars(installation).keys()].map((relative) =>
            path.join(project.dir, "runtime", relative),
        ),
        ...databases.flatMap((item) =>
            item.config.kind === "sqlite"
                ? [path.resolve(project.dir, item.config.path)]
                : [],
        ),
    ]);
    return {
        metadata,
        installation,
        fingerprint,
        files,
        roots,
        databases,
    };
}

async function sourcesFor(
    project: ProjectContext,
    verified: VerifiedRestore,
    store: ArtifactStore,
    options: RestoreApplyOptions,
): Promise<RestoreFile[]> {
    const files = [...verified.files];
    for (const [relative, artifact] of installationJars(
        verified.installation,
    )) {
        const source = options.dryRun
            ? ""
            : await store.ensure(
                  artifact,
                  artifactContext(
                      { ...project, manifest: verified.installation.manifest },
                      options,
                  ),
              );
        if (source) {
            const integrity = await hashBackupFile(
                await assertNoSymlinks(source),
            );
            if (
                integrity.sha256 !== artifact.sha256 ||
                integrity.bytes !== artifact.size
            )
                throw new CrafletError(
                    "RESTORE_HASH",
                    "A locked JAR is unavailable at its exact checksum and size.",
                    3,
                );
        }
        files.push({
            source,
            target: path.join(project.dir, "runtime", relative),
            sha256: artifact.sha256,
            size: artifact.size,
            mode: 0o600,
            kind: "jar",
        });
    }
    for (const item of verified.databases)
        if (item.config.kind === "sqlite") {
            const target = path.resolve(project.dir, item.config.path);
            await sqliteReady(target, item.source);
            files.push({
                source: item.source,
                target,
                sha256: item.sha256,
                size: item.size,
                mode: 0o600,
                kind: "database",
            });
        }
    assertDistinctTargets(files.map((file) => file.target));
    return files;
}
export async function verifyRuntimeJars(
    project: ProjectContext,
    next: Installation,
): Promise<void> {
    const state = await readState(project.dir);
    const known = installationJars(state.active ?? next);
    const nextJars = installationJars(next);
    assertDistinctTargets(
        [...new Set([...known.keys(), ...nextJars.keys()])].map((relative) =>
            path.join(project.dir, "runtime", relative),
        ),
    );
    for (const relative of await listFiles(
        path.join(project.dir, "runtime/plugins"),
    ))
        if (/^[^/]+\.jar$/i.test(relative) && !known.has(`plugins/${relative}`))
            throw new CrafletError(
                "UNMANAGED_JAR",
                "Import unmanaged runtime JARs before applying a backup.",
                3,
            );
    for (const [relative, artifact] of known) {
        const current = await currentHash(
            path.join(project.dir, "runtime", relative),
        );
        if (current !== null && current !== artifact.sha256)
            throw new CrafletError(
                "RUNTIME_JAR_DRIFT",
                "A runtime JAR was modified outside Craflet; refusing to overwrite it.",
                3,
            );
    }
}

/** Coordinator calls this after stopping all writers, before its pre-restore backup. */
export async function prepareRestoreApplication(
    project: ProjectContext,
    directory: string,
    options: RestoreApplyOptions,
    store: ArtifactStore,
    backup: BackupService,
): Promise<PreparedRestoreApplication> {
    if (!options.dryRun)
        assertStopped(
            (await new NodeServerController(project.dir, project.home).status())
                .status,
        );
    const verified = await inspectBackupRestore(
        project,
        directory,
        options,
        backup,
    );
    await verifyRuntimeJars(project, verified.installation);
    const sources = await sourcesFor(project, verified, store, options);
    if (!options.dryRun)
        await new NodeDatabaseBackupAdapter(
            project.dir,
            project.home,
        ).preflightRestore(
            verified.databases.map((item) => item.config),
            options.signal,
        );
    const state = await readState(project.dir);
    const plan = await backup.plan();
    const backedUp = new Set(plan.files.map((file) => pathKey(file.source)));
    const keep = new Set(sources.map((file) => pathKey(file.target)));
    const changes: RestoreChange[] = [];
    const selected = backupIncludes(project, backup);
    for (const file of sources) {
        const before = await currentHash(file.target);
        if (
            file.kind === "data" &&
            before !== null &&
            (!selected(file.target) || !backedUp.has(pathKey(file.target)))
        )
            throw new CrafletError(
                "RESTORE_UNPROTECTED_TARGET",
                "An existing restore target is excluded by the current backup policy. Include it in the pre-restore backup before replacing it.",
                3,
            );
        changes.push({
            target: file.target,
            before,
            after: file.sha256,
            kind: file.kind,
        });
    }
    for (const file of plan.files) {
        if (
            keep.has(pathKey(file.source)) ||
            !inRoots(verified, file.source) ||
            /\.jar$/i.test(file.source)
        )
            continue;
        assertDataTarget(project, path.resolve(directory), backup, file.source);
        const before = await currentHash(file.source);
        if (before !== null)
            changes.push({
                target: path.resolve(file.source),
                before,
                after: null,
                kind: "data",
            });
    }
    for (const [relative] of installationJars(state.active ?? null)) {
        const target = path.join(project.dir, "runtime", relative);
        if (keep.has(pathKey(target))) continue;
        const before = await currentHash(target);
        if (before !== null)
            changes.push({ target, before, after: null, kind: "jar" });
    }
    assertDistinctTargets(changes.map((change) => change.target));
    changes.sort((first, second) =>
        pathKey(first.target).localeCompare(pathKey(second.target), "en"),
    );
    return {
        source: path.resolve(directory),
        fingerprint: verified.fingerprint,
        policyFingerprint: policyFingerprint(project, backup),
        stateFingerprint: digest(state),
        changes,
        verified,
        nextInstallationId: randomUUID(),
        createdAt: new Date().toISOString(),
        options: {
            ...options,
            mappings: { ...options.mappings },
            databases: [...(options.databases ?? [])],
        },
    };
}

async function validateChanges(
    project: ProjectContext,
    verified: VerifiedRestore,
    journal: RestoreJournal,
    sources: RestoreFile[],
    backup: BackupService,
    recovering: boolean,
): Promise<void> {
    if (
        journal.policyFingerprint !== policyFingerprint(project, backup) ||
        journal.fingerprint !== verified.fingerprint
    )
        throw new CrafletError(
            "RESTORE_CHANGED",
            "The extraction or restore policy changed after planning; no files were modified.",
            4,
        );
    assertDistinctTargets(journal.changes.map((change) => change.target));
    const sourceMap = new Map(
        sources.map((file) => [pathKey(file.target), file]),
    );
    const seen = new Set<string>();
    const select = backupIncludes(project, backup);
    const runtime = path.join(project.dir, "runtime");
    const state = await readState(project.dir);
    const appliedState =
        state.active?.id === journal.nextInstallationId &&
        !state.pending &&
        stableStringify(state.active.lock) ===
            stableStringify(verified.installation.lock);
    const previousJars = installationJars(state.active ?? null);
    for (const change of journal.changes) {
        if (
            !path.isAbsolute(change.target) ||
            path.resolve(change.target) !== change.target ||
            (change.before === null && change.after === null)
        )
            throw new CrafletError(
                "RESTORE_JOURNAL",
                "A restore journal target is invalid.",
                4,
            );
        const expected = sourceMap.get(pathKey(change.target));
        if (change.after !== null) {
            if (
                !expected ||
                expected.kind !== change.kind ||
                expected.sha256 !== change.after
            )
                throw new CrafletError(
                    "RESTORE_JOURNAL",
                    "Restore writes do not match the verified snapshot.",
                    4,
                );
            seen.add(pathKey(change.target));
        } else if (change.kind === "data") {
            assertDataTarget(project, journal.source, backup, change.target);
            if (
                !inRoots(verified, change.target) ||
                /\.jar$/i.test(change.target) ||
                !select(change.target)
            )
                throw new CrafletError(
                    "RESTORE_JOURNAL",
                    "A restore deletion leaves its approved data scope.",
                    4,
                );
        } else if (change.kind === "jar") {
            const relative = path
                .relative(runtime, change.target)
                .split(path.sep)
                .join("/");
            if (
                !/^plugins\/[A-Za-z0-9_.-]+\.jar$/.test(relative) ||
                sourceMap.has(pathKey(change.target)) ||
                (!appliedState &&
                    previousJars.get(relative)?.sha256 !== change.before)
            )
                throw new CrafletError(
                    "RESTORE_JOURNAL",
                    "A removed JAR has an invalid target.",
                    4,
                );
            portablePluginJarName(relative.slice("plugins/".length, -4));
        } else
            throw new CrafletError(
                "RESTORE_JOURNAL",
                "Database deletion is not a supported restore operation.",
                4,
            );
        const current = await currentHash(change.target);
        if (appliedState && current !== change.after)
            throw new CrafletError(
                "RESTORE_CONFLICT",
                "Restored files changed after installation bookkeeping was saved.",
                4,
            );
        if (
            current !== change.before &&
            !(recovering && current === change.after)
        )
            throw new CrafletError(
                "RESTORE_CONFLICT",
                "A restore target was edited outside this application; all remaining targets were retained.",
                4,
            );
    }
    if (seen.size !== sourceMap.size)
        throw new CrafletError(
            "RESTORE_JOURNAL",
            "The restore journal omits a snapshot target.",
            4,
        );
    const jarTargets = new Set(
        journal.changes
            .filter((change) => change.kind === "jar")
            .map((change) => pathKey(change.target)),
    );
    for (const file of await listFiles(path.join(runtime, "plugins")))
        if (
            /^[^/]+\.jar$/i.test(file) &&
            !jarTargets.has(pathKey(path.join(runtime, "plugins", file)))
        )
            throw new CrafletError(
                "UNMANAGED_JAR",
                "An unmanaged JAR appeared after restore planning; it was not overwritten.",
                4,
            );
    if (
        digest(state) !== journal.stateFingerprint &&
        !(recovering && appliedState)
    )
        throw new CrafletError(
            "RESTORE_CONFLICT",
            "Installation state changed outside the restore operation.",
            4,
        );
    if (journal.phase === "applied" && !appliedState)
        throw new CrafletError(
            "RESTORE_CONFLICT",
            "Completed restore bookkeeping does not match the installation state.",
            4,
        );
}
async function copyVerified(
    source: string,
    destination: string,
    expectedHash: string,
    before: string | null,
    mode: number,
): Promise<void> {
    await assertNoSymlinks(source);
    await assertNoSymlinks(destination);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(
        path.dirname(destination),
        `.craflet-restore-${randomUUID()}.tmp`,
    );
    try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        if ((await hashBackupFile(temporary)).sha256 !== expectedHash)
            throw new CrafletError(
                "RESTORE_HASH",
                "A restore source changed after verification.",
                3,
            );
        await chmod(temporary, mode & 0o600 || 0o600);
        if ((await currentHash(destination)) !== before)
            throw new CrafletError(
                "RESTORE_CONFLICT",
                "A restore target changed while its replacement was being copied.",
                4,
            );
        await assertNoSymlinks(destination);
        await rename(temporary, destination);
    } finally {
        await rm(temporary, { force: true });
    }
}
async function applyJournal(
    project: ProjectContext,
    verified: VerifiedRestore,
    journal: RestoreJournal,
    sources: RestoreFile[],
    execution: RestoreExecutionContext,
): Promise<void> {
    assertStopped(
        (await new NodeServerController(project.dir, project.home).status())
            .status,
    );
    const journalFile = await assertNoSymlinks(
        project.dir,
        ".craflet/restore.json",
    );
    const sourceMap = new Map(
        sources.map((file) => [pathKey(file.target), file]),
    );
    for (const change of journal.changes) {
        execution.signal?.throwIfAborted();
        const current = await currentHash(change.target);
        if (current !== change.before && current !== change.after)
            throw new CrafletError(
                "RESTORE_CONFLICT",
                "A restore target changed during application.",
                4,
            );
        if (current !== change.after) {
            if (change.after === null)
                await rm(await assertNoSymlinks(change.target), {
                    force: true,
                });
            else {
                const source = sourceMap.get(pathKey(change.target));
                if (!source)
                    throw new CrafletError(
                        "RESTORE_JOURNAL",
                        "A restore source is missing.",
                        4,
                    );
                if (change.kind === "database")
                    await sqliteReady(change.target, source.source);
                await copyVerified(
                    source.source,
                    change.target,
                    change.after,
                    current,
                    source.mode,
                );
            }
        }
        await execution.checkpoint?.(`file:${change.target}`);
    }
    const sql = verified.databases.filter(
        (item) => item.config.kind !== "sqlite",
    );
    const database = new NodeDatabaseBackupAdapter(project.dir, project.home);
    for (const item of sql) {
        if (journal.completedDatabases.includes(item.config.id)) continue;
        execution.signal?.throwIfAborted();
        const integrity = await hashBackupFile(
            await assertNoSymlinks(item.source),
        );
        if (integrity.sha256 !== item.sha256 || integrity.bytes !== item.size)
            throw new CrafletError(
                "RESTORE_HASH",
                "A database dump changed after verification.",
                3,
            );
        journal.phase = "database";
        journal.databaseInProgress = item.config.id;
        await writeJson(journalFile, journal);
        await execution.checkpoint?.(`database:${item.config.id}:begin`);
        await database.restore(item.config, item.source, {
            confirm: true,
            ...(execution.signal ? { signal: execution.signal } : {}),
        });
        journal.completedDatabases.push(item.config.id);
        journal.phase = "applying";
        delete journal.databaseInProgress;
        await writeJson(journalFile, journal);
        await execution.checkpoint?.(`database:${item.config.id}:complete`);
    }
    await saveState(project.dir, {
        schemaVersion: 1,
        active: {
            ...verified.installation,
            id: journal.nextInstallationId,
            createdAt: journal.createdAt,
        },
    });
    journal.phase = "applied";
    await writeJson(journalFile, journal);
    await execution.checkpoint?.("applied");
    await rm(journalFile);
}

/** The caller owns the workspace mutex and has already saved its single/group pre-restore backup. */
export async function executePreparedRestore(
    project: ProjectContext,
    prepared: PreparedRestoreApplication,
    store: ArtifactStore,
    backup: BackupService,
    execution: RestoreExecutionContext,
): Promise<void> {
    if (execution.operationLockHeld !== true || !execution.preRestoreSnapshot)
        throw new CrafletError(
            "RESTORE_CONTEXT",
            "Restore execution requires a held operation lock and a completed pre-restore backup.",
            4,
        );
    assertStopped(
        (await new NodeServerController(project.dir, project.home).status())
            .status,
    );
    const file = await assertNoSymlinks(project.dir, ".craflet/restore.json");
    if (await exists(file))
        throw new CrafletError(
            "RECOVERY_REQUIRED",
            "Recover the previous restore before applying another one.",
            4,
        );
    const verified = await inspectBackupRestore(
        project,
        prepared.source,
        prepared.options,
        backup,
    );
    const sources = await sourcesFor(project, verified, store, {
        offline: true,
        ...(execution.signal ? { signal: execution.signal } : {}),
    });
    const journal: RestoreJournal = {
        schemaVersion: 1,
        source: prepared.source,
        fingerprint: prepared.fingerprint,
        policyFingerprint: prepared.policyFingerprint,
        stateFingerprint: prepared.stateFingerprint,
        backupId: execution.preRestoreSnapshot,
        mappings: prepared.options.mappings ?? {},
        databases: prepared.options.databases ?? [],
        changes: prepared.changes,
        nextInstallationId: prepared.nextInstallationId,
        createdAt: prepared.createdAt,
        phase: "applying",
        completedDatabases: [],
    };
    await validateChanges(project, verified, journal, sources, backup, false);
    await writeJson(file, journal);
    try {
        await applyJournal(project, verified, journal, sources, execution);
    } catch {
        throw new CrafletError(
            "RESTORE_INTERRUPTED",
            "Restore application interrupted; all servers remain stopped. Run recover to resume verified file changes. If SQL import started, use the recorded pre-restore snapshot and review the database before retrying.",
            4,
        );
    }
}

export async function applyBackupRestore(
    project: ProjectContext,
    directory: string,
    options: RestoreApplyOptions,
    store: ArtifactStore,
    backup: BackupService,
    runnerEntry?: string,
): Promise<unknown> {
    if (project.manifest.backup?.group)
        throw new CrafletError(
            "RESTORE_GROUP",
            "A recovery group must be restored as a complete group; do not apply one member separately.",
            3,
        );
    const verified = await inspectBackupRestore(
        project,
        directory,
        options,
        backup,
    );
    const preview = {
        project: project.manifest.name,
        files: verified.files.map((file) => file.target),
        databases: verified.databases.map((item) => item.config.id),
        startAfterApply: false,
        sharedLockUnchanged: true,
    };
    if (options.dryRun) {
        const prepared = await prepareRestoreApplication(
            project,
            directory,
            options,
            store,
            backup,
        );
        return {
            ...preview,
            changes: prepared.changes,
            unresolved: [
                "Exact JAR cache availability and live database clients are checked before application.",
            ],
        };
    }
    return withMutex(
        path.join(project.lockRoot, ".craflet/operation.lock"),
        async () => {
            for (const target of [
                path.join(project.dir, ".craflet/restore.json"),
                path.join(project.dir, ".craflet/deploy.json"),
                path.join(project.dir, ".craflet/import-incomplete.json"),
                path.join(
                    project.lockRoot,
                    ".craflet/manifest-transaction.json",
                ),
                path.join(project.lockRoot, ".craflet/group-operation.json"),
                path.join(project.lockRoot, ".craflet/group-restore.json"),
            ])
                if (await exists(target))
                    throw new CrafletError(
                        "RECOVERY_REQUIRED",
                        "Recover the interrupted operation before applying another backup.",
                        4,
                    );
            const controller = new NodeServerController(
                project.dir,
                project.home,
                runnerEntry,
                options.signal,
            );
            const before = await controller.status();
            if (before.status !== "running") assertStopped(before.status);
            await verifyRuntimeJars(project, verified.installation);
            for (const artifact of installationJars(
                verified.installation,
            ).values())
                await store.ensure(
                    artifact,
                    artifactContext(
                        {
                            ...project,
                            manifest: verified.installation.manifest,
                        },
                        options,
                    ),
                );
            await backup.prepare({
                offline: options.offline ?? false,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            await backup.preflight(
                options.signal ? { signal: options.signal } : {},
            );
            await new NodeDatabaseBackupAdapter(
                project.dir,
                project.home,
            ).preflightRestore(
                verified.databases.map((item) => item.config),
                options.signal,
            );
            if (before.status === "running") await controller.stop();
            assertStopped((await controller.status()).status);
            const prepared = await prepareRestoreApplication(
                project,
                directory,
                options,
                store,
                backup,
            );
            if (prepared.fingerprint !== verified.fingerprint)
                throw new CrafletError(
                    "RESTORE_CHANGED",
                    "The extracted backup changed during preflight.",
                    3,
                );
            const saved = await backup.create(
                { installation: (await readState(project.dir)).active ?? null },
                options.signal ? { signal: options.signal } : {},
            );
            await executePreparedRestore(project, prepared, store, backup, {
                operationLockHeld: true,
                preRestoreSnapshot: saved.snapshotId,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            return {
                ...preview,
                preRestoreSnapshot: saved.snapshotId,
                applied: true,
                pendingDiscarded: true,
            };
        },
    );
}

export async function recoverBackupRestore(
    project: ProjectContext,
    store: ArtifactStore,
    backup: BackupService,
    dryRun = false,
    execution?: { operationLockHeld: true; signal?: AbortSignal },
): Promise<boolean> {
    const file = await assertNoSymlinks(project.dir, ".craflet/restore.json");
    if (!(await exists(file))) return false;
    const perform = async () => {
        assertStopped(
            (await new NodeServerController(project.dir, project.home).status())
                .status,
        );
        await assertNoSymlinks(project.dir, ".craflet/restore.json");
        if (!(await exists(file))) return false;
        if ((await lstat(file)).size > 128 * 1024 * 1024)
            throw new CrafletError(
                "RESTORE_JOURNAL",
                "Restore journal exceeds its size limit.",
                4,
            );
        let raw: unknown;
        try {
            raw = await readJson<unknown>(file);
        } catch {
            throw new CrafletError(
                "RESTORE_JOURNAL",
                "Unreadable restore journal; input values are omitted.",
                4,
            );
        }
        const journal = RestoreJournalSchema(raw);
        if (
            journal instanceof type.errors ||
            Array.isArray(journal.mappings) ||
            journal.changes.length > 250100
        )
            throw new CrafletError(
                "RESTORE_JOURNAL",
                "Invalid restore journal; automatic recovery is disabled.",
                4,
            );
        if (journal.phase === "database")
            throw new CrafletError(
                "RESTORE_DATABASE_RECOVERY",
                "SQL restoration may have partially completed. Keep all writers stopped and recover from the recorded pre-restore snapshot; automatic SQL re-execution is disabled.",
                4,
            );
        const options: RestoreApplyOptions = {
            mappings: journal.mappings,
            databases: journal.databases,
            offline: true,
            ...(execution?.signal ? { signal: execution.signal } : {}),
        };
        const verified = await inspectBackupRestore(
            project,
            journal.source,
            options,
            backup,
        );
        const sqlIds = new Set(
            verified.databases
                .filter((item) => item.config.kind !== "sqlite")
                .map((item) => item.config.id),
        );
        if (
            new Set(journal.completedDatabases).size !==
                journal.completedDatabases.length ||
            journal.completedDatabases.some((id) => !sqlIds.has(id)) ||
            journal.databaseInProgress !== undefined ||
            (journal.phase === "applied" &&
                journal.completedDatabases.length !== sqlIds.size)
        )
            throw new CrafletError(
                "RESTORE_JOURNAL",
                "Invalid database progress in restore journal.",
                4,
            );
        const sources = await sourcesFor(project, verified, store, {
            ...options,
            ...(dryRun ? { dryRun: true } : {}),
        });
        await validateChanges(
            project,
            verified,
            journal,
            sources,
            backup,
            true,
        );
        if (dryRun) return true;
        const remainingSql = verified.databases.filter(
            (item) =>
                item.config.kind !== "sqlite" &&
                !journal.completedDatabases.includes(item.config.id),
        );
        if (remainingSql.length)
            await new NodeDatabaseBackupAdapter(
                project.dir,
                project.home,
            ).preflightRestore(
                remainingSql.map((item) => item.config),
                execution?.signal,
            );
        if (journal.phase === "applied") {
            for (const change of journal.changes)
                if ((await currentHash(change.target)) !== change.after)
                    throw new CrafletError(
                        "RESTORE_CONFLICT",
                        "An applied restore target changed before recovery bookkeeping completed.",
                        4,
                    );
            await rm(file);
        } else
            await applyJournal(project, verified, journal, sources, {
                operationLockHeld: true,
                preRestoreSnapshot: journal.backupId,
                ...(execution?.signal ? { signal: execution.signal } : {}),
            });
        return true;
    };
    return dryRun || execution?.operationLockHeld
        ? perform()
        : withMutex(
              path.join(project.lockRoot, ".craflet/operation.lock"),
              perform,
          );
}
