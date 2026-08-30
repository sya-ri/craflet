import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    readdir,
    rename,
    rm,
} from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactStore,
    assertStopped,
    type BackupService,
    CrafleetError,
    coldBackup,
    diagnosticsFailed,
    type LifecyclePorts,
    restartServer,
    startServer,
} from "@crafleet/core";
import { NodeServerController } from "../runtime/controller.js";
import { inspectJava } from "../runtime/java.js";
import { checkBackupSpace } from "./backup-files.js";
import { NodeConfigManager } from "./config.js";
import {
    ensureRuntimeEulaConsent,
    hasAcceptedEula,
    type OwnedEulaOperationJournal,
} from "./eula.js";
import type { RequestEulaConsent } from "./eula-consent.js";
import { artifactContext } from "./installations.js";
import {
    assertNoSymlinks,
    exists,
    listFiles,
    readJson,
    withMutex,
    writeJson,
} from "./io.js";
import { hasRecoveryJournal, type ProjectContext } from "./projects.js";
import {
    type Installation,
    installationJars as jars,
    readState,
    saveState,
    validateInstallation,
} from "./state.js";

interface DeployJournal {
    schemaVersion: 1;
    phase: "applying" | "applied";
    previous: Installation | null;
    next: Installation;
    createdJars: string[];
}
interface JarProbe {
    hashes: Map<string, string | null>;
    createdJars: string[];
}

async function jarHash(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file))
        hash.update(chunk as Buffer);
    return hash.digest("hex");
}
export class NodeDeploymentManager {
    readonly controller: NodeServerController;
    constructor(
        readonly context: ProjectContext,
        readonly artifacts: ArtifactStore,
        readonly backupService?: BackupService,
        runnerEntry?: string,
        readonly checkpoint?: (stage: string) => Promise<void>,
        readonly options: {
            offline?: boolean;
            signal?: AbortSignal;
            requestEulaConsent?: RequestEulaConsent;
        } = {},
    ) {
        this.controller = new NodeServerController(
            context.dir,
            context.home,
            runnerEntry,
            this.options.signal,
        );
    }

    private config(installation?: Installation): NodeConfigManager {
        return new NodeConfigManager(
            this.context.dir,
            (installation?.manifest ?? this.context.manifest).secrets,
        );
    }
    private get journalFile(): string {
        return path.join(this.context.dir, ".crafleet/deploy.json");
    }
    private async prepareEula(
        candidate: Installation,
        applyPending: boolean,
        materialize: boolean,
        ownedJournal?: OwnedEulaOperationJournal,
    ): Promise<void> {
        if (candidate.manifest.server.type !== "paper") return;
        if (!materialize && applyPending) {
            const staged = candidate.config.files.find(
                (file) => file.relative === "eula.txt",
            );
            if (staged !== undefined) {
                if (!hasAcceptedEula(staged.content ?? ""))
                    throw new CrafleetError(
                        "EULA_MANAGED",
                        "The pending eula.txt does not record acceptance, so it cannot be changed implicitly during launch.",
                        3,
                        "Update config/eula.txt explicitly and run crafleet install, or remove that managed file and rebuild pending.",
                    );
                return;
            }
        }
        await ensureRuntimeEulaConsent(
            { ...this.context, manifest: candidate.manifest },
            this.options.requestEulaConsent,
            this.options.signal,
            materialize,
            ownedJournal,
        );
    }
    async plan() {
        const state = await readState(this.context.dir);
        return {
            status: await this.controller.status(),
            active: state.active?.id ?? null,
            pending: state.pending?.id ?? null,
            plugins: state.pending
                ? Object.keys(state.pending.lock.plugins)
                : [],
            configuration:
                state.pending?.config.files.map((file) => file.relative) ?? [],
            recoveryRequired: await exists(this.journalFile),
        };
    }
    private async needsBackup(
        active: Installation | undefined,
    ): Promise<boolean> {
        if (active) return true;
        return (await listFiles(path.join(this.context.dir, "runtime"))).some(
            (file) => file !== "eula.txt",
        );
    }
    async preflight(applyPending: boolean, launch = true): Promise<void> {
        this.options.signal?.throwIfAborted();
        if (await hasRecoveryJournal(this.context))
            throw new CrafleetError(
                "RECOVERY_REQUIRED",
                "An interrupted operation must be recovered first.",
                4,
            );
        const state = await readState(this.context.dir);
        const candidate = applyPending ? state.pending : state.active;
        if (!candidate)
            throw new CrafleetError(
                "NOT_INSTALLED",
                "No prepared installation. Run crafleet install first.",
                3,
            );
        await this.probeJars(
            candidate,
            applyPending ? (state.active ?? null) : candidate,
        );
        await assertNoSymlinks(this.context.dir, "runtime/plugins");
        if (applyPending) {
            const bytes = (installation: Installation | null) =>
                [...jars(installation).values()].reduce(
                    (total, artifact) => total + artifact.size,
                    0,
                );
            const required = Math.max(
                bytes(candidate),
                bytes(state.active ?? null),
            );
            if (!Number.isSafeInteger(required))
                throw new CrafleetError(
                    "RUNTIME_SPACE",
                    "The prepared JAR set exceeds safely measurable runtime capacity.",
                    3,
                );
            try {
                // Runtime may be on a different volume from the cache and restic
                // staging directory. Allow a conservative full copy plus margin.
                await checkBackupSpace(
                    await assertNoSymlinks(this.context.dir, "runtime"),
                    required,
                );
            } catch (error) {
                if (
                    error instanceof CrafleetError &&
                    error.code === "BACKUP_SPACE"
                )
                    throw new CrafleetError(
                        "RUNTIME_SPACE",
                        "Insufficient free space on the runtime volume for JAR staging and rollback copies.",
                        3,
                    );
                throw error;
            }
        }
        const java = await inspectJava(candidate.manifest);
        if (diagnosticsFailed(java.diagnostics))
            throw new CrafleetError(
                "JAVA_UNSUITABLE",
                "Java is unavailable or incompatible. Run crafleet doctor.",
                3,
            );
        if (applyPending && (await this.needsBackup(state.active))) {
            if (!this.backupService)
                throw new CrafleetError(
                    "BACKUP_REQUIRED",
                    "Configure a backup repository before applying changes to existing data.",
                    3,
                    "Run crafleet backup setup.",
                );
            await this.backupService.prepare(this.options);
            await this.backupService.preflight(
                this.options.signal ? { signal: this.options.signal } : {},
            );
        }
        const context = artifactContext(
            { ...this.context, manifest: candidate.manifest },
            this.options,
        );
        for (const artifact of [
            candidate.lock.server,
            ...Object.values(candidate.lock.plugins),
        ])
            await this.artifacts.ensure(artifact, context);
        if (launch) await this.prepareEula(candidate, applyPending, false);
    }
    async backupActive(): Promise<unknown> {
        const state = await readState(this.context.dir);
        if (!(await this.needsBackup(state.active))) return undefined;
        assertStopped((await this.controller.status()).status);
        if (!this.backupService)
            throw new CrafleetError(
                "BACKUP_REQUIRED",
                "A backup repository is required.",
                3,
            );
        return this.backupService.create(
            { installation: state.active ?? null },
            this.options.signal ? { signal: this.options.signal } : {},
        );
    }
    private async runtimeJar(relative: string): Promise<string | null> {
        const file = await assertNoSymlinks(
            path.join(this.context.dir, "runtime"),
            relative,
        );
        if (!(await exists(file))) return null;
        if (!(await lstat(file)).isFile())
            throw new CrafleetError(
                "JAR_TYPE",
                "A managed JAR target is not a regular file.",
                3,
            );
        return jarHash(file);
    }

    /** Read every target before the journal or any runtime mutation is created. */
    private async probeJars(
        installation: Installation,
        previous: Installation | null,
        recovering = false,
    ): Promise<JarProbe> {
        const runtime = path.join(this.context.dir, "runtime");
        await assertNoSymlinks(runtime, "plugins");
        const next = jars(installation);
        const old = jars(previous);
        const targets = [...new Set([...next.keys(), ...old.keys()])];
        if (
            new Set(targets.map((relative) => relative.toLowerCase())).size !==
            targets.length
        )
            throw new CrafleetError(
                "JAR_PATH",
                "Installation changes a JAR filename only by letter case; import it explicitly before deploying.",
                3,
            );
        if (await exists(path.join(runtime, "plugins"))) {
            for (const entry of await readdir(path.join(runtime, "plugins"))) {
                if (
                    entry.toLowerCase().endsWith(".jar") &&
                    !next.has(`plugins/${entry}`) &&
                    !old.has(`plugins/${entry}`)
                )
                    throw new CrafleetError(
                        "UNMANAGED_JAR",
                        "An unmanaged plugin JAR exists; import it before applying.",
                        3,
                    );
            }
        }
        const hashes = new Map<string, string | null>();
        const createdJars: string[] = [];
        for (const relative of targets) {
            const current = await this.runtimeJar(relative);
            hashes.set(relative, current);
            const before = old.get(relative);
            const after = next.get(relative);
            if (recovering) {
                if (
                    current !== null &&
                    current !== before?.sha256 &&
                    current !== after?.sha256
                )
                    throw new CrafleetError(
                        "JAR_DRIFT",
                        "Runtime JARs changed outside the interrupted deployment; recovery requires review.",
                        4,
                    );
            } else if (before) {
                if (current !== before.sha256)
                    throw new CrafleetError(
                        "JAR_DRIFT",
                        "An active JAR is missing or changed outside Crafleet; import or restore it before deploying.",
                        3,
                    );
            } else if (
                current !== null &&
                (previous !== null || current !== after?.sha256)
            ) {
                throw new CrafleetError(
                    "UNMANAGED_JAR",
                    "An existing JAR has the target filename but different content; import it before applying.",
                    3,
                );
            }
            if (after && current === null) createdJars.push(relative);
        }
        return { hashes, createdJars };
    }

    private async replaceJars(
        installation: Installation,
        remove: Installation | null,
        expected: ReadonlyMap<string, string | null>,
    ): Promise<void> {
        const runtime = path.join(this.context.dir, "runtime");
        await assertNoSymlinks(runtime, "plugins");
        await mkdir(path.join(runtime, "plugins"), { recursive: true });
        const next = jars(installation);
        const previous = jars(remove);
        for (const [relative, artifact] of next) {
            this.options.signal?.throwIfAborted();
            const current = await this.runtimeJar(relative);
            if (current !== expected.get(relative))
                throw new CrafleetError(
                    "JAR_DRIFT",
                    "Runtime JARs changed after deployment preflight.",
                    3,
                );
            if (current !== artifact.sha256) {
                const source = await this.artifacts.ensure(
                    artifact,
                    artifactContext(
                        { ...this.context, manifest: installation.manifest },
                        {
                            offline: true,
                            ...(this.options.signal
                                ? { signal: this.options.signal }
                                : {}),
                        },
                    ),
                );
                const target = await assertNoSymlinks(runtime, relative);
                const temporary = path.join(
                    path.dirname(target),
                    `.crafleet-${randomUUID()}.tmp`,
                );
                try {
                    await copyFile(source, temporary);
                    await chmod(temporary, 0o600);
                    if ((await jarHash(temporary)) !== artifact.sha256)
                        throw new CrafleetError(
                            "ARTIFACT_HASH",
                            "The staged JAR does not match its locked checksum.",
                            3,
                        );
                    if ((await this.runtimeJar(relative)) !== current)
                        throw new CrafleetError(
                            "JAR_DRIFT",
                            "Runtime JARs changed before replacement.",
                            3,
                        );
                    await rename(temporary, target);
                } finally {
                    await rm(temporary, { force: true });
                }
            }
            await this.checkpoint?.(`jar:${relative}`);
        }
        for (const relative of previous.keys())
            if (!next.has(relative)) {
                if (
                    (await this.runtimeJar(relative)) !== expected.get(relative)
                )
                    throw new CrafleetError(
                        "JAR_DRIFT",
                        "A removed JAR changed after deployment preflight.",
                        3,
                    );
                await rm(await assertNoSymlinks(runtime, relative), {
                    force: true,
                });
            }
    }
    async applyPrepared(): Promise<void> {
        this.options.signal?.throwIfAborted();
        assertStopped((await this.controller.status()).status);
        const state = await readState(this.context.dir);
        if (!state.pending) return;
        if (await exists(this.journalFile))
            throw new CrafleetError(
                "RECOVERY_REQUIRED",
                "Recover the interrupted deployment before applying another one.",
                4,
            );
        await this.config(state.pending).assertUnchanged(state.pending.config);
        const probe = await this.probeJars(state.pending, state.active ?? null);
        const journal: DeployJournal = {
            schemaVersion: 1,
            phase: "applying",
            previous: state.active ?? null,
            next: state.pending,
            createdJars: probe.createdJars,
        };
        await assertNoSymlinks(this.context.dir, ".crafleet/deploy.json");
        await writeJson(this.journalFile, journal);
        try {
            await this.replaceJars(
                state.pending,
                state.active ?? null,
                probe.hashes,
            );
            await this.config(state.pending).apply(state.pending.config);
            await this.checkpoint?.("configuration");
            await saveState(this.context.dir, {
                schemaVersion: 1,
                active: state.pending,
            });
            await writeJson(this.journalFile, { ...journal, phase: "applied" });
            await rm(this.journalFile);
        } catch {
            throw new CrafleetError(
                "DEPLOY_INTERRUPTED",
                "Deployment interrupted. The server was not started. Run crafleet recover.",
                4,
            );
        }
    }
    private ports(): LifecyclePorts {
        return {
            status: () => this.controller.status(),
            hasPending: async () =>
                Boolean((await readState(this.context.dir)).pending),
            preflight: (pending) => this.preflight(pending),
            stop: () => this.controller.stop(),
            verifyConfig: async () => {
                const pending = (await readState(this.context.dir)).pending;
                if (pending)
                    await this.config(pending).assertUnchanged(pending.config);
            },
            backup: () => this.backupActive(),
            apply: () => this.applyPrepared(),
            spawn: () => this.spawnActive(),
        };
    }
    /**
     * The caller must hold the project or workspace operation lock.
     * An expected ID prevents recovery paths from starting a different active installation.
     */
    async spawnActive(
        expectedActiveId?: string,
        ownedJournal?: OwnedEulaOperationJournal,
    ) {
        const active = (await readState(this.context.dir)).active;
        if (
            !active ||
            (expectedActiveId !== undefined && active.id !== expectedActiveId)
        )
            throw new CrafleetError(
                "ACTIVE_MISSING",
                expectedActiveId
                    ? "The expected active installation is no longer active."
                    : "No active installation.",
                3,
            );
        const activeId = expectedActiveId ?? active.id;
        const status = await this.controller.status();
        // A matching running process is already the requested outcome; never touch its runtime files.
        if (status.status === "running") {
            if (status.activeId !== activeId)
                throw new CrafleetError(
                    "ACTIVE_MISMATCH",
                    "A different active installation is already running.",
                    3,
                );
            return status;
        }
        assertStopped(status.status);
        await this.prepareEula(active, false, true, ownedJournal);
        return this.controller.start(activeId);
    }
    private operate<T>(operation: () => Promise<T>): Promise<T> {
        return withMutex(
            path.join(this.context.lockRoot, ".crafleet/operation.lock"),
            operation,
        );
    }
    start(activeOnly = false) {
        return this.operate(() => startServer(this.ports(), activeOnly));
    }
    restart(activeOnly = false) {
        return this.operate(() => restartServer(this.ports(), activeOnly));
    }
    stop(force = false) {
        return this.operate(() => this.controller.stop(force));
    }
    async apply(dryRun = false): Promise<unknown> {
        if (dryRun) return this.plan();
        return this.operate(async () => {
            assertStopped((await this.controller.status()).status);
            if (!(await readState(this.context.dir)).pending)
                return this.plan();
            await this.preflight(true, false);
            const pending = (await readState(this.context.dir)).pending;
            if (pending)
                await this.config(pending).assertUnchanged(pending.config);
            await this.backupActive();
            await this.applyPrepared();
            return this.plan();
        });
    }
    async discard(dryRun = false): Promise<void> {
        if (dryRun) return;
        await this.operate(async () => {
            if (await exists(this.journalFile))
                throw new CrafleetError(
                    "RECOVERY_REQUIRED",
                    "Recover deployment before discarding pending.",
                    4,
                );
            const state = await readState(this.context.dir);
            delete state.pending;
            await saveState(this.context.dir, state);
        });
    }
    async createBackup(leaveStopped = false): Promise<unknown> {
        if (!this.backupService)
            throw new CrafleetError(
                "BACKUP_REQUIRED",
                "Configure a backup repository first.",
                3,
            );
        const backup = this.backupService;
        return this.operate(() =>
            coldBackup(
                {
                    ...this.ports(),
                    preflight: async () => {
                        await backup.prepare(this.options);
                        await backup.preflight(
                            this.options.signal
                                ? { signal: this.options.signal }
                                : {},
                        );
                    },
                    create: async () =>
                        backup.create(
                            {
                                installation:
                                    (await readState(this.context.dir))
                                        .active ?? null,
                            },
                            this.options.signal
                                ? { signal: this.options.signal }
                                : {},
                        ),
                },
                leaveStopped,
            ),
        );
    }
    async recover(dryRun = false): Promise<{ recovered: boolean }> {
        const operation = async () => {
            assertStopped((await this.controller.status()).status);
            await assertNoSymlinks(this.context.dir, ".crafleet/deploy.json");
            if (!(await exists(this.journalFile))) return { recovered: false };
            if ((await lstat(this.journalFile)).size > 32 * 1024 * 1024)
                throw new CrafleetError(
                    "JOURNAL_INVALID",
                    "Deployment journal exceeds its size limit.",
                    4,
                );
            let raw: DeployJournal;
            try {
                const value = await readJson<Partial<DeployJournal>>(
                    this.journalFile,
                );
                if (
                    value?.schemaVersion !== 1 ||
                    !["applying", "applied"].includes(value.phase ?? "") ||
                    !Array.isArray(value.createdJars) ||
                    value.createdJars.some(
                        (relative) => typeof relative !== "string",
                    ) ||
                    Object.keys(value).some(
                        (key) =>
                            ![
                                "schemaVersion",
                                "phase",
                                "previous",
                                "next",
                                "createdJars",
                            ].includes(key),
                    )
                )
                    throw new Error("Invalid journal");
                raw = {
                    schemaVersion: 1,
                    phase: value.phase as DeployJournal["phase"],
                    previous:
                        value.previous === null
                            ? null
                            : validateInstallation(value.previous),
                    next: validateInstallation(value.next),
                    createdJars: value.createdJars,
                };
            } catch {
                throw new CrafleetError(
                    "JOURNAL_INVALID",
                    "Invalid deployment journal; input values are omitted.",
                    4,
                );
            }
            const next = raw.next;
            const previous = raw.previous;
            const nextJars = jars(next);
            const oldJars = jars(previous);
            if (
                new Set(raw.createdJars).size !== raw.createdJars.length ||
                raw.createdJars.some(
                    (relative) =>
                        !nextJars.has(relative) || oldJars.has(relative),
                )
            )
                throw new CrafleetError(
                    "JOURNAL_INVALID",
                    "Deployment journal contains invalid created JAR paths.",
                    4,
                );
            const probe = await this.probeJars(
                next,
                raw.phase === "applied" ? next : previous,
                raw.phase !== "applied",
            );
            if (
                previous === null &&
                [...nextJars.keys()].some(
                    (relative) =>
                        !raw.createdJars.includes(relative) &&
                        probe.hashes.get(relative) === null,
                )
            )
                throw new CrafleetError(
                    "JAR_DRIFT",
                    "A pre-existing adopted JAR disappeared after deployment; recover it explicitly.",
                    4,
                );
            await this.config(next).assertRestorable(next.config);
            if (dryRun) return { recovered: true };
            if (raw.phase === "applied")
                await saveState(this.context.dir, {
                    schemaVersion: 1,
                    active: next,
                });
            else {
                if (previous)
                    await this.replaceJars(previous, next, probe.hashes);
                else
                    for (const relative of raw.createdJars) {
                        if (
                            (await this.runtimeJar(relative)) !==
                            probe.hashes.get(relative)
                        )
                            throw new CrafleetError(
                                "JAR_DRIFT",
                                "Runtime JARs changed during recovery.",
                                4,
                            );
                        await rm(
                            await assertNoSymlinks(
                                path.join(this.context.dir, "runtime"),
                                relative,
                            ),
                            { force: true },
                        );
                    }
                await this.config(next).restore(next.config);
                await saveState(this.context.dir, {
                    schemaVersion: 1,
                    ...(previous ? { active: previous } : {}),
                    pending: next,
                });
            }
            await rm(this.journalFile);
            return { recovered: true };
        };
        return dryRun ? operation() : this.operate(operation);
    }
}
