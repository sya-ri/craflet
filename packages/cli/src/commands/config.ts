import path from "node:path";
import { discoverConfigCandidates, NodeConfigManager } from "@craflet/adapters";
import { type Command, Option } from "commander";
import type { CommandContext } from "./context.js";

export function registerConfigCommands(
    program: Command,
    context: CommandContext,
): void {
    const group = program
        .command("config")
        .description(
            "Manage config/ templates and explicit runtime captures without committing to Git.",
        );
    const manager = async (command: Command) => {
        const project = await context.one(command);
        return {
            project,
            config: new NodeConfigManager(
                project.dir,
                project.manifest.secrets,
            ),
        };
    };
    context.action(
        group
            .command("list")
            .description(
                "Show managed files; --candidates shows known existing server files.",
            )
            .option("--candidates", "list standard capture candidates"),
        async (_, command) => {
            const { project, config } = await manager(command);
            return command.opts().candidates
                ? discoverConfigCandidates(
                      path.join(project.dir, "runtime"),
                      project.manifest.server.type,
                  )
                : config.list();
        },
    );
    context.action(
        group
            .command("track <paths...>")
            .description(
                "Explicitly begin tracking runtime-relative configuration files.",
            ),
        async ([paths], command) => {
            const { config } = await manager(command);
            if (context.globals(command).dryRun)
                return { action: "track", paths };
            const results = [];
            for (const file of paths as string[])
                results.push(await config.track(file));
            return results;
        },
    );
    context.action(
        group
            .command("untrack <paths...>")
            .description(
                "Remove templates from config/ while keeping runtime files.",
            ),
        async ([paths], command) => {
            const { config } = await manager(command);
            if (!context.globals(command).dryRun) {
                await context.ask(
                    command,
                    "Remove these configuration templates from config/? Runtime files are retained.",
                );
                for (const file of paths as string[])
                    await config.untrack(file);
            }
            return { untracked: paths, runtimeUnchanged: true };
        },
    );
    context.action(
        group
            .command("diff")
            .description(
                "Show the three-way comparison with secret values removed.",
            ),
        async (_, command) => (await manager(command)).config.diff(),
    );
    context.action(
        group
            .command("capture [paths...]")
            .description(
                "Merge runtime changes into templates, refusing conflicts.",
            )
            .option(
                "--initial",
                "include known generated server configuration candidates",
            )
            .option(
                "--include-bans",
                "also select ban lists during initial capture",
            ),
        async ([paths], command) => {
            const { project, config } = await manager(command);
            const selected = paths as string[];
            const result = await config.capture({
                initial: Boolean(command.opts().initial),
                includeBans: Boolean(command.opts().includeBans),
                kind: project.manifest.server.type,
                dryRun: context.globals(command).dryRun ?? false,
                ...(selected.length ? { paths: selected } : {}),
            });
            if (result.conflicts.length) process.exitCode = 3;
            return result;
        },
    );
    context.action(
        group
            .command("resolve <path>")
            .description(
                "Explicitly resolve a managed conflict using the base or runtime version.",
            )
            .addOption(
                new Option("--use <side>", "chosen version")
                    .choices(["base", "runtime"])
                    .makeOptionMandatory(),
            ),
        async ([file], command) => {
            const { config } = await manager(command);
            const side = command.opts<{ use: "base" | "runtime" }>().use;
            if (!context.globals(command).dryRun) {
                await context.ask(
                    command,
                    `Resolve ${String(file)} using ${side}?`,
                );
                await config.resolve(String(file), side);
            }
            return { path: file, resolution: side };
        },
    );
}
