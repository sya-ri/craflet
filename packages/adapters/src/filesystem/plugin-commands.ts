import {
    type ArtifactStore,
    CrafletError,
    formatSource,
    parseSource,
    portablePluginJarName,
    type SourceInput,
    stableStringify,
} from "@craflet/core";
import {
    artifactContext,
    type InstallOptions,
    installProjects,
    serverSource,
    snapshotInstallInputs,
} from "./installations.js";
import { type ProjectContext, readLock } from "./projects.js";

export async function addPlugins(
    projects: ProjectContext[],
    store: ArtifactStore,
    sources: SourceInput[],
    options: InstallOptions = {},
): Promise<unknown> {
    for (const source of sources) parseSource(source);
    if (options.dryRun)
        return {
            action: "add",
            projects: projects.map((project) => project.manifest.name),
            sources,
            note: "JAR identities will be resolved and verified when this operation is applied.",
        };
    const snapshot = await snapshotInstallInputs(projects);
    const next = projects.map((project) => ({
        ...project,
        manifest: structuredClone(project.manifest),
    }));
    for (const project of next) {
        for (const source of sources) {
            const artifact = await store.resolve(
                source,
                artifactContext(project, options),
            );
            if (!artifact.identity)
                throw new CrafletError(
                    "NOT_PLUGIN",
                    "The source does not contain a supported plugin descriptor.",
                    2,
                );
            const id = artifact.identity.id;
            portablePluginJarName(id);
            if (Object.hasOwn(project.manifest.plugins, id))
                throw new CrafletError(
                    "PLUGIN_EXISTS",
                    `Plugin ${id} is already declared. Use update or remove first.`,
                    2,
                );
            project.manifest.plugins[id] = formatSource(artifact.source);
        }
    }
    return installProjects(next, store, options, snapshot);
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
                throw new CrafletError(
                    "PLUGIN_UNKNOWN",
                    `Plugin ${name} is not declared.`,
                    2,
                );
            delete project.manifest.plugins[name];
        }
    return installProjects(next, store, options);
}

export async function outdatedPlugins(
    project: ProjectContext,
    store: ArtifactStore,
    names: string[],
    options: {
        server?: boolean;
        all?: boolean;
        offline?: boolean;
        signal?: AbortSignal;
    } = {},
): Promise<unknown[]> {
    const lock = (await readLock(project.lockRoot)).projects[project.lockKey];
    const selected =
        options.server && !options.all
            ? []
            : names.length
              ? names
              : Object.keys(project.manifest.plugins);
    const entries: [string, SourceInput][] = selected.map((name) => {
        const source = project.manifest.plugins[name];
        if (!source)
            throw new CrafletError(
                "PLUGIN_UNKNOWN",
                `Unknown plugin: ${name}`,
                2,
            );
        return [name, source];
    });
    if (options.server || options.all)
        entries.push(["(server)", serverSource(project.manifest)]);
    const result: unknown[] = [];
    for (const [name, source] of entries) {
        options.signal?.throwIfAborted();
        const current =
            name === "(server)" ? lock?.server : lock?.plugins[name];
        const parsed = parseSource(source);
        if (parsed.provider === "file") {
            result.push({
                name,
                current: current?.version ?? null,
                status: "local",
                hint: "Use update to reimport the local JAR, including changes with an unchanged version label.",
            });
            continue;
        }
        const latest = await store.latest(
            source,
            artifactContext(project, options),
        );
        result.push({
            name,
            current: current?.version ?? null,
            currentVersion:
                current?.source.provider === "paper"
                    ? current.source.build
                    : (current?.version ?? null),
            available: formatSource(latest.source),
            availableVersion: latest.version,
            changed:
                !current ||
                stableStringify(current.source) !==
                    stableStringify(latest.source),
        });
    }
    return result;
}
