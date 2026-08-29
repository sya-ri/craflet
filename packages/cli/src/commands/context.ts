import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, isCancel, text } from "@clack/prompts";
import {
    type BackupBatch,
    backupService,
    crafletHome,
    NodeArtifactStore,
    NodeDeploymentManager,
    NodeRecoveryGroup,
    NodeServerController,
    nearestFile,
    type ProjectContext,
    resolveBackupBatches,
    selectProjects,
} from "@craflet/adapters";
import { type BackupService, CrafletError } from "@craflet/core";
import type { Command } from "commander";
import { confirmEula } from "../presentation/eula.js";
import type { HumanResultContext } from "../presentation/human.js";
import { printError, printResult } from "../presentation/output.js";

export interface Globals {
    cwd?: string;
    recursive?: boolean;
    filter?: string[];
    json?: boolean;
    yes?: boolean;
    offline?: boolean;
    dryRun?: boolean;
}
export class CommandContext {
    readonly home = crafletHome();
    readonly store = new NodeArtifactStore(this.home);
    readonly abort = new AbortController();
    readonly runnerEntry: string;
    private activeGlobals: Globals = {};
    readonly requestEulaConsent = async (document: {
        path: string;
        text: string;
        url: string;
    }): Promise<void> => {
        try {
            await confirmEula(document, {
                yes: this.activeGlobals.yes ?? false,
                json: this.activeGlobals.json ?? false,
                signal: this.abort.signal,
            });
        } catch (error) {
            if (error instanceof CrafletError && error.code === "CANCELLED")
                this.abort.abort();
            throw error;
        }
    };
    constructor(entryUrl: string) {
        this.runnerEntry = fileURLToPath(new URL("./runner.mjs", entryUrl));
    }
    globals(command: Command): Globals {
        const chain: Command[] = [];
        for (
            let current: Command | null = command;
            current;
            current = current.parent
        )
            chain.unshift(current);
        const result: Record<string, unknown> = {};
        for (const current of chain)
            for (const key of [
                "cwd",
                "recursive",
                "filter",
                "json",
                "yes",
                "offline",
                "dryRun",
            ] as const) {
                const value: unknown = current.opts()[key];
                if (
                    value === undefined ||
                    current.getOptionValueSource(key) === "default"
                )
                    continue;
                result[key] =
                    key === "filter"
                        ? [
                              ...((result[key] as string[]) ?? []),
                              ...(value as string[]),
                          ]
                        : value;
            }
        return result as Globals;
    }
    cwd(command: Command): string {
        return path.resolve(this.globals(command).cwd ?? process.cwd());
    }
    projects(command: Command): Promise<ProjectContext[]> {
        const options = this.globals(command);
        return selectProjects(this.cwd(command), this.home, {
            recursive: options.recursive ?? false,
            filters: options.filter ?? [],
        });
    }
    async one(command: Command): Promise<ProjectContext> {
        const projects = await this.projects(command);
        if (projects.length !== 1 || !projects[0])
            throw new CrafletError(
                "SINGLE_PROJECT",
                "This operation requires exactly one project.",
                2,
            );
        return projects[0];
    }
    async runtimeDir(command: Command): Promise<string> {
        if (
            this.globals(command).recursive ||
            this.globals(command).filter?.length
        )
            return (await this.one(command)).dir;
        const file = await nearestFile(this.cwd(command), "craflet.yaml");
        if (!file)
            throw new CrafletError(
                "NO_PROJECT",
                "No craflet.yaml was found.",
                2,
            );
        return path.dirname(file);
    }
    async deployment(
        project: ProjectContext,
        backup?: BackupService,
        launch = false,
    ): Promise<NodeDeploymentManager> {
        return new NodeDeploymentManager(
            project,
            this.store,
            backup ?? (await backupService(project)),
            this.runnerEntry,
            undefined,
            {
                offline: this.activeGlobals.offline ?? false,
                signal: this.abort.signal,
                ...(launch
                    ? { requestEulaConsent: this.requestEulaConsent }
                    : {}),
            },
        );
    }
    async batches(command: Command, complete = false): Promise<BackupBatch[]> {
        const repository = command.optsWithGlobals<{ repository?: string }>()
            .repository;
        return resolveBackupBatches(await this.projects(command), {
            complete,
            ...(repository ? { repository } : {}),
        });
    }
    group(batch: BackupBatch, launch = false): NodeRecoveryGroup {
        return new NodeRecoveryGroup(batch, this.store, this.runnerEntry, {
            offline: this.activeGlobals.offline ?? false,
            signal: this.abort.signal,
            ...(launch ? { requestEulaConsent: this.requestEulaConsent } : {}),
        });
    }
    async controller(command: Command): Promise<NodeServerController> {
        return new NodeServerController(
            await this.runtimeDir(command),
            this.home,
            this.runnerEntry,
            this.abort.signal,
        );
    }
    installOptions(command: Command) {
        const options = this.globals(command);
        return {
            offline: options.offline ?? false,
            dryRun: options.dryRun ?? false,
            signal: this.abort.signal,
        };
    }
    async ask(command: Command, message: string): Promise<void> {
        if (this.globals(command).yes) return;
        if (this.globals(command).json || !process.stdin.isTTY)
            throw new CrafletError(
                "CONFIRMATION_REQUIRED",
                `${message} Supply --yes to confirm this explicitly requested operation.`,
                3,
            );
        const answer = await confirm({ message, output: process.stderr });
        if (isCancel(answer) || !answer) {
            this.abort.abort();
            throw new CrafletError("CANCELLED", "Operation cancelled.", 130);
        }
    }
    async input(
        command: Command,
        value: string | undefined,
        message: string,
    ): Promise<string> {
        if (value) return value;
        if (
            this.globals(command).json ||
            !process.stdin.isTTY ||
            this.globals(command).yes
        )
            throw new CrafletError("INPUT_REQUIRED", message, 2);
        const answer = await text({ message, output: process.stderr });
        if (isCancel(answer)) {
            this.abort.abort();
            throw new CrafletError("CANCELLED", "Operation cancelled.", 130);
        }
        if (!answer.trim())
            throw new CrafletError("INPUT_REQUIRED", message, 2);
        return answer;
    }
    action(
        command: Command,
        handler: (args: unknown[], command: Command) => Promise<unknown>,
    ): void {
        command.action(async (...args: unknown[]) => {
            const current = args.at(-1) as Command;
            this.activeGlobals = this.globals(current);
            const positional = args.slice(0, -2);
            const commandPath = this.commandPath(current);
            const artifactMutation = this.artifactMutation(
                commandPath,
                positional,
                current,
            );
            const presentation = {
                command: commandPath,
                dryRun: this.globals(current).dryRun ?? false,
                ...(artifactMutation ? { artifactMutation } : {}),
            };
            try {
                printResult(
                    await handler(positional, current),
                    this.globals(current).json ?? false,
                    presentation,
                );
            } catch (error) {
                printError(error, this.globals(current).json ?? false);
            }
        });
    }
    private commandPath(command: Command): string {
        const names: string[] = [];
        for (
            let current: Command | null = command;
            current?.parent;
            current = current.parent
        )
            names.unshift(current.name());
        return names.join(" ");
    }
    private artifactMutation(
        commandPath: string,
        positional: unknown[],
        command: Command,
    ): NonNullable<HumanResultContext["artifactMutation"]> | undefined {
        if (commandPath !== "update" && commandPath !== "remove")
            return undefined;
        const first = positional[0];
        const plugins = Array.isArray(first)
            ? first.filter(
                  (value): value is string => typeof value === "string",
              )
            : typeof first === "string"
              ? [first]
              : [];
        const options = command.opts<{ server?: boolean; all?: boolean }>();
        return {
            plugins,
            server: commandPath === "update" && options.server === true,
            all: commandPath === "update" && options.all === true,
        };
    }
}
