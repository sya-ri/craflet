import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactContext,
    type ArtifactStore,
    CrafletError,
    formatSource,
    type ProjectLock,
    type ProjectManifest,
    parseSource,
    portablePluginJarName,
    type SourceInput,
    stableStringify,
    validatePluginSet,
} from "@craflet/core";
import { registerCacheProject } from "./cache.js";
import { NodeConfigManager } from "./config.js";
import {
    assertNoSymlinks,
    atomicWrite,
    exists,
    readJson,
    withMutex,
} from "./io.js";
import { ensurePrivateDirectory } from "./private.js";
import {
    fingerprint,
    type ProjectContext,
    parseLockText,
    yamlText,
} from "./projects.js";
import {
    type Installation,
    type ProjectState,
    parseStateText,
    readState,
} from "./state.js";

export interface InstallOptions {
    frozen?: boolean;
    offline?: boolean;
    dryRun?: boolean;
    updatePlugins?: string[];
    updateAllPlugins?: boolean;
    updateServer?: boolean;
    to?: string;
    signal?: AbortSignal;
}
export interface InstallResult {
    project: string;
    changed: boolean;
    pendingId?: string;
    plugins: string[];
    unresolved?: string[];
    warnings?: string[];
}
export function artifactContext(
    project: ProjectContext,
    options: Pick<InstallOptions, "offline" | "signal"> = {},
): ArtifactContext {
    return {
        projectDir: project.dir,
        serverKind: project.manifest.server.type,
        ...(project.manifest.server.type === "paper"
            ? { minecraftVersion: project.manifest.server.version }
            : {}),
        ...(options.offline !== undefined ? { offline: options.offline } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    };
}
export function serverSource(manifest: ProjectManifest): SourceInput {
    return (
        manifest.server.source ?? {
            provider: "paper",
            project: manifest.server.type,
            version: manifest.server.version,
            build: manifest.server.build ?? "latest",
        }
    );
}
export function installationFingerprint(
    installation: Omit<Installation, "id" | "createdAt">,
): string {
    return fingerprint({
        lock: installation.lock,
        launch: {
            server: installation.manifest.server,
            java: installation.manifest.java,
            secrets: installation.manifest.secrets,
        },
        config: installation.config.files.map(({ relative, content }) => ({
            relative,
            content,
        })),
    });
}

async function planInstallation(
    project: ProjectContext,
    store: ArtifactStore,
    old: ProjectLock | undefined,
    options: InstallOptions,
    previous: ProjectState,
): Promise<{
    manifest: ProjectManifest;
    lock: ProjectLock;
    state: ProjectState;
    changed: boolean;
}> {
    if (await exists(path.join(project.dir, ".craflet/deploy.json")))
        throw new CrafletError(
            "RECOVERY_REQUIRED",
            "A deployment must be recovered before installing.",
            4,
        );
    const manifest = structuredClone(project.manifest);
    const context = artifactContext(project, options);
    const originalServer = serverSource(manifest);
    const serverRequest = stableStringify(parseSource(originalServer));
    if (options.frozen && (!old || old.requests.server !== serverRequest))
        throw new CrafletError(
            "FROZEN_LOCK",
            "The server declaration does not match the lockfile.",
            2,
        );
    let requestedServer = options.updateServer
        ? await store.latest(originalServer, context)
        : originalServer;
    if (options.updateServer && options.to) {
        const parsed = parseSource(requestedServer);
        if (parsed.provider === "paper") parsed.build = options.to;
        else if (parsed.provider !== "file") parsed.version = options.to;
        requestedServer = parsed;
    }
    const server =
        !options.updateServer && old?.requests.server === serverRequest
            ? old.server
            : await store.resolve(requestedServer, context);
    await store.ensure(server, context);
    if (options.updateServer) {
        if (server.source.provider === "paper" && !manifest.server.source)
            manifest.server.build = server.source.build;
        else manifest.server.source = formatSource(server.source);
    }
    const plugins: ProjectLock["plugins"] = {};
    const requests: ProjectLock["requests"] = {
        server: stableStringify(parseSource(serverSource(manifest))),
        plugins: {},
    };
    for (const name of options.updatePlugins ?? [])
        if (!Object.hasOwn(manifest.plugins, name))
            throw new CrafletError(
                "PLUGIN_UNKNOWN",
                `Unknown managed plugin: ${name}`,
                2,
            );
    for (const [name, input] of Object.entries(manifest.plugins)) {
        portablePluginJarName(name);
        options.signal?.throwIfAborted();
        const request = stableStringify(parseSource(input));
        const update =
            options.updateAllPlugins ||
            (options.updatePlugins?.includes(name) ?? false);
        if (
            options.frozen &&
            (!old?.plugins[name] || old.requests.plugins[name] !== request)
        )
            throw new CrafletError(
                "FROZEN_LOCK",
                `Plugin ${name} does not match the lockfile.`,
                2,
            );
        let source = update ? await store.latest(input, context) : input;
        if (update && options.to) {
            const parsed = parseSource(source);
            if (parsed.provider !== "file" && parsed.provider !== "paper")
                parsed.version = options.to;
            source = parsed;
        }
        const artifact =
            !update &&
            old?.requests.plugins[name] === request &&
            old.plugins[name]
                ? old.plugins[name]
                : await store.resolve(source, context);
        await store.ensure(artifact, context);
        if (!artifact.identity)
            throw new CrafletError(
                "NOT_PLUGIN",
                `No supported plugin descriptor was found for ${name}.`,
                2,
            );
        if (artifact.identity.id !== name)
            throw new CrafletError(
                "PLUGIN_IDENTITY",
                `Plugin ${name} resolves to ${artifact.identity.id}; identity changes require an explicit remove/add.`,
                3,
            );
        plugins[name] = artifact;
        if (update) manifest.plugins[name] = formatSource(artifact.source);
        requests.plugins[name] = stableStringify(
            parseSource(manifest.plugins[name] ?? input),
        );
    }
    if (
        options.frozen &&
        Object.keys(old?.plugins ?? {}).some(
            (name) => !Object.hasOwn(plugins, name),
        )
    )
        throw new CrafletError(
            "FROZEN_LOCK",
            "Removed plugins require a lockfile update.",
            2,
        );
    validatePluginSet(
        Object.values(plugins).flatMap((item) =>
            item.identity ? [item.identity] : [],
        ),
        manifest.server.type,
    );
    const lock: ProjectLock = {
        name: manifest.name,
        requests,
        server,
        plugins,
    };
    const config = await new NodeConfigManager(
        project.dir,
        manifest.secrets,
    ).prepare();
    const desired = { manifest, lock, config };
    const unchanged =
        previous.active &&
        installationFingerprint(previous.active) ===
            installationFingerprint(desired);
    const alreadyPending =
        previous.pending &&
        installationFingerprint(previous.pending) ===
            installationFingerprint(desired);
    const state: ProjectState = {
        schemaVersion: 1,
        ...(previous.active ? { active: previous.active } : {}),
    };
    // Preserve the deployment identity, but always refresh the checked snapshots.
    // Equal desired content does not imply equal runtime/base observation bytes.
    if (!unchanged)
        state.pending =
            alreadyPending && previous.pending
                ? { ...previous.pending, ...desired }
                : {
                      ...desired,
                      id: randomUUID(),
                      createdAt: new Date().toISOString(),
                  };
    return { manifest, lock, state, changed: !unchanged };
}

interface FileChange {
    relative: string;
    before: string | null;
    after: string;
}
const MAX_MANIFEST_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_JOURNAL_CHANGES = 4096;

export function assertManifestJournalLimits(
    bytes: number,
    changes: number,
): void {
    if (
        bytes > MAX_MANIFEST_JOURNAL_BYTES ||
        changes > MAX_MANIFEST_JOURNAL_CHANGES
    )
        throw new CrafletError(
            "MANIFEST_TOO_LARGE",
            "The planned manifest transaction exceeds recovery limits. Select fewer projects or reduce input size; no declaration or installation state was changed.",
            3,
        );
}

async function previewInstallation(
    project: ProjectContext,
    old: ProjectLock | undefined,
    options: InstallOptions,
): Promise<InstallResult> {
    options.signal?.throwIfAborted();
    if (await exists(path.join(project.dir, ".craflet/deploy.json")))
        throw new CrafletError(
            "RECOVERY_REQUIRED",
            "A deployment must be recovered before installing.",
            4,
        );
    const request = stableStringify(
        parseSource(serverSource(project.manifest)),
    );
    if (options.frozen && (!old || old.requests.server !== request))
        throw new CrafletError(
            "FROZEN_LOCK",
            "The server declaration does not match the lockfile.",
            2,
        );
    const unresolved: string[] = [];
    if (!old || old.requests.server !== request || options.updateServer)
        unresolved.push("server");
    const plugins: ProjectLock["plugins"] = {};
    const requests: ProjectLock["requests"] = { server: request, plugins: {} };
    for (const name of options.updatePlugins ?? [])
        if (!Object.hasOwn(project.manifest.plugins, name))
            throw new CrafletError(
                "PLUGIN_UNKNOWN",
                `Unknown managed plugin: ${name}`,
                2,
            );
    for (const [name, source] of Object.entries(project.manifest.plugins)) {
        portablePluginJarName(name);
        const input = stableStringify(parseSource(source));
        requests.plugins[name] = input;
        const artifact =
            old?.requests.plugins[name] === input
                ? old.plugins[name]
                : undefined;
        if (options.frozen && !artifact)
            throw new CrafletError(
                "FROZEN_LOCK",
                `Plugin ${name} does not match the lockfile.`,
                2,
            );
        if (
            !artifact ||
            options.updateAllPlugins ||
            options.updatePlugins?.includes(name)
        )
            unresolved.push(name);
        else {
            if (!artifact.identity)
                throw new CrafletError(
                    "NOT_PLUGIN",
                    `No supported plugin descriptor was found for ${name}.`,
                    2,
                );
            if (artifact.identity.id !== name)
                throw new CrafletError(
                    "PLUGIN_IDENTITY",
                    `Plugin ${name} has an inconsistent locked identity.`,
                    3,
                );
            plugins[name] = artifact;
        }
    }
    if (
        options.frozen &&
        Object.keys(old?.plugins ?? {}).some(
            (name) => !Object.hasOwn(project.manifest.plugins, name),
        )
    )
        throw new CrafletError(
            "FROZEN_LOCK",
            "Removed plugins require a lockfile update.",
            2,
        );
    if (
        Object.keys(plugins).length ===
        Object.keys(project.manifest.plugins).length
    )
        validatePluginSet(
            Object.values(plugins).flatMap((artifact) =>
                artifact.identity ? [artifact.identity] : [],
            ),
            project.manifest.server.type,
        );
    const config = await new NodeConfigManager(
        project.dir,
        project.manifest.secrets,
    ).prepare();
    const state = await readState(project.dir);
    const changed =
        unresolved.length > 0 ||
        !state.active ||
        !old ||
        installationFingerprint(state.active) !==
            installationFingerprint({
                manifest: project.manifest,
                lock: {
                    name: project.manifest.name,
                    requests,
                    server: old.server,
                    plugins,
                },
                config,
            });
    return {
        project: project.manifest.name,
        changed,
        ...(state.pending ? { pendingId: state.pending.id } : {}),
        plugins: Object.keys(project.manifest.plugins),
        unresolved,
        warnings: unresolved.length
            ? [
                  "Artifact resolution, version availability, checksums, and unresolved plugin identities are deferred until install; dry-run performs no download or cache write.",
              ]
            : [],
    };
}

export interface InstallInputSnapshot {
    root: string;
    lockText: string | null;
    projects: readonly {
        dir: string;
        manifestText: string;
        stateText: string | null;
    }[];
}

function concurrentInput(): CrafletError {
    return new CrafletError(
        "CONCURRENT_EDIT",
        "A project declaration, shared lockfile or installation state changed while the operation was being prepared. Reload the project and retry; no newer input was overwritten.",
        3,
    );
}

async function inputText(
    file: string,
    maximum: number,
): Promise<string | null> {
    await assertNoSymlinks(file);
    if (!(await exists(file))) return null;
    const info = await lstat(file);
    if (!info.isFile() || info.size > maximum)
        throw new CrafletError(
            "INPUT_SIZE",
            "An installation input is not a bounded regular text file.",
            3,
        );
    try {
        return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
        }).decode(await readFile(file));
    } catch {
        throw new CrafletError(
            "INVALID_INPUT",
            "Installation inputs must be valid UTF-8 text; input values are omitted.",
            2,
        );
    }
}

/** Capture before any provider lookup, including plugin identity resolution. */
export async function snapshotInstallInputs(
    projects: readonly ProjectContext[],
): Promise<InstallInputSnapshot> {
    const root = projects[0]?.lockRoot;
    if (
        !root ||
        projects.some((project) => project.lockRoot !== root) ||
        new Set(projects.map((project) => project.dir.toLowerCase())).size !==
            projects.length
    )
        throw new CrafletError(
            "WORKSPACE_ROOT",
            "Select distinct projects from one workspace.",
            2,
        );
    const lockText = await inputText(
        path.join(root, "craflet-lock.yaml"),
        2 * 1024 * 1024,
    );
    const entries: InstallInputSnapshot["projects"][number][] = [];
    for (const project of projects) {
        const manifestText = await inputText(
            path.join(project.dir, "craflet.yaml"),
            2 * 1024 * 1024,
        );
        if (
            manifestText === null ||
            (project.manifestText !== undefined &&
                manifestText !== project.manifestText)
        )
            throw concurrentInput();
        const stateText = await inputText(
            path.join(project.dir, ".craflet/state.json"),
            32 * 1024 * 1024,
        );
        entries.push({ dir: project.dir, manifestText, stateText });
    }
    return { root, lockText, projects: entries };
}

async function assertInstallInputs(
    snapshot: InstallInputSnapshot,
): Promise<void> {
    if (
        (await inputText(
            path.join(snapshot.root, "craflet-lock.yaml"),
            2 * 1024 * 1024,
        )) !== snapshot.lockText
    )
        throw concurrentInput();
    for (const project of snapshot.projects) {
        if (
            (await inputText(
                path.join(project.dir, "craflet.yaml"),
                2 * 1024 * 1024,
            )) !== project.manifestText ||
            (await inputText(
                path.join(project.dir, ".craflet/state.json"),
                32 * 1024 * 1024,
            )) !== project.stateText
        )
            throw concurrentInput();
    }
}

export async function installProjects(
    projects: ProjectContext[],
    store: ArtifactStore,
    options: InstallOptions = {},
    inputSnapshot?: InstallInputSnapshot,
): Promise<InstallResult[]> {
    const root = projects[0]?.lockRoot;
    if (
        !root ||
        projects.some((project) => project.lockRoot !== root) ||
        new Set(projects.map((project) => project.dir.toLowerCase())).size !==
            projects.length
    )
        throw new CrafletError(
            "WORKSPACE_ROOT",
            "Select projects from one workspace.",
            2,
        );
    const perform = async () => {
        options.signal?.throwIfAborted();
        const journalFile = path.join(
            root,
            ".craflet/manifest-transaction.json",
        );
        await assertNoSymlinks(root, ".craflet/manifest-transaction.json");
        if (await exists(journalFile))
            throw new CrafletError(
                "RECOVERY_REQUIRED",
                "An interrupted manifest transaction needs craflet recover.",
                4,
            );
        const snapshot =
            inputSnapshot ?? (await snapshotInstallInputs(projects));
        if (
            snapshot.root !== root ||
            snapshot.projects.length !== projects.length ||
            new Set(snapshot.projects.map((entry) => entry.dir.toLowerCase()))
                .size !== snapshot.projects.length ||
            projects.some(
                (project) =>
                    !snapshot.projects.some(
                        (entry) =>
                            entry.dir === project.dir &&
                            (project.manifestText === undefined ||
                                project.manifestText === entry.manifestText),
                    ),
            )
        )
            throw concurrentInput();
        await assertInstallInputs(snapshot);
        const lock = parseLockText(snapshot.lockText);
        const captured = new Map(
            snapshot.projects.map((entry) => [
                entry.dir,
                { ...entry, state: parseStateText(entry.stateText) },
            ]),
        );
        if (options.dryRun) {
            const previews: InstallResult[] = [];
            for (const project of projects)
                previews.push(
                    await previewInstallation(
                        project,
                        lock.projects[project.lockKey],
                        options,
                    ),
                );
            await assertInstallInputs(snapshot);
            return previews;
        }
        const changes: FileChange[] = [];
        const results: InstallResult[] = [];
        const committed: {
            project: ProjectContext;
            manifest: ProjectManifest;
            text: string;
        }[] = [];
        for (const project of projects) {
            const initial = captured.get(project.dir);
            if (!initial) throw concurrentInput();
            const plan = await planInstallation(
                project,
                store,
                lock.projects[project.lockKey],
                options,
                initial.state,
            );
            lock.projects[project.lockKey] = plan.lock;
            const file = path.join(project.dir, "craflet.yaml");
            const text = await yamlText(
                file,
                plan.manifest,
                initial.manifestText,
            );
            changes.push({
                relative: path.relative(root, file).replaceAll(path.sep, "/"),
                before: initial.manifestText,
                after: text,
            });
            changes.push({
                relative: path
                    .relative(
                        root,
                        path.join(project.dir, ".craflet/state.json"),
                    )
                    .replaceAll(path.sep, "/"),
                before: initial.stateText,
                after: `${JSON.stringify(plan.state, null, 4)}\n`,
            });
            committed.push({ project, manifest: plan.manifest, text });
            results.push({
                project: plan.manifest.name,
                changed: plan.changed,
                ...(plan.state.pending
                    ? { pendingId: plan.state.pending.id }
                    : {}),
                plugins: Object.keys(plan.lock.plugins),
            });
        }
        changes.push({
            relative: "craflet-lock.yaml",
            before: snapshot.lockText,
            after: await yamlText(
                path.join(root, "craflet-lock.yaml"),
                lock,
                snapshot.lockText,
            ),
        });
        const journalText = `${JSON.stringify({ schemaVersion: 1, phase: "writing", changes }, null, 4)}\n`;
        assertManifestJournalLimits(
            Buffer.byteLength(journalText),
            changes.length,
        );
        // No network-derived result may turn a later manual edit into its baseline.
        await assertInstallInputs(snapshot);
        for (const project of projects)
            await ensurePrivateDirectory(
                await assertNoSymlinks(project.dir, ".craflet"),
            );
        await assertInstallInputs(snapshot);
        await atomicWrite(journalFile, journalText);
        try {
            for (const change of changes) {
                const destination = await assertNoSymlinks(
                    root,
                    change.relative,
                );
                if (
                    (await inputText(
                        destination,
                        change.relative.endsWith("/state.json")
                            ? 32 * 1024 * 1024
                            : 2 * 1024 * 1024,
                    )) !== change.before
                )
                    throw concurrentInput();
                if (change.before !== change.after)
                    await atomicWrite(destination, change.after);
            }
            await rm(journalFile);
        } catch {
            throw new CrafletError(
                "MANIFEST_INTERRUPTED",
                "Manifest transaction interrupted. Run craflet recover before another mutation.",
                4,
            );
        }
        for (const entry of committed) {
            entry.project.manifest = entry.manifest;
            entry.project.manifestText = entry.text;
        }
        return results;
    };
    if (options.dryRun) return perform();
    for (const project of projects)
        await registerCacheProject(project.home, project.dir);
    await ensurePrivateDirectory(await assertNoSymlinks(root, ".craflet"));
    return withMutex(path.join(root, ".craflet/operation.lock"), perform);
}

export async function recoverManifests(
    root: string,
    dryRun = false,
): Promise<boolean> {
    const file = path.join(root, ".craflet/manifest-transaction.json");
    const perform = async () => {
        await assertNoSymlinks(root, ".craflet/manifest-transaction.json");
        if (!(await exists(file))) return false;
        if ((await lstat(file)).size > MAX_MANIFEST_JOURNAL_BYTES)
            throw new CrafletError(
                "JOURNAL_INVALID",
                "Manifest journal exceeds its size limit.",
                4,
            );
        const invalid = () =>
            new CrafletError(
                "JOURNAL_INVALID",
                "Invalid manifest recovery journal; input values are omitted.",
                4,
            );
        let raw: unknown;
        try {
            raw = await readJson<unknown>(file);
        } catch {
            throw invalid();
        }
        if (raw === null || typeof raw !== "object" || Array.isArray(raw))
            throw invalid();
        const journal = raw as Record<string, unknown>;
        if (
            journal.schemaVersion !== 1 ||
            journal.phase !== "writing" ||
            !Array.isArray(journal.changes) ||
            journal.changes.length > MAX_MANIFEST_JOURNAL_CHANGES ||
            Object.keys(journal).some(
                (key) => !["schemaVersion", "phase", "changes"].includes(key),
            )
        )
            throw invalid();
        const changes: (FileChange & {
            target: string;
            current: string | null;
        })[] = [];
        const targets = new Set<string>();
        for (const value of journal.changes) {
            if (
                value === null ||
                typeof value !== "object" ||
                Array.isArray(value)
            )
                throw invalid();
            const change = value as Record<string, unknown>;
            if (
                typeof change.relative !== "string" ||
                typeof change.after !== "string" ||
                !(
                    change.before === null || typeof change.before === "string"
                ) ||
                Object.keys(change).some(
                    (key) => !["relative", "before", "after"].includes(key),
                )
            )
                throw invalid();
            const normalized = change.relative.replaceAll("\\", "/");
            if (
                !/(^|\/)(craflet\.yaml|craflet-lock\.yaml|\.craflet\/state\.json)$/.test(
                    normalized,
                ) ||
                path.posix.isAbsolute(normalized) ||
                path.win32.isAbsolute(normalized) ||
                /[\0\r\n:]/.test(normalized)
            )
                throw invalid();
            // Validate every ancestor before any target is read or rolled back.
            const target = await assertNoSymlinks(root, normalized);
            const key = target.toLowerCase();
            if (targets.has(key)) throw invalid();
            targets.add(key);
            const current = (await exists(target))
                ? await readFile(target, "utf8")
                : null;
            if (current !== change.before && current !== change.after)
                throw new CrafletError(
                    "RECOVERY_CONFLICT",
                    "A manifest was edited after interruption; recover it manually.",
                    4,
                );
            changes.push({
                relative: normalized,
                target,
                before: change.before,
                after: change.after,
                current,
            });
        }
        if (!dryRun) {
            for (const change of changes.reverse()) {
                const target = await assertNoSymlinks(root, change.relative);
                if (
                    ((await exists(target))
                        ? await readFile(target, "utf8")
                        : null) !== change.current
                )
                    throw new CrafletError(
                        "RECOVERY_CONFLICT",
                        "A manifest changed during recovery; remaining changes require review.",
                        4,
                    );
                if (change.before === change.current) continue;
                if (change.before === null) await rm(target, { force: true });
                else await atomicWrite(target, change.before);
            }
            await rm(file);
        }
        return true;
    };
    await assertNoSymlinks(root, ".craflet/manifest-transaction.json");
    if (!(await exists(file))) return false;
    return dryRun
        ? perform()
        : withMutex(path.join(root, ".craflet/operation.lock"), perform);
}
