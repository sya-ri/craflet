import path from "node:path";
import {
    type ArtifactUpdateCheck,
    addPlugins,
    checkPluginUpdates,
    checkServerUpdate,
    installProjects,
    type ProjectContext,
    pluginUpdateEntries,
    readLock,
    readState,
    removePlugins,
    serverSource,
    validateManagedProjectLock,
} from "@craflet/adapters";
import {
    type LockedArtifact,
    type LockFile,
    parsePluginSource,
    parseServerSource,
    stableStringify,
} from "@craflet/core";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";

function checkOptions(context: CommandContext, command: Command) {
    return {
        offline: context.globals(command).offline ?? false,
        signal: context.abort.signal,
    };
}

function latestFields(
    update: ArtifactUpdateCheck | undefined,
    declared = true,
): { latest: string | null; status: string } {
    if (!declared) return { latest: null, status: "undeclared" };
    if (!update) return { latest: null, status: "unknown" };
    if (update.kind === "local") return { latest: null, status: "local" };
    return {
        latest: update.latestVersion,
        status: update.updateAvailable ? "update-available" : "current",
    };
}

function serverArtifactVersion(artifact: LockedArtifact | undefined) {
    return artifact?.source.provider === "paper"
        ? artifact.source.build
        : (artifact?.version ?? null);
}

async function readProjectLocks(
    projects: ProjectContext[],
): Promise<Map<string, LockFile>> {
    const locks = new Map<string, LockFile>();
    for (const project of projects)
        if (!locks.has(project.lockRoot))
            locks.set(project.lockRoot, await readLock(project.lockRoot));
    for (const project of projects) {
        const lock = locks.get(project.lockRoot)?.projects[project.lockKey];
        if (!lock) continue;
        validateManagedProjectLock(lock, project.manifest.server.type);
    }
    return locks;
}

function projectLock(locks: Map<string, LockFile>, project: ProjectContext) {
    return locks.get(project.lockRoot)?.projects[project.lockKey];
}

function exactVersion(command: Command): string | undefined {
    const value = command.opts<{ to?: unknown }>().to;
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim())
        command.error("--to requires a non-empty version.", {
            exitCode: 2,
            code: "commander.invalidArgument",
        });
    return value;
}

async function withProjectStates(projects: readonly ProjectContext[]) {
    return Promise.all(
        projects.map(async (project) => ({
            project,
            state: await readState(project.dir),
        })),
    );
}

async function pluginInventory(
    projects: ProjectContext[],
    context: CommandContext,
    command: Command,
    includeLatest: boolean,
): Promise<unknown[]> {
    for (const project of projects) pluginUpdateEntries(project, []);
    const selected = await withProjectStates(projects);
    const locks = await readProjectLocks(projects);
    const inventory = [];
    for (const { project, state } of selected) {
        const locked = projectLock(locks, project);
        const updates = includeLatest
            ? await checkPluginUpdates(
                  project,
                  context.store,
                  [],
                  locked,
                  checkOptions(context, command),
              )
            : [];
        const updateByName = new Map(
            updates.map((update) => [update.name, update]),
        );
        const names = [
            ...new Set([
                ...Object.keys(project.manifest.plugins),
                ...Object.keys(locked?.plugins ?? {}),
                ...Object.keys(state.pending?.lock.plugins ?? {}),
                ...Object.keys(state.active?.lock.plugins ?? {}),
            ]),
        ];
        inventory.push({
            project: project.manifest.name,
            plugins: names.map((name) => {
                const requested = project.manifest.plugins[name] ?? null;
                const requestMatchesLock = Boolean(
                    requested &&
                        locked?.requests.plugins[name] ===
                            stableStringify(parsePluginSource(requested)),
                );
                return {
                    name,
                    requested,
                    requestedVersion: requestMatchesLock
                        ? (locked?.plugins[name]?.version ?? null)
                        : null,
                    locked: locked?.plugins[name]?.version ?? null,
                    active: state.active?.lock.plugins[name]?.version ?? null,
                    pending: state.pending?.lock.plugins[name]?.version ?? null,
                    ...(includeLatest
                        ? latestFields(
                              updateByName.get(name),
                              requested !== null,
                          )
                        : {}),
                };
            }),
        });
    }
    return inventory;
}

async function serverInventory(
    projects: ProjectContext[],
    context: CommandContext,
    command: Command,
    includeLatest: boolean,
): Promise<unknown[]> {
    for (const project of projects)
        parseServerSource(
            serverSource(project.manifest),
            project.manifest.server.type,
        );
    const selected = await withProjectStates(projects);
    const locks = await readProjectLocks(projects);
    const inventory = [];
    for (const { project, state } of selected) {
        const locked = projectLock(locks, project);
        const update = includeLatest
            ? await checkServerUpdate(
                  project,
                  context.store,
                  locked,
                  checkOptions(context, command),
              )
            : undefined;
        inventory.push({
            project: project.manifest.name,
            server: {
                declared: project.manifest.server,
                requested: parseServerSource(
                    serverSource(project.manifest),
                    project.manifest.server.type,
                ),
                locked: serverArtifactVersion(locked?.server),
                active: serverArtifactVersion(state.active?.lock.server),
                pending: serverArtifactVersion(state.pending?.lock.server),
                ...(includeLatest ? latestFields(update) : {}),
            },
        });
    }
    return inventory;
}

async function pluginUpdateChecks(
    projects: ProjectContext[],
    context: CommandContext,
    command: Command,
    names: string[],
): Promise<unknown[]> {
    for (const project of projects) pluginUpdateEntries(project, names);
    const locks = await readProjectLocks(projects);
    const results = [];
    for (const project of projects)
        results.push({
            project: project.manifest.name,
            updates: await checkPluginUpdates(
                project,
                context.store,
                names,
                projectLock(locks, project),
                checkOptions(context, command),
            ),
        });
    return results;
}

async function serverUpdateChecks(
    projects: ProjectContext[],
    context: CommandContext,
    command: Command,
): Promise<unknown[]> {
    for (const project of projects)
        parseServerSource(
            serverSource(project.manifest),
            project.manifest.server.type,
        );
    const locks = await readProjectLocks(projects);
    const results = [];
    for (const project of projects)
        results.push({
            project: project.manifest.name,
            updates: [
                await checkServerUpdate(
                    project,
                    context.store,
                    projectLock(locks, project),
                    checkOptions(context, command),
                ),
            ],
        });
    return results;
}

export function registerArtifactCommands(
    program: Command,
    context: CommandContext,
): void {
    context.action(
        program
            .command("install")
            .description(
                "Reproduce existing server and plugin lock entries and resolve only changed declarations.",
            )
            .option(
                "--frozen-lockfile",
                "refuse missing or out-of-date lock entries",
            ),
        async (_, command) =>
            installProjects(await context.projects(command), context.store, {
                ...context.installOptions(command),
                frozen: Boolean(command.opts().frozenLockfile),
            }),
    );

    const plugins = program
        .command("plugins")
        .description("List and manage declared plugins.")
        .option(
            "--latest",
            "include the latest provider version and update status",
        );
    context.action(plugins, async (_, command) =>
        pluginInventory(
            await context.projects(command),
            context,
            command,
            Boolean(command.opts().latest),
        ),
    );
    context.action(
        plugins
            .command("check [plugins...]")
            .description(
                "Check provider updates without editing declarations or runtime data.",
            ),
        async ([names], command) =>
            pluginUpdateChecks(
                await context.projects(command),
                context,
                command,
                names as string[],
            ),
    );
    context.action(
        plugins
            .command("inspect <jar>")
            .description(
                "Read the Paper, Bukkit/Spigot or Velocity descriptor without executing the JAR.",
            ),
        async ([jar], command) =>
            context.store.inspect(
                path.resolve(
                    context.cwd(command),
                    String(jar).replace(/^file:/, ""),
                ),
            ),
    );
    context.action(
        plugins
            .command("add <sources...>")
            .description(
                "Inspect identities, declare plugins and prepare pending; never replace running JARs.",
            ),
        async ([sources], command) =>
            addPlugins(
                await context.projects(command),
                context.store,
                sources as string[],
                context.installOptions(command),
            ),
    );
    context.action(
        plugins
            .command("remove <plugins...>")
            .description(
                "Remove plugin declarations and prepare pending; retain all plugin data.",
            ),
        async ([names], command) =>
            removePlugins(
                await context.projects(command),
                context.store,
                names as string[],
                context.installOptions(command),
            ),
    );
    const updatePlugins = plugins
        .command("update [plugins...]")
        .description(
            "Select new plugin versions, update YAML and lock data, and prepare pending.",
        )
        .option(
            "--to <version>",
            "use an explicit version for exactly one plugin",
        );
    updatePlugins.hook("preAction", (command) => {
        const selected = command.processedArgs[0];
        if (
            exactVersion(command) !== undefined &&
            (!Array.isArray(selected) || selected.length !== 1)
        )
            command.error("--to requires exactly one plugin.", {
                exitCode: 2,
                code: "commander.invalidArgument",
            });
    });
    context.action(updatePlugins, async ([names], command) => {
        const to = exactVersion(command);
        const selected = names as string[];
        return installProjects(await context.projects(command), context.store, {
            ...context.installOptions(command),
            updatePlugins: selected,
            updateAllPlugins: selected.length === 0,
            ...(to !== undefined ? { to } : {}),
        });
    });

    const server = program
        .command("server")
        .description("List and manage the declared server artifact.")
        .option(
            "--latest",
            "include the latest provider version and update status",
        );
    context.action(server, async (_, command) =>
        serverInventory(
            await context.projects(command),
            context,
            command,
            Boolean(command.opts().latest),
        ),
    );
    context.action(
        server
            .command("check")
            .description(
                "Check the provider for a server update without editing declarations or runtime data.",
            ),
        async (_, command) =>
            serverUpdateChecks(
                await context.projects(command),
                context,
                command,
            ),
    );
    const updateServer = server
        .command("update")
        .description(
            "Select a new server version, update YAML and lock data, and prepare pending.",
        )
        .option("--to <version>", "use an explicit server version");
    updateServer.hook("preAction", (command) => {
        exactVersion(command);
    });
    context.action(updateServer, async (_, command) => {
        const to = exactVersion(command);
        return installProjects(await context.projects(command), context.store, {
            ...context.installOptions(command),
            updateServer: true,
            ...(to !== undefined ? { to } : {}),
        });
    });
}
