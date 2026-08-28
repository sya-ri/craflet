import path from "node:path";
import {
    addPlugins,
    installProjects,
    outdatedPlugins,
    readLock,
    readState,
    removePlugins,
} from "@craflet/adapters";
import { CrafletError } from "@craflet/core";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";

export function registerArtifactCommands(
    program: Command,
    context: CommandContext,
): void {
    context.action(
        program
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
        program
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
        program
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
    context.action(
        program
            .command("list")
            .description(
                "List declared, locked, pending and active plugin versions.",
            ),
        async (_, command) =>
            Promise.all(
                (await context.projects(command)).map(async (project) => {
                    const locked = (await readLock(project.lockRoot)).projects[
                        project.lockKey
                    ];
                    const state = await readState(project.dir);
                    const names = [
                        ...new Set([
                            ...Object.keys(project.manifest.plugins),
                            ...Object.keys(state.active?.lock.plugins ?? {}),
                        ]),
                    ];
                    return {
                        project: project.manifest.name,
                        server: {
                            declared: project.manifest.server,
                            locked: locked?.server.version ?? null,
                            active: state.active?.lock.server.version ?? null,
                        },
                        plugins: names.map((name) => ({
                            name,
                            requested: project.manifest.plugins[name] ?? null,
                            locked: locked?.plugins[name]?.version ?? null,
                            active:
                                state.active?.lock.plugins[name]?.version ??
                                null,
                            pending:
                                state.pending?.lock.plugins[name]?.version ??
                                null,
                        })),
                    };
                }),
            ),
    );
    context.action(
        program
            .command("install")
            .description(
                "Reproduce existing lock entries and resolve only changed declarations.",
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
    context.action(
        program
            .command("outdated [plugins...]")
            .description(
                "Query available updates without editing declarations or runtime.",
            )
            .option("--server", "check the server within its declared version")
            .option("--all", "check plugins and server"),
        async ([names], command) =>
            Promise.all(
                (await context.projects(command)).map(async (project) => ({
                    project: project.manifest.name,
                    updates: await outdatedPlugins(
                        project,
                        context.store,
                        names as string[],
                        {
                            server: Boolean(command.opts().server),
                            all: Boolean(command.opts().all),
                            offline: context.globals(command).offline ?? false,
                            signal: context.abort.signal,
                        },
                    ),
                })),
            ),
    );
    context.action(
        program
            .command("update [plugins...]")
            .description(
                "Select new versions, update YAML/lock and prepare pending for the next start.",
            )
            .option(
                "--server",
                "update only the server build within its declared version",
            )
            .option("--all", "update plugins and server")
            .option(
                "--to <version>",
                "explicit version for one plugin, or one server build",
            ),
        async ([names], command) => {
            const options = command.opts<{
                server?: boolean;
                all?: boolean;
                to?: string;
            }>();
            const selected = names as string[];
            if (options.server && selected.length > 0)
                throw new CrafletError(
                    "UPDATE_TARGET",
                    "Use either --server or explicit plugin names; use --all to update both.",
                    2,
                );
            if (
                options.to &&
                (options.all ||
                    (!(options.server && selected.length === 0) &&
                        selected.length !== 1))
            )
                throw new CrafletError(
                    "UPDATE_TARGET",
                    "--to requires exactly one plugin or --server.",
                    2,
                );
            return installProjects(
                await context.projects(command),
                context.store,
                {
                    ...context.installOptions(command),
                    updatePlugins: selected,
                    updateAllPlugins: Boolean(
                        options.all ||
                            (!options.server && selected.length === 0),
                    ),
                    updateServer: Boolean(options.server || options.all),
                    ...(options.to ? { to: options.to } : {}),
                },
            );
        },
    );
}
