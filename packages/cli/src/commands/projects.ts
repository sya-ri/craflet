import path from "node:path";
import {
    diagnoseProject,
    importProject,
    initProject,
    initWorkspace,
    loadProject,
    nearestFile,
    validateManagedProject,
    workspaceProjects,
} from "@craflet/adapters";
import { CrafletError, diagnosticsFailed, parseSource } from "@craflet/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "./context.js";

export function registerProjectCommands(
    program: Command,
    context: CommandContext,
): void {
    const init = program
        .command("init [directory]")
        .description(
            "Create a server project; Paper requests EULA consent once per host user. Java is not started.",
        )
        .option("--name <name>", "project name")
        .addOption(
            new Option("--type <type>", "server implementation")
                .choices(["paper", "velocity"])
                .default("paper"),
        )
        .option(
            "--version <version>",
            "Minecraft version (Paper) or proxy version (Velocity)",
        )
        .option("--build <build>", "official build number", "latest")
        .option(
            "--source <source>",
            "explicit server JAR source, including file:",
        );
    context.action(init, async ([directory], command) => {
        const options = command.opts<{
            name?: string;
            type: "paper" | "velocity";
            version?: string;
            build: string;
            source?: string;
        }>();
        const dir = path.resolve(
            context.cwd(command),
            typeof directory === "string" ? directory : ".",
        );
        const version = await context.input(
            command,
            options.version,
            "Server version (--version) is required.",
        );
        if (options.source) parseSource(options.source);
        const manifest = await initProject(dir, {
            name: options.name ?? path.basename(dir),
            kind: options.type,
            version,
            build: options.build,
            ...(options.source ? { source: options.source } : {}),
            dryRun: context.globals(command).dryRun ?? false,
            eula: {
                home: context.home,
                requestConsent: context.requestEulaConsent,
                signal: context.abort.signal,
            },
        });
        return {
            directory: dir,
            name: manifest.name,
            server: manifest.server,
            next: "Review craflet.yaml, then run craflet install and craflet doctor.",
        };
    });
    const importer = program
        .command("import <source> [directory]")
        .description(
            "Copy a stopped existing server into a new project; leave its original files unchanged.",
        )
        .requiredOption("--name <name>", "project name")
        .addOption(
            new Option("--type <type>", "server implementation")
                .choices(["paper", "velocity"])
                .makeOptionMandatory(),
        )
        .requiredOption("--version <version>", "known server version")
        .option(
            "--server-jar <file>",
            "server JAR relative to the source directory",
            "server.jar",
        )
        .option("--stopped", "confirm the original server is stopped");
    context.action(importer, async ([source, directory], command) => {
        const options = command.opts<{
            name: string;
            type: "paper" | "velocity";
            version: string;
            serverJar: string;
            stopped?: boolean;
        }>();
        if (!options.stopped)
            throw new CrafletError(
                "SOURCE_STOPPED_REQUIRED",
                "Stop the original server, then explicitly pass --stopped.",
                3,
            );
        const cwd = context.cwd(command);
        return importProject(
            path.resolve(cwd, String(source)),
            path.resolve(cwd, String(directory ?? options.name)),
            context.home,
            {
                name: options.name,
                kind: options.type,
                version: options.version,
                serverJar: options.serverJar,
                dryRun: context.globals(command).dryRun ?? false,
            },
            context.store,
        );
    });
    const workspace = program
        .command("workspace")
        .description(
            "Manage server projects with one shared artifact lockfile.",
        );
    const workspaceInit = workspace
        .command("init [patterns...]")
        .description(
            "Create craflet-workspace.yaml; existing projects are not modified.",
        );
    context.action(workspaceInit, async ([patterns], command) => {
        const values =
            Array.isArray(patterns) && patterns.length
                ? patterns.map(String)
                : ["servers/*"];
        const directory = context.cwd(command);
        await initWorkspace(
            directory,
            values,
            context.globals(command).dryRun ?? false,
        );
        return { directory, projects: values };
    });
    context.action(
        workspace
            .command("list")
            .description("List workspace members in deterministic order."),
        async (_, command) => {
            const directories = await workspaceProjects(context.cwd(command));
            if (!directories.length)
                throw new CrafletError(
                    "EMPTY_SELECTION",
                    "No workspace projects found.",
                    2,
                );
            return Promise.all(
                directories.map(async (dir) => {
                    const project = await loadProject(dir, context.home);
                    return {
                        name: project.manifest.name,
                        directory: dir,
                        key: project.lockKey,
                    };
                }),
            );
        },
    );
    context.action(
        program
            .command("validate")
            .description(
                "Validate declarations, source syntax, lock and managed state without changing files.",
            ),
        async (_, command) =>
            Promise.all(
                (await context.projects(command)).map(validateManagedProject),
            ),
    );
    context.action(
        program
            .command("doctor")
            .description(
                "Diagnose Java, declarations, runtime, configuration and backup prerequisites without mutation.",
            ),
        async (_, command) => {
            const cwd = context.cwd(command);
            const options = context.globals(command);
            const file = await nearestFile(cwd, "craflet.yaml");
            const dirs =
                options.recursive || options.filter?.length
                    ? (await context.projects(command)).map(
                          (project) => project.dir,
                      )
                    : [file ? path.dirname(file) : cwd];
            const results = await Promise.all(
                dirs.map((dir) => diagnoseProject(dir, context.home)),
            );
            if (results.some((result) => diagnosticsFailed(result)))
                process.exitCode = 3;
            return results;
        },
    );
}
