import {
    followServerLogsFrom,
    readOlderServerLogs,
    readRecentServerLogs,
    recoverBackupRestore,
    recoverGroupBackupRestore,
    recoverManifests,
    recoverProcessLocks,
} from "@craflet/adapters";
import { CrafletError } from "@craflet/core";
import type { Command } from "commander";
import { openInteractiveConsole } from "../presentation/console.js";
import { formatRuntimeLogChunk } from "../presentation/terminal.js";
import type { CommandContext } from "./context.js";
import { isCancellation, partialFailure } from "./failures.js";

function withoutFinalLogTerminator(text: string): string {
    return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export function registerRuntimeCommands(
    program: Command,
    context: CommandContext,
): void {
    const operate = async (
        command: Command,
        action: "start" | "restart" | "stop",
    ) => {
        const dryRun = context.globals(command).dryRun ?? false;
        if (action !== "stop") {
            const batches = await context.batches(command, true);
            const active = Boolean(command.opts().active);
            const results: unknown[] = [];
            for (const batch of batches) {
                try {
                    if (batch.group)
                        results.push({
                            group: batch.group,
                            result: await context
                                .group(batch, true)
                                .operate(action, active, dryRun),
                        });
                    else {
                        const project = batch.projects[0];
                        if (!project)
                            throw new CrafletError(
                                "EMPTY_SELECTION",
                                "No project selected.",
                                2,
                            );
                        const deployment = await context.deployment(
                            project,
                            undefined,
                            true,
                        );
                        results.push({
                            project: project.manifest.name,
                            result: dryRun
                                ? await deployment.plan()
                                : await deployment[action](active),
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
                            "Operation failed; inspect this recovery unit's doctor and logs.",
                        ),
                    );
                }
            }
            return results;
        }
        const projects = await context.projects(command);
        const results: unknown[] = [];
        for (const project of projects) {
            try {
                const deployment = await context.deployment(project);
                const value = dryRun
                    ? { action, ...(await deployment.plan()) }
                    : await deployment.stop(Boolean(command.opts().force));
                results.push({
                    project: project.manifest.name,
                    ok: true,
                    result: value,
                });
            } catch (error) {
                if (isCancellation(error, context.abort.signal)) throw error;
                if (projects.length === 1) throw error;
                process.exitCode = 4;
                results.push(
                    partialFailure(
                        error,
                        { project: project.manifest.name },
                        "Operation failed; inspect this project's doctor and logs.",
                    ),
                );
            }
        }
        return results;
    };
    for (const action of ["start", "restart"] as const)
        context.action(
            program
                .command(action)
                .description(
                    `${action === "start" ? "Start" : "Gracefully restart"} the server, applying verified pending only after a cold backup.`,
                )
                .option(
                    "--active",
                    "start the current active installation; do not apply pending",
                ),
            async (_, command) => operate(command, action),
        );
    context.action(
        program
            .command("stop")
            .description(
                "Gracefully stop and verify Java has exited; never apply pending.",
            )
            .option(
                "--force",
                "explicitly kill only this runner's authenticated Java child",
            ),
        async (_, command) => {
            const globals = context.globals(command);
            const force = Boolean(command.opts().force);
            if (force && !globals.dryRun)
                await context.ask(
                    command,
                    "Force termination can lose server data. Terminate this owned Java process?",
                );
            // Broken YAML must not prevent stopping the current owned process.
            if (!globals.recursive && !globals.filter?.length) {
                const controller = await context.controller(command);
                return globals.dryRun
                    ? controller.status()
                    : controller.stop(force);
            }
            return operate(command, "stop");
        },
    );
    context.action(
        program
            .command("status")
            .description(
                "Query the authenticated runner; ambiguous or unreachable processes are unknown.",
            ),
        async (_, command) => {
            const globals = context.globals(command);
            if (!globals.recursive && !globals.filter?.length)
                return (await context.controller(command)).status();
            return Promise.all(
                (await context.projects(command)).map(async (project) => ({
                    project: project.manifest.name,
                    ...(await (
                        await context.deployment(project)
                    ).controller.status()),
                })),
            );
        },
    );
    context.action(
        program
            .command("command <text>")
            .description(
                "Send one console command to the authenticated runner.",
            ),
        async ([text], command) => {
            const dryRun = context.globals(command).dryRun ?? false;
            if (!dryRun)
                await (await context.controller(command)).command(String(text));
            return { sent: !dryRun };
        },
    );
    const streamLogs = async (command: Command, stopOnInterrupt = false) => {
        const dir = await context.runtimeDir(command);
        const json = context.globals(command).json ?? false;
        const controller = await context.controller(command);
        const abort = new AbortController();
        const output = (chunk: string) => {
            if (chunk) process.stdout.write(formatRuntimeLogChunk(chunk, json));
        };
        const onAbort = () => {
            abort.abort();
        };
        context.abort.signal.addEventListener("abort", onAbort, {
            once: true,
        });
        if (context.abort.signal.aborted) abort.abort();
        const poll = stopOnInterrupt
            ? setInterval(() => {
                  void controller
                      .status()
                      .then((status) => {
                          if (status.status === "stopped") abort.abort();
                      })
                      .catch(() => abort.abort());
              }, 500)
            : undefined;
        try {
            const lines = Number(command.opts().lines ?? 100);
            let snapshot = await readRecentServerLogs(dir, lines);
            output(snapshot.text);
            while (!abort.signal.aborted) {
                let reset = false;
                for await (const event of followServerLogsFrom(
                    dir,
                    snapshot.follow,
                    abort.signal,
                )) {
                    if (event.kind === "append") output(event.text);
                    else {
                        reset = true;
                        break;
                    }
                }
                if (!reset || abort.signal.aborted) break;
                snapshot = await readRecentServerLogs(dir, lines);
                output(snapshot.text);
            }
        } finally {
            if (poll) clearInterval(poll);
            context.abort.signal.removeEventListener("abort", onAbort);
            if (
                stopOnInterrupt &&
                (await controller.status()).status === "running"
            )
                await controller.stop();
        }
        return {
            detached: !stopOnInterrupt,
            status: await controller.status(),
        };
    };
    context.action(
        program
            .command("logs")
            .description(
                "Read redacted runner logs; Ctrl-C detaches without stopping the server.",
            )
            .option("-n, --lines <number>", "number of tail lines", "100")
            .option("-f, --follow", "continue following the log"),
        async (_, command) => {
            if (command.opts().follow && !context.globals(command).dryRun)
                return streamLogs(command);
            const snapshot = await readRecentServerLogs(
                await context.runtimeDir(command),
                Number(command.opts().lines),
            );
            return withoutFinalLogTerminator(snapshot.text);
        },
    );
    context.action(
        program
            .command("run")
            .description(
                "Start and follow the server in this terminal; Ctrl-C requests graceful stop.",
            )
            .option("--active", "leave pending untouched"),
        async (_, command) => {
            const project = await context.one(command);
            await context.batches(command, true);
            const deployment = await context.deployment(
                project,
                undefined,
                true,
            );
            if (context.globals(command).dryRun) return deployment.plan();
            try {
                await deployment.start(Boolean(command.opts().active));
            } catch (error) {
                if (context.abort.signal.aborted) {
                    const status = await deployment.controller.status();
                    if (
                        ["starting", "running", "stopping"].includes(
                            status.status,
                        )
                    )
                        await deployment.controller.stop();
                }
                throw error;
            }
            return streamLogs(command, true);
        },
    );
    context.action(
        program
            .command("console")
            .description(
                "Open recent logs and interactive input; scroll up for history, Ctrl-C detaches.",
            ),
        async (_, command) => {
            const controller = await context.controller(command);
            if (context.globals(command).dryRun) return controller.status();
            if (
                context.globals(command).json ||
                !process.stdin.isTTY ||
                !process.stdout.isTTY
            )
                throw new CrafletError(
                    "CONSOLE_TTY",
                    "console requires a terminal. Use command <text> for scripts.",
                    2,
                );
            if ((await controller.status()).status !== "running")
                throw new CrafletError(
                    "SERVER_NOT_RUNNING",
                    "Start the server before attaching its console.",
                    3,
                );
            const dir = await context.runtimeDir(command);
            await openInteractiveConsole({
                loadRecent: () => readRecentServerLogs(dir),
                loadOlder: (cursor) => readOlderServerLogs(dir, cursor),
                follow: (checkpoint, signal) =>
                    followServerLogsFrom(dir, checkpoint, signal),
                sendCommand: (text) => controller.command(text),
                signal: context.abort.signal,
            });
            return { detached: true, serverStopped: false };
        },
    );
    const deploy = program
        .command("deploy")
        .description("Inspect and apply prepared installations.");
    context.action(
        deploy
            .command("plan")
            .description("Show pending application without modifying files."),
        async (_, command) =>
            Promise.all(
                (await context.projects(command)).map(async (project) => ({
                    project: project.manifest.name,
                    ...(await (await context.deployment(project)).plan()),
                })),
            ),
    );
    context.action(
        deploy
            .command("apply")
            .description(
                "Require stopped servers, take a cold backup and apply pending; do not start Java.",
            ),
        async (_, command) => {
            const results = [];
            const batches = await context.batches(command, true);
            const dryRun = context.globals(command).dryRun ?? false;
            for (const batch of batches) {
                try {
                    if (batch.group)
                        results.push({
                            group: batch.group,
                            result: await context
                                .group(batch)
                                .operate("apply", false, dryRun),
                        });
                    else
                        for (const project of batch.projects)
                            results.push({
                                project: project.manifest.name,
                                result: await (
                                    await context.deployment(project)
                                ).apply(dryRun),
                            });
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
                            "Deployment application failed; inspect this recovery unit with craflet doctor and craflet deploy plan.",
                        ),
                    );
                }
            }
            return results;
        },
    );
    context.action(
        deploy
            .command("discard")
            .description(
                "Remove pending only; leave YAML, lock and active untouched.",
            ),
        async (_, command) => {
            const projects = await context.projects(command);
            const dryRun = context.globals(command).dryRun ?? false;
            if (!dryRun)
                await context.ask(
                    command,
                    "Discard prepared pending installations? Desired YAML and lock remain unchanged.",
                );
            const unitKeys = new Set(
                projects.map((project) =>
                    project.manifest.backup?.group
                        ? `group:${project.manifest.backup.group}`
                        : `project:${project.dir}`,
                ),
            );
            const failedGroups = new Set<string>();
            const discarded: string[] = [];
            const failures: ReturnType<typeof partialFailure>[] = [];
            for (const project of projects) {
                const recoveryGroup = project.manifest.backup?.group;
                if (recoveryGroup && failedGroups.has(recoveryGroup)) continue;
                try {
                    await (await context.deployment(project)).discard(dryRun);
                    discarded.push(project.manifest.name);
                } catch (error) {
                    if (isCancellation(error, context.abort.signal))
                        throw error;
                    if (unitKeys.size === 1) throw error;
                    process.exitCode = 4;
                    if (recoveryGroup) failedGroups.add(recoveryGroup);
                    failures.push(
                        partialFailure(
                            error,
                            recoveryGroup
                                ? { group: recoveryGroup }
                                : { project: project.manifest.name },
                            "Pending installation discard failed; inspect this recovery unit with craflet doctor and craflet deploy plan.",
                        ),
                    );
                }
            }
            const result = { discarded };
            return failures.length ? [result, ...failures] : result;
        },
    );
    context.action(
        program
            .command("recover")
            .description(
                "Recover an interrupted declaration or pre-start deployment; never revert a running new version.",
            )
            .option(
                "--unlock",
                "remove only locks whose recorded owner has exited",
            ),
        async (_, command) => {
            const batches = await context.batches(command, true);
            const projectResults = [];
            const groupResults = [];
            const globals = context.globals(command);
            const dryRun = globals.dryRun ?? false;
            for (const batch of batches) {
                const unitProjectResults = [];
                try {
                    for (const project of batch.projects) {
                        if (command.opts().unlock)
                            await recoverProcessLocks(project, dryRun);
                        const declarations = await recoverManifests(
                            project.lockRoot,
                            dryRun,
                        );
                        const restored =
                            batch.backup && !batch.group
                                ? await recoverBackupRestore(
                                      project,
                                      context.store,
                                      batch.backup,
                                      dryRun,
                                  )
                                : false;
                        const deployment = batch.group
                            ? { recovered: false }
                            : await (await context.deployment(project)).recover(
                                  dryRun,
                              );
                        unitProjectResults.push({
                            project: project.manifest.name,
                            declarations,
                            restore: restored,
                            ...deployment,
                        });
                    }
                    if (batch.group) {
                        const restored = await recoverGroupBackupRestore(
                            batch,
                            context.store,
                            {
                                dryRun,
                                offline: globals.offline ?? false,
                                signal: context.abort.signal,
                            },
                        );
                        groupResults.push({
                            group: batch.group,
                            restore: restored,
                            recovered:
                                restored ||
                                (await context.group(batch).recover(dryRun)),
                        });
                    }
                    projectResults.push(...unitProjectResults);
                } catch (error) {
                    if (isCancellation(error, context.abort.signal))
                        throw error;
                    if (batches.length === 1) throw error;
                    process.exitCode = 4;
                    const failure = partialFailure(
                        error,
                        batch.group
                            ? { group: batch.group }
                            : {
                                  project:
                                      batch.projects[0]?.manifest.name ??
                                      "Selected project",
                              },
                        "Recovery failed; inspect this recovery unit with craflet doctor before retrying.",
                    );
                    if (batch.group) groupResults.push(failure);
                    else projectResults.push(failure);
                }
            }
            return [...projectResults, ...groupResults];
        },
    );
}
