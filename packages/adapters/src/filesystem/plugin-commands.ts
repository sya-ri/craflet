import {
    type ArtifactStore,
    CrafleetError,
    formatSource,
    type LockedArtifact,
    type ProjectLock,
    parsePluginSource,
    parseServerSource,
    parseSource,
    portablePluginJarName,
    type SourceInput,
    stableStringify,
    validatePluginIdentities,
} from "@crafleet/core";
import {
    artifactContext,
    type InstallOptions,
    installProjects,
    prepareInstallProjects,
    serverSource,
} from "./installations.js";
import type { ProjectContext } from "./projects.js";

export async function addPlugins(
    projects: ProjectContext[],
    store: ArtifactStore,
    sources: SourceInput[],
    options: InstallOptions = {},
): Promise<unknown> {
    for (const source of sources) parsePluginSource(source);
    if (options.frozen)
        throw new CrafleetError(
            "FROZEN_LOCK",
            "Adding plugins requires a lockfile update.",
            2,
        );
    const preparation = await prepareInstallProjects(projects, options);
    if (options.dryRun)
        return {
            action: "add",
            projects: projects.map((project) => project.manifest.name),
            sources,
            note: "JAR identities will be resolved and verified when this operation is applied.",
        };
    const next = projects.map((project) => ({
        ...project,
        manifest: structuredClone(project.manifest),
    }));
    for (const project of next) {
        const namespace = preparation.pluginNamespaces.get(project.dir);
        if (!namespace)
            throw new CrafleetError(
                "CONCURRENT_EDIT",
                "The prepared project set no longer matches the requested projects.",
                3,
            );
        const identities = [...namespace.identities];
        for (const source of sources) {
            const artifact = await store.resolve(
                source,
                artifactContext(project, options),
            );
            parsePluginSource(artifact.source);
            if (!artifact.identity)
                throw new CrafleetError(
                    "NOT_PLUGIN",
                    "The source does not contain a supported plugin descriptor.",
                    2,
                );
            const id = artifact.identity.id;
            if (Object.hasOwn(project.manifest.plugins, id))
                throw new CrafleetError(
                    "PLUGIN_EXISTS",
                    `Plugin ${id} is already declared. Use crafleet plugins update or crafleet plugins remove first.`,
                    2,
                );
            validatePluginIdentities(
                [...identities, artifact.identity],
                project.manifest.server.type,
                namespace.reservedIds,
            );
            identities.push(artifact.identity);
            project.manifest.plugins[id] = formatSource(artifact.source);
        }
    }
    return installProjects(next, store, options, preparation);
}

export async function removePlugins(
    projects: ProjectContext[],
    store: ArtifactStore,
    names: string[],
    options: InstallOptions = {},
): Promise<unknown> {
    const next = projects.map((project) => ({
        ...project,
        manifest: structuredClone(project.manifest),
    }));
    for (const project of next)
        for (const name of names) {
            if (!Object.hasOwn(project.manifest.plugins, name))
                throw new CrafleetError(
                    "PLUGIN_UNKNOWN",
                    `Plugin ${name} is not declared.`,
                    2,
                );
            delete project.manifest.plugins[name];
        }
    return installProjects(next, store, options);
}

export type ArtifactUpdateCheck =
    | {
          kind: "local";
          name: string;
          lockedVersion: string | null;
      }
    | {
          kind: "provider";
          name: string;
          lockedVersion: string | null;
          latestVersion: string;
          latestSource: SourceInput;
          updateAvailable: boolean;
      };

export interface ArtifactUpdateCheckOptions {
    offline?: boolean;
    signal?: AbortSignal;
}

export function pluginUpdateEntries(
    project: ProjectContext,
    names: readonly string[],
): [string, SourceInput][] {
    validatePluginIdentities(
        [],
        project.manifest.server.type,
        Object.keys(project.manifest.plugins),
    );
    const selected = names.length
        ? names
        : Object.keys(project.manifest.plugins);
    return selected.map((name) => {
        portablePluginJarName(name);
        const source = project.manifest.plugins[name];
        if (source === undefined)
            throw new CrafleetError(
                "PLUGIN_UNKNOWN",
                `Unknown plugin: ${name}`,
                2,
            );
        parsePluginSource(source);
        return [name, source];
    });
}

async function checkArtifactUpdate(
    project: ProjectContext,
    store: ArtifactStore,
    name: string,
    source: SourceInput,
    current: LockedArtifact | undefined,
    options: ArtifactUpdateCheckOptions,
): Promise<ArtifactUpdateCheck> {
    options.signal?.throwIfAborted();
    const parsed = parseSource(source);
    if (parsed.provider === "file")
        return {
            kind: "local",
            name,
            lockedVersion: current?.version ?? null,
        };
    const latest = await store.latest(
        source,
        artifactContext(project, options),
    );
    return {
        kind: "provider",
        name,
        lockedVersion:
            current?.source.provider === "paper"
                ? current.source.build
                : (current?.version ?? null),
        latestSource: formatSource(latest.source),
        latestVersion: latest.version,
        updateAvailable:
            !current ||
            stableStringify(current.source) !== stableStringify(latest.source),
    };
}

export async function checkPluginUpdates(
    project: ProjectContext,
    store: ArtifactStore,
    names: string[],
    lock: ProjectLock | undefined,
    options: ArtifactUpdateCheckOptions = {},
): Promise<ArtifactUpdateCheck[]> {
    const entries = pluginUpdateEntries(project, names);
    const result: ArtifactUpdateCheck[] = [];
    for (const [name, source] of entries) {
        result.push(
            await checkArtifactUpdate(
                project,
                store,
                name,
                source,
                lock?.plugins[name],
                options,
            ),
        );
    }
    return result;
}

export async function checkServerUpdate(
    project: ProjectContext,
    store: ArtifactStore,
    lock: ProjectLock | undefined,
    options: ArtifactUpdateCheckOptions = {},
): Promise<ArtifactUpdateCheck> {
    const source = serverSource(project.manifest);
    parseServerSource(source, project.manifest.server.type);
    return checkArtifactUpdate(
        project,
        store,
        "server",
        source,
        lock?.server,
        options,
    );
}
