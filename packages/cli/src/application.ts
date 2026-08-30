import { CRAFLEET_VERSION, CrafleetError } from "@crafleet/core";
import { Command, CommanderError } from "commander";
import { CommandContext } from "./commands/context.js";
import { registerCommands } from "./commands/register.js";
import { printError } from "./presentation/output.js";

function globalOptions(command: Command): void {
    command
        .enablePositionalOptions()
        .option("-C, --cwd <directory>", "Project or workspace directory")
        .option("-r, --recursive", "Select all workspace projects")
        .option(
            "--filter <pattern>",
            "Select project names or relative paths",
            (value: string, previous: string[]) => [...previous, value],
            [],
        )
        .option("--json", "Write machine-readable JSON to stdout")
        .option(
            "--yes",
            "Confirm the requested operation, including EULA consent during Paper init or launch",
        )
        .option("--offline", "Do not contact artifact providers")
        .option(
            "--dry-run",
            "Preview without changing declarations or runtime data",
        );
    for (const child of command.commands) globalOptions(child);
}

export function createCli(
    entryUrl: string,
    json = false,
): { program: Command; context: CommandContext } {
    const program = new Command();
    program
        .name("crafleet")
        .description(
            "Manage reproducible Minecraft servers, safe updates and cold backups.",
        )
        .version(CRAFLEET_VERSION);
    program.exitOverride().configureOutput({
        writeOut: (text) =>
            process.stdout.write(
                json
                    ? `${JSON.stringify({ ok: true, help: text.trimEnd() })}\n`
                    : text,
            ),
        // Commander includes raw rejected argument values in some errors.
        // Render the bounded usage diagnostic below instead of leaking them.
        writeErr: () => {},
    });
    const context = new CommandContext(entryUrl);
    registerCommands(program, context);
    // Positional options let init/import own --version. Repeating only common
    // options at each level also supports --json/-C before or after a command.
    globalOptions(program);
    return { program, context };
}

export async function runCli(args: string[], entryUrl: string): Promise<void> {
    const json =
        args.find((argument) => argument === "--json" || argument === "--") ===
        "--json";
    const { program, context } = createCli(entryUrl, json);
    const interrupt = () => context.abort.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
        await program.parseAsync(args, { from: "user" });
    } catch (error) {
        if (!(error instanceof CommanderError && error.exitCode === 0))
            printError(
                error instanceof CommanderError
                    ? new CrafleetError(
                          "CLI_USAGE",
                          "Invalid or missing command arguments.",
                          2,
                          "Use crafleet <command> --help to see accepted arguments. Input values are omitted.",
                      )
                    : error,
                json,
            );
    } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
    }
}
