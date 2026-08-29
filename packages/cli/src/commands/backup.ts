import path from "node:path";
import {
    applyBackupRestore,
    applyGroupBackupRestore,
    type BackupBatch,
    NodeBackupService,
    setupBackup,
} from "@craflet/adapters";
import {
    CrafletError,
    DEFAULT_BACKUP_FILES,
    validateBackupIdentifier,
} from "@craflet/core";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";
import { isCancellation, partialFailure } from "./failures.js";

export function registerBackupCommands(
    program: Command,
    context: CommandContext,
): void {
    const group = program
        .command("backup")
        .description(
            "Create verified cold snapshots of selected operating data with restic.",
        )
        .option("--repository <alias>", "configured host repository alias");
    const service = async (
        command: Command,
        options: {
            allowUnconfigured?: boolean;
            batches?: BackupBatch[];
        } = {},
    ) => {
        const batches = options.batches ?? (await context.batches(command));
        const batch = batches[0];
        const project = batch?.projects[0];
        if (batches.length !== 1 || !batch || !project)
            throw new CrafletError(
                "SINGLE_BACKUP_UNIT",
                "Select one project or one complete recovery group for this snapshot operation.",
                2,
            );
        const configured = batch.backup;
        if (!configured && !options.allowUnconfigured)
            throw new CrafletError(
                "BACKUP_REQUIRED",
                "Configure a repository using backup setup.",
                3,
            );
        const result =
            configured ??
            new NodeBackupService(project.dir, project.home, {
                ...project.manifest.backup,
                files: project.manifest.backup?.files ?? [
                    ...DEFAULT_BACKUP_FILES,
                ],
            });
        return { project, backup: result, batch };
    };
    const prepare = async (command: Command) => {
        const result = await service(command);
        const options = context.globals(command);
        await result.backup.prepare({
            offline: Boolean(options.offline || options.dryRun),
            signal: context.abort.signal,
        });
        return result;
    };
    context.action(
        group
            .command("setup [alias]")
            .description(
                "Register a local or mounted repository; --init explicitly creates a new encrypted repository.",
            )
            .option(
                "--path <directory>",
                "absolute local or mounted repository directory",
            )
            .option(
                "--password-env <name>",
                "environment variable containing the repository password",
            )
            .option(
                "--password-file <file>",
                "private password file; its contents are never stored in YAML",
            )
            .option(
                "--init",
                "explicitly initialize a new repository at the chosen destination",
            ),
        async ([alias], command) => {
            const globals = context.globals(command);
            const options = command.opts<{
                path?: string;
                passwordEnv?: string;
                passwordFile?: string;
                init?: boolean;
            }>();
            if (options.passwordEnv && options.passwordFile)
                throw new CrafletError(
                    "PASSWORD_REFERENCE",
                    "Choose either --password-env or --password-file.",
                    2,
                );
            const target = await context.input(
                command,
                options.path,
                "Backup destination (--path) is required.",
            );
            if (!path.isAbsolute(target))
                throw new CrafletError(
                    "BACKUP_ABSOLUTE",
                    "Use an absolute backup destination so a missing NAS cannot redirect snapshots.",
                    2,
                );
            const password = options.passwordFile
                ? {
                      file: path.resolve(
                          context.cwd(command),
                          options.passwordFile,
                      ),
                  }
                : {
                      env: await context.input(
                          command,
                          options.passwordEnv,
                          "Password environment variable (--password-env) is required.",
                      ),
                  };
            if (!globals.dryRun)
                await context.ask(
                    command,
                    `${options.init ? "Initialize and register" : "Verify and register"} backup repository at ${target}?`,
                );
            return setupBackup(
                await context.one(command),
                String(alias ?? "main"),
                { path: target, password },
                {
                    initialize: options.init ?? false,
                    confirm: true,
                    dryRun: globals.dryRun ?? false,
                    offline: globals.offline ?? false,
                },
            );
        },
    );
    context.action(
        group
            .command("plan")
            .description(
                "Preview exact selected paths, exclusions and staging capacity without stopping servers.",
            ),
        async (_, command) => {
            const { backup } = await service(command, {
                allowUnconfigured: true,
            });
            return backup.plan();
        },
    );
    context.action(
        group
            .command("create")
            .description(
                "Prepare tools, stop, snapshot, then restart only previously running servers with the same active.",
            )
            .option(
                "--leave-stopped",
                "do not resume after a successful backup",
            ),
        async (_, command) => {
            const batches = await context.batches(command, true);
            const dryRun = context.globals(command).dryRun ?? false;
            if (batches.length === 1 && !batches[0]?.group) {
                const { project, backup } = await service(command, { batches });
                if (dryRun) return backup.plan();
                return (await context.deployment(project, backup)).createBackup(
                    Boolean(command.opts().leaveStopped),
                );
            }
            const results = [];
            for (const batch of batches) {
                try {
                    if (batch.group)
                        results.push({
                            group: batch.group,
                            result: await context
                                .group(batch)
                                .createBackup(
                                    Boolean(command.opts().leaveStopped),
                                    dryRun,
                                ),
                        });
                    else
                        for (const project of batch.projects) {
                            if (!batch.backup)
                                throw new CrafletError(
                                    "BACKUP_REQUIRED",
                                    `Configure a backup repository for ${project.manifest.name}.`,
                                    3,
                                );
                            results.push({
                                project: project.manifest.name,
                                result: dryRun
                                    ? await batch.backup.plan()
                                    : await (
                                          await context.deployment(
                                              project,
                                              batch.backup,
                                          )
                                      ).createBackup(
                                          Boolean(command.opts().leaveStopped),
                                      ),
                            });
                        }
                } catch (error) {
                    if (isCancellation(error, context.abort.signal))
                        throw error;
                    if (batches.length === 1) throw error;
                    process.exitCode = 4;
                    results.push(
                        partialFailure(
                            error,
                            batch.group
                                ? { group: batch.group }
                                : {
                                      project:
                                          batch.projects[0]?.manifest.name ??
                                          "Selected project",
                                  },
                            "Backup creation failed; inspect this recovery unit with craflet doctor before retrying.",
                        ),
                    );
                }
            }
            return results;
        },
    );
    context.action(
        group
            .command("list")
            .description(
                "List snapshots belonging to this project or recovery group.",
            ),
        async (_, command) =>
            (await prepare(command)).backup.list({
                signal: context.abort.signal,
            }),
    );
    context.action(
        group
            .command("show <snapshot>")
            .description(
                "Show verified snapshot metadata using an explicit ID.",
            ),
        async ([id], command) =>
            (await prepare(command)).backup.show(String(id), {
                signal: context.abort.signal,
            }),
    );
    context.action(
        group
            .command("diff <before> <after>")
            .description("Compare two explicit snapshot IDs."),
        async ([before, after], command) =>
            (await prepare(command)).backup.diff(
                String(before),
                String(after),
                { signal: context.abort.signal },
            ),
    );
    context.action(
        group
            .command("check")
            .description(
                "Check repository integrity; optionally read and verify all stored data.",
            )
            .option("--read-data", "read every encrypted data pack"),
        async (_, command) =>
            (await prepare(command)).backup.check({
                readData: Boolean(command.opts().readData),
                signal: context.abort.signal,
            }),
    );
    context.action(
        group
            .command("restore <snapshot>")
            .description(
                "Restore and verify a snapshot only into an empty separate directory.",
            )
            .requiredOption("--to <directory>", "empty restore directory"),
        async ([id], command) => {
            const target = path.resolve(
                context.cwd(command),
                String(command.opts().to),
            );
            const backup = (await prepare(command)).backup;
            return context.globals(command).dryRun
                ? backup.planRestore(String(id), {
                      target,
                      signal: context.abort.signal,
                  })
                : backup.restore(String(id), {
                      target,
                      signal: context.abort.signal,
                  });
        },
    );
    context.action(
        group
            .command("apply <directory>")
            .description(
                "Verify an extracted backup, stop, take a pre-restore backup and apply; never auto-start.",
            )
            .option(
                "--map <root=path>",
                "explicit mapping for an additional data root (repeatable)",
                (value: string, previous: string[]) => [...previous, value],
                [],
            )
            .option(
                "--database <id>",
                "explicitly confirm restoring this configured database (repeatable)",
                (value: string, previous: string[]) => [...previous, value],
                [],
            ),
        async ([directory], command) => {
            const batches = await context.batches(command, true);
            const { project, backup, batch } = await service(command, {
                batches,
            });
            const globals = context.globals(command);
            if (!globals.dryRun)
                await context.ask(
                    command,
                    "Apply this restored data after stopping and creating a pre-restore backup? The server will remain stopped.",
                );
            const mappings: Record<string, string> = {};
            for (const value of command.opts<{ map: string[] }>().map) {
                const split = value.indexOf("=");
                if (split < 1)
                    throw new CrafletError(
                        "RESTORE_MAPPING",
                        "Use --map root-id=absolute-path.",
                        2,
                    );
                const id = validateBackupIdentifier(
                    value.slice(0, split),
                    "root",
                );
                if (
                    Object.hasOwn(mappings, id) ||
                    !path.isAbsolute(value.slice(split + 1))
                )
                    throw new CrafletError(
                        "RESTORE_MAPPING",
                        "Each root needs one absolute destination mapping.",
                        2,
                    );
                mappings[id] = value.slice(split + 1);
            }
            const options = {
                dryRun: globals.dryRun ?? false,
                offline: globals.offline ?? false,
                mappings,
                databases: command.opts<{ database: string[] }>().database,
                signal: context.abort.signal,
            };
            const source = path.resolve(
                context.cwd(command),
                String(directory),
            );
            return batch.group
                ? applyGroupBackupRestore(
                      batch,
                      source,
                      options,
                      context.store,
                      context.runnerEntry,
                  )
                : applyBackupRestore(
                      project,
                      source,
                      options,
                      context.store,
                      backup,
                      context.runnerEntry,
                  );
        },
    );
    context.action(
        group
            .command("prune")
            .description(
                "Preview retention by default; --apply explicitly removes eligible snapshots and unused data.",
            )
            .option("--apply", "apply configured retention and prune"),
        async (_, command) => {
            const dryRun = context.globals(command).dryRun ?? false;
            const apply = Boolean(command.opts().apply && !dryRun);
            if (apply)
                await context.ask(
                    command,
                    "Delete snapshots outside configured retention and prune unreferenced backup data?",
                );
            return (await prepare(command)).backup.prune({
                apply,
                confirm: apply,
                signal: context.abort.signal,
            });
        },
    );
    for (const command of group.commands)
        if (command.name() !== "setup")
            command.option(
                "--repository <alias>",
                "configured host repository alias",
            );
}
