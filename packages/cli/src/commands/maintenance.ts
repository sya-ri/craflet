import {
    inspectArtifactCache,
    pruneArtifactCache,
    ResticBootstrap,
} from "@craflet/adapters";
import { CrafletError } from "@craflet/core";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";

export function registerMaintenanceCommands(
    program: Command,
    context: CommandContext,
): void {
    const cache = program
        .command("cache")
        .description("Inspect the shared content-addressed JAR cache.");
    context.action(
        cache
            .command("info")
            .description(
                "Show cache entries and storage usage without downloading.",
            ),
        async () => inspectArtifactCache(context.home, false),
    );
    context.action(
        cache
            .command("verify")
            .description(
                "Rehash every complete cached JAR; never repair or remove silently.",
            ),
        async () => {
            const result = await inspectArtifactCache(context.home, true);
            if (result.entries.some((entry) => entry.valid === false))
                process.exitCode = 3;
            return result;
        },
    );
    context.action(
        cache
            .command("prune")
            .description(
                "Preview unreferenced cache entries; --apply deletes only unreferenced complete objects.",
            )
            .option("--apply", "delete planned unused entries"),
        async (_, command) => {
            const apply = Boolean(
                command.opts().apply && !context.globals(command).dryRun,
            );
            if (apply)
                await context.ask(
                    command,
                    "Remove unused complete JAR cache entries? Active, pending and registered lock references are retained.",
                );
            return pruneArtifactCache(context.home, apply);
        },
    );
    const tools = program
        .command("tools")
        .description(
            "Prepare verified external tools before stopping a server.",
        );
    context.action(
        tools
            .command("prepare <tool>")
            .description(
                "Install the pinned official restic executable into CRAFLET_HOME.",
            ),
        async ([tool], command) => {
            if (tool !== "restic")
                throw new CrafletError(
                    "TOOL_UNKNOWN",
                    "Only restic is a managed external tool.",
                    2,
                );
            if (context.globals(command).dryRun)
                return {
                    tool: "restic",
                    action: "prepare",
                    home: context.home,
                };
            return new ResticBootstrap(context.home).prepare({
                offline: context.globals(command).offline ?? false,
                signal: context.abort.signal,
            });
        },
    );
}
