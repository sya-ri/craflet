import { createInterface } from "node:readline";
import {
    followServerLogs,
    readServerLogs,
    recoverBackupRestore,
    recoverGroupBackupRestore,
    recoverManifests,
    recoverProcessLocks,
} from "@craflet/adapters";
import { CrafletError } from "@craflet/core";
import type { Command } from "commander";
import type { CommandContext } from "./context.js";

export function registerRuntimeCommands(
    program: Command,
    context: CommandContext,
): void {
    const operate = async (
        command: Command,
        action: "start" | "restart" | "stop",
    ) => {
        const projects = await context.projects(command);
        if (action !== "stop") {
            const batches = await context.batches(command, true);
            const results: unknown[] = [];
            for (const batch of batches) {
                try {
                    if (batch.group)
                        results.push({
                            group: batch.group,
                            result: await context
                                .group(batch, true)
                                .operate(
                                    action,
                                    Boolean(command.opts().active),
                                    context.globals(command).dryRun ?? false,
                                ),
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
                            result: context.globals(command).dryRun
                                ? await deployment.plan()
                                : await deployment[action](
                                      Boolean(command.opts().active),
                                  ),
                        });
                    }
                } catch (error) {
                    if (
                        context.abort.signal.aborted ||
                        (error instanceof CrafletError &&
                            error.code === "CANCELLED")
                    )
                        throw error;
                    if (batches.length === 1) throw error;
                    process.exitCode = 4;
                    results.push({
                        group: batch.group ?? batch.projects[0]?.manifest.name,
                        ok: false,
                        code:
                            error instanceof CrafletError
                                ? error.code
                                : "OPERATION_FAILED",
                    });
                }
            }
            return results;
        }
        const results: unknown[] = [];
        for (const project of projects) {
            try {
                const deployment = await context.deployment(project);
                const value = context.globals(command).dryRun
                    ? { action, ...(await deployment.plan()) }
                    : await deployment.stop(Boolean(command.opts().force));
                results.push({
                    project: project.manifest.name,
                    ok: true,
                    result: value,
                });
            } catch (error) {
                if (projects.length === 1) throw error;
                process.exitCode = 4;
                results.push({
                    project: project.manifest.name,
                    ok: false,
                    code:
                        error instanceof CrafletError
                            ? error.code
                            : "OPERATION_FAILED",
                    message:
                        error instanceof CrafletError
                            ? error.message
                            : "Operation failed; inspect this project's doctor and logs.",
                });
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
            if (command.opts().force && !context.globals(command).dryRun)
                await context.ask(
                    command,
                    "Force termination can lose server data. Terminate this owned Java process?",
                );
            // Broken YAML must not prevent stopping the current owned process.
            if (
                !context.globals(command).recursive &&
                !context.globals(command).filter?.length
            ) {
                const controller = await context.controller(command);
                return context.globals(command).dryRun
                    ? controller.status()
                    : controller.stop(Boolean(command.opts().force));
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
            if (
                !context.globals(command).recursive &&
                !context.globals(command).filter?.length
            )
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
            if (!context.globals(command).dryRun)
                await (await context.controller(command)).command(String(text));
            return { sent: !context.globals(command).dryRun };
        },
    );
    const streamLogs = async (command: Command, stopOnInterrupt = false) => {
        const dir = await context.runtimeDir(command);
        const json = context.globals(command).json ?? false;
        const controller = await context.controller(command);
        const abort = new AbortController();
        const output = (chunk: string) => {
            if (chunk)
                process.stdout.write(
                    json
                        ? `${JSON.stringify({ event: "log", text: chunk })}\n`
                        : chunk.endsWith("\n")
                          ? chunk
                          : `${chunk}\n`,
                );
        };
        const onInterrupt = () => {
            abort.abort();
        };
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onInterrupt);
        context.abort.signal.addEventListener("abort", onInterrupt, {
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
            output(
                await readServerLogs(dir, Number(command.opts().lines ?? 100)),
            );
            for await (const text of followServerLogs(dir, abort.signal))
                output(text);
        } finally {
            if (poll) clearInterval(poll);
            process.removeListener("SIGINT", onInterrupt);
            process.removeListener("SIGTERM", onInterrupt);
            context.abort.signal.removeEventListener("abort", onInterrupt);
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
        async (_, command) =>
            command.opts().follow && !context.globals(command).dryRun
                ? streamLogs(command)
                : readServerLogs(
                      await context.runtimeDir(command),
                      Number(command.opts().lines),
                  ),
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
                "Attach interactive console input; EOF or Ctrl-C only detaches.",
            ),
        async (_, command) => {
            if (context.globals(command).json || !process.stdin.isTTY)
                throw new CrafletError(
                    "CONSOLE_TTY",
                    "console requires a terminal. Use command <text> for scripts.",
                    2,
                );
            const controller = await context.controller(command);
            if (context.globals(command).dryRun) return controller.status();
            if ((await controller.status()).status !== "running")
                throw new CrafletError(
                    "SERVER_NOT_RUNNING",
                    "Start the server before attaching its console.",
                    3,
                );
            const input = createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: true,
            });
            const abort = new AbortController();
            const onInterrupt = () => {
                input.close();
            };
            input.once("SIGINT", onInterrupt);
            context.abort.signal.addEventListener("abort", onInterrupt, {
                once: true,
            });
            input.once("close", () => abort.abort());
            const logs = (async () => {
                for await (const text of followServerLogs(
                    await context.runtimeDir(command),
                    abort.signal,
                ))
                    process.stdout.write(text);
            })();
            try {
                for await (const line of input)
                    if (line.trim()) await controller.command(line);
            } finally {
                context.abort.signal.removeEventListener("abort", onInterrupt);
                input.close();
                abort.abort();
                await logs;
            }
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
            for (const batch of await context.batches(command, true)) {
                if (batch.group)
                    results.push({
                        group: batch.group,
                        result: await context
                            .group(batch)
                            .operate(
                                "apply",
                                false,
                                context.globals(command).dryRun ?? false,
                            ),
                    });
                else
                    for (const project of batch.projects)
                        results.push({
                            project: project.manifest.name,
                            result: await (
                                await context.deployment(project)
                            ).apply(context.globals(command).dryRun ?? false),
                        });
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
            if (!context.globals(command).dryRun)
                await context.ask(
                    command,
                    "Discard prepared pending installations? Desired YAML and lock remain unchanged.",
                );
            for (const project of projects)
                await (await context.deployment(project)).discard(
                    context.globals(command).dryRun ?? false,
                );
            return {
                discarded: projects.map((project) => project.manifest.name),
            };
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
            const projects = await context.projects(command);
            const batches = await context.batches(command, true);
            const results = [];
            for (const project of projects) {
                const dryRun = context.globals(command).dryRun ?? false;
                if (command.opts().unlock)
                    await recoverProcessLocks(project, dryRun);
                const declarations = await recoverManifests(
                    project.lockRoot,
                    dryRun,
                );
                const batch = batches.find((entry) =>
                    entry.projects.some((member) => member.dir === project.dir),
                );
                const restored =
                    batch?.backup && !batch.group
                        ? await recoverBackupRestore(
                              project,
                              context.store,
                              batch.backup,
                              dryRun,
                          )
                        : false;
                const deployment = batch?.group
                    ? { recovered: false }
                    : await (await context.deployment(project)).recover(dryRun);
                results.push({
                    project: project.manifest.name,
                    declarations,
                    restore: restored,
                    ...deployment,
                });
            }
            for (const batch of batches)
                if (batch.group) {
                    const restored = await recoverGroupBackupRestore(
                        batch,
                        context.store,
                        {
                            dryRun: context.globals(command).dryRun ?? false,
                            offline: context.globals(command).offline ?? false,
                            signal: context.abort.signal,
                        },
                    );
                    results.push({
                        group: batch.group,
                        restore: restored,
                        recovered:
                            restored ||
                            (await context
                                .group(batch)
                                .recover(
                                    context.globals(command).dryRun ?? false,
                                )),
                    });
                }
            return results;
        },
    );
}
