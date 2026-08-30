import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactContext,
    type ArtifactStore,
    type ConfigBundle,
    CrafleetError,
    formatSource,
    type PluginIdentity,
    type ProjectLock,
    type ProjectManifest,
    parsePluginSource,
    parseServerSource,
    parseSource,
    type SourceInput,
    stableStringify,
    validatePluginIdentities,
    validatePluginSet,
} from "@crafleet/core";
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
    MAX_YAML_BYTES,
    type ProjectContext,
    parseLockText,
    yamlText,
} from "./projects.js";
import {
    type Installation,
    type ProjectState,
    parseStateText,
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

async function assertDeploymentRecovered(project: ProjectContext) {
    if (await exists(path.join(project.dir, ".crafleet/deploy.json")))
        throw new CrafleetError(
            "RECOVERY_REQUIRED",
            "A deployment must be recovered before installing.",
            4,
        );
}

async function assertManifestRecovered(root: string): Promise<string> {
    const journal = path.join(root, ".crafleet/manifest-transaction.json");
    await assertNoSymlinks(root, ".crafleet/manifest-transaction.json");
    if (await exists(journal))
        throw new CrafleetError(
            "RECOVERY_REQUIRED",
            "An interrupted manifest transaction needs crafleet recover.",
            4,
        );
    return journal;
}

function assertKnownPluginUpdates(
    manifest: ProjectManifest,
    options: InstallOptions,
): void {
    for (const name of options.updatePlugins ?? [])
        if (!Object.hasOwn(manifest.plugins, name))
            throw new CrafleetError(
                "PLUGIN_UNKNOWN",
                `Unknown managed plugin: ${name}`,
                2,
            );
}

function exactSource(
    input: SourceInput,
    exactVersion: string,
    target: "plugin" | "server",
): SourceInput {
    if (!exactVersion.trim())
        throw new CrafleetError(
            "UPDATE_VERSION",
            "--to requires a non-empty version.",
            2,
        );
    const source = parseSource(input);
    if (source.provider === "file")
        throw new CrafleetError(
            "UPDATE_VERSION",
            `--to cannot set a version for a local ${target} JAR. Replace the file, then run crafleet ${target === "plugin" ? "plugins" : "server"} update.`,
            2,
        );
    if (source.provider === "paper") source.build = exactVersion;
    else source.version = exactVersion;
    return parseSource(source);
}

export function validateInstallRequest(
    projects: readonly ProjectContext[],
    options: InstallOptions,
): void {
    assertManifestJournalLimits(0, projects.length * 2 + 1);
    const selected = options.updatePlugins ?? [];
    if (
        options.frozen &&
        (options.updateServer ||
            options.updateAllPlugins ||
            selected.length > 0)
    )
        throw new CrafleetError(
            "FROZEN_LOCK",
            "A frozen install cannot select server or plugin updates.",
            2,
        );
    if (options.to !== undefined && typeof options.to !== "string")
        throw new CrafleetError(
            "UPDATE_VERSION",
            "--to requires a version string.",
            2,
        );
    if (options.updateAllPlugins && selected.length)
        throw new CrafleetError(
            "UPDATE_OPTIONS",
            "Choose named plugins or all plugins, not both.",
            2,
        );
    if (options.to !== undefined) {
        const exactTargets =
            (options.updateServer ? 1 : 0) +
            (options.updateAllPlugins ? 2 : selected.length);
        if (exactTargets !== 1)
            throw new CrafleetError(
                "UPDATE_VERSION",
                "--to requires exactly one server or plugin update target.",
                2,
            );
    }
    for (const project of projects) {
        parseServerSource(
            serverSource(project.manifest),
            project.manifest.server.type,
        );
        validatePluginIdentities(
            [],
            project.manifest.server.type,
            Object.keys(project.manifest.plugins),
        );
        for (const source of Object.values(project.manifest.plugins))
            parsePluginSource(source);
        assertKnownPluginUpdates(project.manifest, options);
        if (options.to === undefined) continue;
        if (options.updateServer)
            exactSource(serverSource(project.manifest), options.to, "server");
        else {
            const name = selected[0];
            if (!name)
                throw new CrafleetError(
                    "UPDATE_VERSION",
                    "--to requires exactly one plugin update target.",
                    2,
                );
            const source = project.manifest.plugins[name];
            if (source !== undefined) exactSource(source, options.to, "plugin");
        }
    }
}

async function updateSource(
    store: ArtifactStore,
    input: SourceInput,
    context: ArtifactContext,
    exactVersion: string | undefined,
    target: "plugin" | "server",
): Promise<SourceInput> {
    return exactVersion === undefined
        ? (await store.latest(input, context)).source
        : exactSource(input, exactVersion, target);
}

function assertFrozenPluginSet(
    manifest: ProjectManifest,
    old: ProjectLock | undefined,
    frozen: boolean | undefined,
): void {
    if (!frozen) return;
    const locked = new Set([
        ...Object.keys(old?.plugins ?? {}),
        ...Object.keys(old?.requests.plugins ?? {}),
    ]);
    if ([...locked].some((name) => !Object.hasOwn(manifest.plugins, name)))
        throw new CrafleetError(
            "FROZEN_LOCK",
            "Removed plugins require a lockfile update.",
            2,
        );
}

interface InstallationPreflight {
    project: ProjectContext;
    manifest: ProjectManifest;
    old: ProjectLock | undefined;
    previous: ProjectState;
    reusable: ProjectLock["plugins"];
    config: ConfigBundle;
    serverRequest: string;
    plugins: readonly {
        name: string;
        source: SourceInput;
        request: string;
    }[];
}

type ValidatedInstallation = Omit<InstallationPreflight, "config">;

function validateInstallation(
    project: ProjectContext,
    old: ProjectLock | undefined,
    options: InstallOptions,
    previous: ProjectState,
): ValidatedInstallation {
    options.signal?.throwIfAborted();
    const manifest = structuredClone(project.manifest);
    if (options.frozen && old?.name !== manifest.name)
        throw new CrafleetError(
            "FROZEN_LOCK",
            "The project identity does not match the lockfile.",
            2,
        );
    const serverRequest = stableStringify(
        parseServerSource(serverSource(manifest), manifest.server.type),
    );
    if (options.frozen && (!old || old.requests.server !== serverRequest))
        throw new CrafleetError(
            "FROZEN_LOCK",
            "The server declaration does not match the lockfile.",
            2,
        );
    if (!options.updateServer && old?.requests.server === serverRequest)
        parseServerSource(old.server.source, manifest.server.type);
    const plugins: ValidatedInstallation["plugins"][number][] = [];
    const reusable: ProjectLock["plugins"] = {};
    for (const [name, input] of Object.entries(manifest.plugins)) {
        const request = stableStringify(parsePluginSource(input));
        plugins.push({ name, source: input, request });
        const update =
            options.updateAllPlugins ||
            (options.updatePlugins?.includes(name) ?? false);
        const artifact =
            !update && old?.requests.plugins[name] === request
                ? old.plugins[name]
                : undefined;
        if (
            options.frozen &&
            (!old?.plugins[name] || old.requests.plugins[name] !== request)
        )
            throw new CrafleetError(
                "FROZEN_LOCK",
                `Plugin ${name} does not match the lockfile.`,
                2,
            );
        if (!artifact) continue;
        parsePluginSource(artifact.source);
        if (!artifact.identity)
            throw new CrafleetError(
                "NOT_PLUGIN",
                `No supported plugin descriptor was found for ${name}.`,
                2,
            );
        if (artifact.identity.id !== name)
            throw new CrafleetError(
                "PLUGIN_IDENTITY",
                `Plugin ${name} has an inconsistent locked identity.`,
                3,
            );
        reusable[name] = artifact;
    }
    assertFrozenPluginSet(manifest, old, options.frozen);
    const identities = Object.values(reusable).flatMap((artifact) =>
        artifact.identity ? [artifact.identity] : [],
    );
    if (Object.keys(reusable).length === Object.keys(manifest.plugins).length)
        validatePluginSet(identities, manifest.server.type);
    else
        validatePluginIdentities(
            identities,
            manifest.server.type,
            plugins
                .filter(({ name }) => !Object.hasOwn(reusable, name))
                .map(({ name }) => name),
        );
    return {
        project,
        manifest,
        old,
        previous,
        reusable,
        serverRequest,
        plugins,
    };
}

async function preflightInstallations(
    validated: readonly ValidatedInstallation[],
    preparedConfigs?: ReadonlyMap<string, ConfigBundle>,
): Promise<InstallationPreflight[]> {
    for (const input of validated)
        await assertDeploymentRecovered(input.project);
    const result: InstallationPreflight[] = [];
    for (const input of validated) {
        const manager = new NodeConfigManager(
            input.project.dir,
            input.manifest.secrets,
        );
        const prepared = preparedConfigs?.get(input.project.dir);
        const config = prepared ?? (await manager.prepare());
        if (prepared) await manager.assertUnchanged(prepared);
        result.push({ ...input, config });
    }
    return result;
}

function pluginNamespace(
    input: Pick<InstallationPreflight, "plugins" | "reusable">,
): {
    identities: Map<string, PluginIdentity>;
    reservedIds: Set<string>;
} {
    const identities = new Map<string, PluginIdentity>(
        Object.entries(input.reusable).flatMap(([name, artifact]) =>
            artifact.identity ? [[name, artifact.identity] as const] : [],
        ),
    );
    return {
        identities,
        reservedIds: new Set(
            input.plugins
                .map(({ name }) => name)
                .filter((name) => !identities.has(name)),
        ),
    };
}

async function planInstallation(
    input: InstallationPreflight,
    store: ArtifactStore,
    options: InstallOptions,
): Promise<{
    manifest: ProjectManifest;
    lock: ProjectLock;
    state: ProjectState;
    changed: boolean;
}> {
    const {
        config,
        manifest,
        old,
        plugins: pluginInputs,
        previous,
        project,
        reusable,
    } = input;
    const context = artifactContext(project, options);
    const originalServer = serverSource(manifest);
    const serverRequest = input.serverRequest;
    const requestedServer = options.updateServer
        ? await updateSource(
              store,
              originalServer,
              context,
              options.to,
              "server",
          )
        : originalServer;
    const server =
        !options.updateServer && old?.requests.server === serverRequest
            ? old.server
            : await store.resolve(requestedServer, context);
    parseServerSource(server.source, manifest.server.type);
    await store.ensure(server, context);
    if (options.updateServer) {
        if (server.source.provider === "paper" && !manifest.server.source)
            manifest.server.build = server.source.build;
        else manifest.server.source = formatSource(server.source);
    }
    const plugins: ProjectLock["plugins"] = {};
    const { identities: knownIdentities, reservedIds: unresolvedIds } =
        pluginNamespace({ plugins: pluginInputs, reusable });
    const requests: ProjectLock["requests"] = {
        server: stableStringify(
            parseServerSource(serverSource(manifest), manifest.server.type),
        ),
        plugins: {},
    };
    for (const { name, source: input, request } of pluginInputs) {
        options.signal?.throwIfAborted();
        const update =
            options.updateAllPlugins ||
            (options.updatePlugins?.includes(name) ?? false);
        const source = update
            ? await updateSource(store, input, context, options.to, "plugin")
            : input;
        const artifact =
            !update &&
            old?.requests.plugins[name] === request &&
            old.plugins[name]
                ? old.plugins[name]
                : await store.resolve(source, context);
        parsePluginSource(artifact.source);
        if (!artifact.identity)
            throw new CrafleetError(
                "NOT_PLUGIN",
                `No supported plugin descriptor was found for ${name}.`,
                2,
            );
        if (artifact.identity.id !== name)
            throw new CrafleetError(
                "PLUGIN_IDENTITY",
                `Plugin ${name} resolves to ${artifact.identity.id}; identity changes require an explicit remove/add.`,
                3,
            );
        knownIdentities.set(name, artifact.identity);
        unresolvedIds.delete(name);
        validatePluginIdentities(
            [...knownIdentities.values()],
            manifest.server.type,
            [...unresolvedIds],
        );
        await store.ensure(artifact, context);
        plugins[name] = artifact;
        if (update) manifest.plugins[name] = formatSource(artifact.source);
        requests.plugins[name] = stableStringify(
            parsePluginSource(manifest.plugins[name] ?? input),
        );
    }
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
        throw new CrafleetError(
            "MANIFEST_TOO_LARGE",
            "The planned manifest transaction exceeds recovery limits. Select fewer projects or reduce input size; no declaration or installation state was changed.",
            3,
        );
}

async function previewInstallation(
    input: InstallationPreflight,
    options: InstallOptions,
): Promise<InstallResult> {
    options.signal?.throwIfAborted();
    const { config, manifest, old, plugins: pluginInputs, previous } = input;
    const unresolved: string[] = [];
    if (
        !old ||
        old.requests.server !== input.serverRequest ||
        options.updateServer
    )
        unresolved.push("server");
    const plugins: ProjectLock["plugins"] = {};
    const requests: ProjectLock["requests"] = {
        server: input.serverRequest,
        plugins: {},
    };
    for (const { name, request } of pluginInputs) {
        requests.plugins[name] = request;
        const update =
            options.updateAllPlugins ||
            (options.updatePlugins?.includes(name) ?? false);
        const artifact =
            !update && old?.requests.plugins[name] === request
                ? old.plugins[name]
                : undefined;
        if (!artifact || update) unresolved.push(name);
        else plugins[name] = artifact;
    }
    const changed =
        unresolved.length > 0 ||
        !previous.active ||
        !old ||
        installationFingerprint(previous.active) !==
            installationFingerprint({
                manifest,
                lock: {
                    name: manifest.name,
                    requests,
                    server: old.server,
                    plugins,
                },
                config,
            });
    return {
        project: manifest.name,
        changed,
        ...(previous.pending ? { pendingId: previous.pending.id } : {}),
        plugins: Object.keys(manifest.plugins),
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

export interface InstallPreparation {
    snapshot: InstallInputSnapshot;
    configs: ReadonlyMap<string, ConfigBundle>;
    pluginNamespaces: ReadonlyMap<
        string,
        {
            identities: readonly PluginIdentity[];
            reservedIds: readonly string[];
        }
    >;
}

function concurrentInput(): CrafleetError {
    return new CrafleetError(
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
        throw new CrafleetError(
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
        throw new CrafleetError(
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
    const root = installRoot(projects);
    const lockText = await inputText(
        path.join(root, "crafleet-lock.yaml"),
        MAX_YAML_BYTES,
    );
    parseLockText(lockText);
    const entries: InstallInputSnapshot["projects"][number][] = [];
    for (const project of projects) {
        const manifestText = await inputText(
            path.join(project.dir, "crafleet.yaml"),
            MAX_YAML_BYTES,
        );
        if (
            manifestText === null ||
            (project.manifestText !== undefined &&
                manifestText !== project.manifestText)
        )
            throw concurrentInput();
        const stateText = await inputText(
            path.join(project.dir, ".crafleet/state.json"),
            32 * 1024 * 1024,
        );
        parseStateText(stateText);
        entries.push({ dir: project.dir, manifestText, stateText });
    }
    return { root, lockText, projects: entries };
}

async function assertInstallInputs(
    snapshot: InstallInputSnapshot,
): Promise<void> {
    if (
        (await inputText(
            path.join(snapshot.root, "crafleet-lock.yaml"),
            MAX_YAML_BYTES,
        )) !== snapshot.lockText
    )
        throw concurrentInput();
    for (const project of snapshot.projects) {
        if (
            (await inputText(
                path.join(project.dir, "crafleet.yaml"),
                MAX_YAML_BYTES,
            )) !== project.manifestText ||
            (await inputText(
                path.join(project.dir, ".crafleet/state.json"),
                32 * 1024 * 1024,
            )) !== project.stateText
        )
            throw concurrentInput();
    }
}

function installRoot(projects: readonly ProjectContext[]): string {
    const root = projects[0]?.lockRoot;
    if (
        !root ||
        projects.some((project) => project.lockRoot !== root) ||
        new Set(projects.map((project) => project.dir.toLowerCase())).size !==
            projects.length
    )
        throw new CrafleetError(
            "WORKSPACE_ROOT",
            "Select distinct projects from one workspace.",
            2,
        );
    return root;
}

function assertSnapshotProjects(
    projects: readonly ProjectContext[],
    snapshot: InstallInputSnapshot,
    root: string,
): void {
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
}

function assertSnapshotJournalCapacity(snapshot: InstallInputSnapshot): void {
    const changes: FileChange[] = snapshot.projects.flatMap((entry) => [
        {
            relative: path
                .relative(snapshot.root, path.join(entry.dir, "crafleet.yaml"))
                .replaceAll(path.sep, "/"),
            before: entry.manifestText,
            after: "",
        },
        {
            relative: path
                .relative(
                    snapshot.root,
                    path.join(entry.dir, ".crafleet/state.json"),
                )
                .replaceAll(path.sep, "/"),
            before: entry.stateText,
            after: "",
        },
    ]);
    changes.push({
        relative: "crafleet-lock.yaml",
        before: snapshot.lockText,
        after: "",
    });
    const minimumJournal = `${JSON.stringify({ schemaVersion: 1, phase: "writing", changes }, null, 4)}\n`;
    assertManifestJournalLimits(
        Buffer.byteLength(minimumJournal),
        changes.length,
    );
}

async function prepareInstallationRun(
    projects: readonly ProjectContext[],
    options: InstallOptions,
    snapshot: InstallInputSnapshot,
    preparedConfigs?: ReadonlyMap<string, ConfigBundle>,
) {
    const root = installRoot(projects);
    assertSnapshotProjects(projects, snapshot, root);
    assertSnapshotJournalCapacity(snapshot);
    await assertInstallInputs(snapshot);
    const lock = parseLockText(snapshot.lockText);
    const captured = new Map(
        snapshot.projects.map((entry) => [
            entry.dir,
            { ...entry, state: parseStateText(entry.stateText) },
        ]),
    );
    const validated = projects.map((project) => {
        const initial = captured.get(project.dir);
        if (!initial) throw concurrentInput();
        return validateInstallation(
            project,
            lock.projects[project.lockKey],
            options,
            initial.state,
        );
    });
    const preflights = await preflightInstallations(validated, preparedConfigs);
    await assertInstallInputs(snapshot);
    return { captured, lock, preflights };
}

export async function prepareInstallProjects(
    projects: readonly ProjectContext[],
    options: InstallOptions = {},
): Promise<InstallPreparation> {
    const root = installRoot(projects);
    validateInstallRequest(projects, options);
    await assertManifestRecovered(root);
    const snapshot = await snapshotInstallInputs(projects);
    const { preflights } = await prepareInstallationRun(
        projects,
        options,
        snapshot,
    );
    return {
        snapshot,
        configs: new Map(
            preflights.map((input) => [input.project.dir, input.config]),
        ),
        pluginNamespaces: new Map(
            preflights.map((input) => {
                const namespace = pluginNamespace(input);
                return [
                    input.project.dir,
                    {
                        identities: [...namespace.identities.values()],
                        reservedIds: [...namespace.reservedIds],
                    },
                ] as const;
            }),
        ),
    };
}

export async function installProjects(
    projects: ProjectContext[],
    store: ArtifactStore,
    options: InstallOptions = {},
    preparation?: InstallPreparation,
): Promise<InstallResult[]> {
    const root = installRoot(projects);
    validateInstallRequest(projects, options);
    const perform = async () => {
        options.signal?.throwIfAborted();
        const journalFile = await assertManifestRecovered(root);
        const snapshot =
            preparation?.snapshot ?? (await snapshotInstallInputs(projects));
        const { captured, lock, preflights } = await prepareInstallationRun(
            projects,
            options,
            snapshot,
            preparation?.configs,
        );
        if (options.dryRun) {
            const previews: InstallResult[] = [];
            for (const input of preflights)
                previews.push(await previewInstallation(input, options));
            await assertInstallInputs(snapshot);
            return previews;
        }
        for (const project of projects)
            await registerCacheProject(project.home, project.dir);
        const changes: FileChange[] = [];
        const results: InstallResult[] = [];
        const committed: {
            project: ProjectContext;
            manifest: ProjectManifest;
            text: string;
        }[] = [];
        for (const input of preflights) {
            const { project } = input;
            const initial = captured.get(project.dir);
            if (!initial) throw concurrentInput();
            const plan = await planInstallation(input, store, options);
            lock.projects[project.lockKey] = plan.lock;
            const file = path.join(project.dir, "crafleet.yaml");
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
                        path.join(project.dir, ".crafleet/state.json"),
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
            relative: "crafleet-lock.yaml",
            before: snapshot.lockText,
            after: await yamlText(
                path.join(root, "crafleet-lock.yaml"),
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
        for (const input of preflights) {
            await assertDeploymentRecovered(input.project);
            await new NodeConfigManager(
                input.project.dir,
                input.manifest.secrets,
            ).assertUnchanged(input.config);
        }
        for (const project of projects)
            await ensurePrivateDirectory(
                await assertNoSymlinks(project.dir, ".crafleet"),
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
                            : MAX_YAML_BYTES,
                    )) !== change.before
                )
                    throw concurrentInput();
                if (change.before !== change.after)
                    await atomicWrite(destination, change.after);
            }
            await rm(journalFile);
        } catch {
            throw new CrafleetError(
                "MANIFEST_INTERRUPTED",
                "Manifest transaction interrupted. Run crafleet recover before another mutation.",
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
    await ensurePrivateDirectory(await assertNoSymlinks(root, ".crafleet"));
    return withMutex(path.join(root, ".crafleet/operation.lock"), perform);
}

export async function recoverManifests(
    root: string,
    dryRun = false,
): Promise<boolean> {
    const file = path.join(root, ".crafleet/manifest-transaction.json");
    const perform = async () => {
        await assertNoSymlinks(root, ".crafleet/manifest-transaction.json");
        if (!(await exists(file))) return false;
        if ((await lstat(file)).size > MAX_MANIFEST_JOURNAL_BYTES)
            throw new CrafleetError(
                "JOURNAL_INVALID",
                "Manifest journal exceeds its size limit.",
                4,
            );
        const invalid = () =>
            new CrafleetError(
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
                !/(^|\/)(crafleet\.yaml|crafleet-lock\.yaml|\.crafleet\/state\.json)$/.test(
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
                throw new CrafleetError(
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
                    throw new CrafleetError(
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
    await assertNoSymlinks(root, ".crafleet/manifest-transaction.json");
    if (!(await exists(file))) return false;
    return dryRun
        ? perform()
        : withMutex(path.join(root, ".crafleet/operation.lock"), perform);
}
