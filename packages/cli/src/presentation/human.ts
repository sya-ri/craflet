import { sanitizeInlineTerminalOutput } from "./terminal.js";

type ResultRecord = Record<string, unknown>;

export interface HumanResultContext {
    command: string;
    dryRun: boolean;
}

const ITEM_LIMIT = 20;

function record(value: unknown): ResultRecord | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as ResultRecord)
        : undefined;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function records(value: unknown): ResultRecord[] {
    const result: ResultRecord[] = [];
    for (const entry of list(value)) {
        const item = record(entry);
        if (item) result.push(item);
    }
    return result;
}

function text(value: unknown, fallback = "-"): string {
    if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
    )
        return fallback;
    return sanitizeInlineTerminalOutput(String(value));
}

function optionalText(value: unknown): string | undefined {
    return value === null || value === undefined ? undefined : text(value);
}

function count(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function plural(amount: number, singular: string, pluralForm = `${singular}s`) {
    return amount === 1 ? singular : pluralForm;
}

function formatBytes(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return "unknown size";
    if (value < 1024) return `${value} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let amount = value;
    let unit = "B";
    for (const next of units) {
        amount /= 1024;
        unit = next;
        if (amount < 1024) break;
    }
    return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function requestedLabel(value: unknown, displayVersion?: unknown): string {
    const source = record(value);
    if (source) {
        const provider = text(source.provider, "declared source");
        if (provider === "file") return "local file";
        const version = optionalText(displayVersion);
        return version ? `${provider}@${version}` : provider;
    }
    if (typeof value !== "string") return "not declared";
    if (value.startsWith("file:")) return "local file";
    const separator = value.indexOf(":");
    const provider = text(
        separator < 0 ? "declared source" : value.slice(0, separator),
    );
    const resolved = optionalText(displayVersion);
    if (resolved) return `${provider}@${resolved}`;
    return provider;
}

function requestedServerLabel(value: unknown): string {
    const source = record(value);
    if (!source) return requestedLabel(value);
    const provider = text(source.provider, "declared source");
    if (provider === "file") return "local file";
    if (provider === "paper")
        return `${text(source.project, "server")} ${text(source.version)} build ${text(source.build)}`;
    return requestedLabel(source, source.version);
}

function boundedLines(
    values: unknown,
    render: (value: unknown, index: number) => string,
): string[] {
    const entries = list(values);
    const lines = entries.slice(0, ITEM_LIMIT).map(render);
    if (entries.length > ITEM_LIMIT)
        lines.push(`  ... ${entries.length - ITEM_LIMIT} more`);
    return lines;
}

function formatFailure(
    label: unknown,
    code: unknown,
    message: unknown,
    fallback = "Recovery unit",
): string {
    return `${text(label, fallback)}: failed [${text(code, "OPERATION_FAILED")}].${message ? ` ${text(message)}` : ""}`;
}

function failureLines(result: unknown): string[] {
    return (Array.isArray(result) ? list(result) : [result]).flatMap(
        (value) => {
            const item = record(value);
            if (item?.ok !== false) return [];
            return [
                formatFailure(
                    item.project ?? item.group,
                    item.code,
                    item.message,
                ),
            ];
        },
    );
}

function formatServerStatus(value: unknown, prefix = "Server"): string[] {
    const status = record(value);
    if (!status) return [`${prefix} status is unavailable.`];
    const state = text(status.status, "unknown");
    const lines = [`${prefix}: ${state}`];
    const active = optionalText(status.activeId);
    if (active) lines.push(`  Active installation: ${active}`);
    const pid = optionalText(status.pid);
    const javaPid = optionalText(status.javaPid);
    if (pid || javaPid)
        lines.push(
            `  Process: ${pid ? `runner ${pid}` : "runner unknown"}${javaPid ? `, Java ${javaPid}` : ""}`,
        );
    if (typeof status.clean === "boolean")
        lines.push(`  Last shutdown: ${status.clean ? "clean" : "unclean"}`);
    return lines;
}

function renderInit(result: unknown, dryRun: boolean): string {
    const item = record(result);
    if (!item)
        return dryRun
            ? "Project creation preview completed."
            : "Project created.";
    const server = record(item.server);
    const kind = text(server?.type, "Minecraft");
    const name = text(item.name, "server");
    const action = dryRun ? "Would create" : "Created";
    const lines = [
        `${action} ${kind === "paper" ? "Paper" : kind === "velocity" ? "Velocity" : kind} server "${name}" at ${text(item.directory)}.`,
    ];
    if (server) {
        const build = optionalText(server.build);
        lines.push(
            `Server version: ${text(server.version)}${build ? ` (build ${build})` : ""}`,
        );
    }
    if (typeof item.next === "string") lines.push(`Next: ${text(item.next)}`);
    return lines.join("\n");
}

function renderInstall(
    result: unknown,
    command: string,
    dryRun: boolean,
): string {
    const preview = record(result);
    if (preview?.action === "add") {
        const projects = list(preview.projects).map((item) => text(item));
        const sources = count(preview.sources);
        return [
            `Plan: add ${sources} ${plural(sources, "plugin source")} to ${projects.join(", ") || "the selected project"}.`,
            "No declaration, lock, cache, pending installation, or running JAR was changed.",
        ].join("\n");
    }
    const items = records(result);
    if (!items.length)
        return dryRun
            ? "No installation changes are planned."
            : "No installation changes were needed.";
    const changed = items.filter((item) => item.changed === true);
    const verb =
        command === "plugins add"
            ? "Added plugins and prepared"
            : command === "plugins remove"
              ? "Removed plugin declarations and prepared"
              : command === "plugins update" || command === "server update"
                ? "Resolved updates and prepared"
                : "Prepared";
    const lines = [
        dryRun
            ? `${changed.length} of ${items.length} selected ${plural(items.length, "project")} would receive a pending installation.`
            : changed.length
              ? `${verb} ${changed.length} pending ${plural(changed.length, "installation")}.`
              : `All ${items.length} selected ${plural(items.length, "project")} are already up to date.`,
    ];
    for (const item of items) {
        const plugins = list(item.plugins).map((plugin) => text(plugin));
        lines.push(
            `${text(item.project)}: ${item.changed === true ? (dryRun ? "changes planned" : "pending ready") : "unchanged"}${plugins.length ? `; declared plugins: ${plugins.join(", ")}` : "; no declared plugins"}`,
        );
        for (const warning of list(item.warnings))
            lines.push(`  Warning: ${text(warning)}`);
        const unresolved = list(item.unresolved).map((entry) => text(entry));
        if (unresolved.length)
            lines.push(`  Unresolved during preview: ${unresolved.join(", ")}`);
    }
    if (!dryRun && changed.length) {
        lines.push("Running JARs were not replaced.");
        lines.push(
            "Apply the pending installation with craflet start or craflet restart.",
        );
    }
    if (command === "plugins remove")
        lines.push("Plugin data under runtime was left unchanged.");
    return lines.join("\n");
}

function latestLabel(value: ResultRecord): string {
    const status = optionalText(value.status);
    if (!status) return "";
    if (status === "local") return " | latest local file";
    if (status === "undeclared") return " | latest not declared";
    return ` | latest ${text(value.latest)} (${status === "update-available" ? "update available" : status})`;
}

function renderPluginList(result: unknown): string {
    const projects = records(result);
    if (!projects.length) return "No projects were selected.";
    const lines: string[] = [];
    for (const project of projects) {
        if (lines.length) lines.push("");
        lines.push(`Project: ${text(project.project)}`);
        const plugins = records(project.plugins);
        if (!plugins.length) {
            lines.push("Plugins: none declared.");
            continue;
        }
        lines.push("Plugins:");
        for (const plugin of plugins)
            lines.push(
                `  ${text(plugin.name)}: requested ${requestedLabel(plugin.requested, plugin.requestedVersion)} | active ${text(plugin.active)} | pending ${text(plugin.pending)} | locked ${text(plugin.locked)}${latestLabel(plugin)}`,
            );
    }
    return lines.join("\n");
}

function renderServerList(result: unknown): string {
    const projects = records(result);
    if (!projects.length) return "No projects were selected.";
    const lines: string[] = [];
    for (const project of projects) {
        if (lines.length) lines.push("");
        const server = record(project.server);
        lines.push(`Project: ${text(project.project)}`);
        lines.push(
            `Server: requested ${requestedServerLabel(server?.requested)} | locked ${text(server?.locked)} | active ${text(server?.active)} | pending ${text(server?.pending)}${server ? latestLabel(server) : ""}`,
        );
    }
    return lines.join("\n");
}

function renderUpdateCheck(
    result: unknown,
    target: "plugins" | "server",
): string {
    const projects = records(result);
    const lines: string[] = [];
    let available = 0;
    for (const project of projects) {
        const updates = records(project.updates);
        if (!updates.length) continue;
        lines.push(`Project: ${text(project.project)}`);
        for (const update of updates) {
            const name = text(update.name);
            if (update.kind === "local") {
                const updateCommand =
                    target === "server"
                        ? "craflet server update"
                        : `craflet plugins update -- ${name}`;
                lines.push(
                    `  ${name}: local JAR locked at ${text(update.lockedVersion)}; run ${updateCommand} to reimport changed bytes.`,
                );
            } else if (
                update.kind === "provider" &&
                update.updateAvailable === true
            ) {
                available += 1;
                lines.push(
                    `  ${name}: locked ${text(update.lockedVersion)} -> latest ${text(update.latestVersion)}`,
                );
            } else if (update.kind === "provider") {
                lines.push(
                    `  ${name}: locked ${text(update.lockedVersion)} is the latest version.`,
                );
            }
        }
    }
    if (!lines.length)
        return target === "server"
            ? "No server update information is available."
            : "No plugins are declared for update checks.";
    lines.unshift(
        available
            ? `${available} ${plural(available, "update")} available.`
            : "No newer provider versions are available.",
    );
    return lines.join("\n");
}

function isDeploymentPlan(value: unknown): boolean {
    const item = record(value);
    return Boolean(
        item &&
            record(item.status) &&
            (Object.hasOwn(item, "active") ||
                Object.hasOwn(item, "pending") ||
                Object.hasOwn(item, "plugins") ||
                Object.hasOwn(item, "configuration") ||
                Object.hasOwn(item, "recoveryRequired")),
    );
}

function renderDeploymentPlan(
    value: unknown,
    label: string,
    preview = true,
): string[] {
    const plan = record(value);
    if (!plan) return [`${label}: deployment details are unavailable.`];
    const plugins = list(plan.plugins);
    const configuration = list(plan.configuration);
    return [
        `${label}: ${preview ? "deployment preview" : "deployment state"}`,
        ...formatServerStatus(plan.status, "  Runtime"),
        `  Active installation: ${text(plan.active, "none")}`,
        `  Pending installation: ${text(plan.pending, "none")}`,
        plugins.length
            ? `  Pending plugins (${plugins.length}): ${plugins
                  .slice(0, ITEM_LIMIT)
                  .map((entry) => text(entry))
                  .join(
                      ", ",
                  )}${plugins.length > ITEM_LIMIT ? `, ... ${plugins.length - ITEM_LIMIT} more` : ""}`
            : "  Pending plugins: none",
        configuration.length
            ? `  Configuration (${configuration.length}): ${configuration
                  .slice(0, ITEM_LIMIT)
                  .map((entry) => text(entry))
                  .join(
                      ", ",
                  )}${configuration.length > ITEM_LIMIT ? `, ... ${configuration.length - ITEM_LIMIT} more` : ""}`
            : "  Configuration: none",
        `  Recovery required: ${plan.recoveryRequired === true ? "yes" : "no"}`,
    ];
}

interface LifecycleRow {
    label: string;
    value?: unknown;
    failed?: boolean;
    code?: unknown;
    message?: unknown;
}

function lifecycleRows(result: unknown): LifecycleRow[] {
    const inputs = Array.isArray(result) ? result : [result];
    const rows: LifecycleRow[] = [];
    for (const input of inputs) {
        const item = record(input);
        if (!item) continue;
        const outerLabel = text(item.project ?? item.group, "Server");
        if (item.ok === false) {
            rows.push({
                label: outerLabel,
                failed: true,
                code: item.code,
                message: item.message,
            });
            continue;
        }
        if (Array.isArray(item.result)) {
            const members = list(item.result);
            for (const [index, memberValue] of members.entries()) {
                const member = record(memberValue);
                if (!member) continue;
                const label = text(
                    member.project,
                    `${outerLabel} member ${index + 1}`,
                );
                rows.push({
                    label,
                    value:
                        record(member.status) && !isDeploymentPlan(member)
                            ? member.status
                            : member,
                });
            }
            continue;
        }
        rows.push({
            label: outerLabel,
            value: item.result ?? item,
        });
    }
    return rows;
}

function renderRuntime(
    result: unknown,
    command: string,
    dryRun: boolean,
): string {
    if (command === "status" && !Array.isArray(result))
        return formatServerStatus(result).join("\n");
    if (command === "stop" && !Array.isArray(result))
        return [
            ...(dryRun ? ["Stop preview; no stop signal was sent."] : []),
            ...formatServerStatus(result),
        ].join("\n");

    const rows = lifecycleRows(result);
    if (!rows.length)
        return dryRun
            ? `No ${command} operation is planned.`
            : command === "stop"
              ? "No server was stopped."
              : `No server was ${command}ed.`;
    const failures = rows.filter((row) => row.failed).length;
    const completed = rows.length - failures;
    const action =
        command === "restart"
            ? "Restart"
            : command === "stop"
              ? "Stop"
              : "Start";
    const lines = [
        command === "status"
            ? `Status for ${rows.length} ${plural(rows.length, "server")}.`
            : dryRun
              ? `${action} preview completed for ${completed} ${plural(completed, "server")}${failures ? `; ${failures} failed inspection` : ""}. No lifecycle action was performed.`
              : failures
                ? `${action} completed for ${completed} ${plural(completed, "server")}; ${failures} failed.`
                : `${command === "restart" ? "Restarted" : command === "stop" ? "Stopped" : "Started"} ${rows.length} ${plural(rows.length, "server")}.`,
    ];
    for (const row of rows) {
        if (row.failed) {
            lines.push(formatFailure(row.label, row.code, row.message));
        } else if (isDeploymentPlan(row.value)) {
            lines.push(...renderDeploymentPlan(row.value, row.label));
        } else if (record(row.value)?.status !== undefined) {
            lines.push(...formatServerStatus(row.value, row.label));
        } else {
            lines.push(
                `${row.label}: ${dryRun ? "preview completed" : "operation completed"}.`,
            );
        }
    }
    return lines.join("\n");
}

function renderWorkspaceList(result: unknown): string {
    const projects = records(result);
    if (!projects.length) return "No workspace projects were found.";
    return [
        `${projects.length} workspace ${plural(projects.length, "project")}:`,
        ...projects.map(
            (project) => `  ${text(project.name)}: ${text(project.directory)}`,
        ),
    ].join("\n");
}

function renderValidation(result: unknown): string {
    const projects = records(result);
    if (!projects.length) return "No projects were validated.";
    return [
        `Validated ${projects.length} ${plural(projects.length, "project")}.`,
        ...projects.map(
            (project) =>
                `[${project.valid === true ? "OK" : "FAIL"}] ${text(project.project)}: lock ${project.locked ? "present" : "missing"}, active ${project.active ? "present" : "none"}, pending ${project.pending ? "present" : "none"}`,
        ),
    ].join("\n");
}

function renderDoctor(result: unknown): string {
    const groups = list(result);
    const diagnostics = groups.flatMap(records);
    if (!diagnostics.length) return "Doctor completed without diagnostics.";
    const failed = diagnostics.filter(
        (item) =>
            item.status === "fail" ||
            (item.status === "unknown" && item.required === true),
    ).length;
    const warned = diagnostics.filter((item) => item.status === "warn").length;
    const unknown = diagnostics.filter(
        (item) => item.status === "unknown" && item.required !== true,
    ).length;
    const lines = [
        failed
            ? `Doctor found ${failed} failing ${plural(failed, "check")}, ${warned} ${plural(warned, "warning")}, and ${unknown} optional unknown ${plural(unknown, "check")}.`
            : warned || unknown
              ? `Doctor completed with ${warned} ${plural(warned, "warning")} and ${unknown} optional unknown ${plural(unknown, "check")}.`
              : `Doctor passed ${diagnostics.length} ${plural(diagnostics.length, "check")}.`,
    ];
    for (const item of diagnostics) {
        lines.push(
            `[${text(item.status).toUpperCase()}] ${text(item.message)}`,
        );
        if (item.hint) lines.push(`  Hint: ${text(item.hint)}`);
    }
    return lines.join("\n");
}

function renderConfig(
    result: unknown,
    command: string,
    dryRun: boolean,
): string {
    if (command === "config capture") {
        const item = record(result);
        const conflicts = records(item?.conflicts);
        if (conflicts.length)
            return [
                `Capture stopped with ${conflicts.length} ${plural(conflicts.length, "conflict")}; no templates were changed.`,
                ...conflicts.map(
                    (entry) =>
                        `  ${text(entry.relative)}: review with craflet config diff`,
                ),
            ].join("\n");
        const captured = list(item?.captured).map((entry) => text(entry));
        const unchanged = count(item?.unchanged);
        return `${dryRun ? "Would capture" : "Captured"} ${captured.length} ${plural(captured.length, "configuration file")}; ${unchanged} unchanged.${captured.length ? `\n  ${captured.join("\n  ")}` : ""}`;
    }
    if (command === "config diff") {
        const files = records(result);
        if (!files.length)
            return "No tracked configuration files have differences.";
        return [
            `${files.length} tracked configuration ${plural(files.length, "file")}:`,
            ...files.map((file) => {
                const changes = [
                    file.baseChanged === true ? "base changed" : undefined,
                    file.runtimeChanged === true
                        ? "runtime changed"
                        : undefined,
                    count(file.conflicts)
                        ? `${count(file.conflicts)} ${plural(count(file.conflicts), "conflict")}`
                        : undefined,
                ].filter(Boolean);
                return `  ${text(file.relative)}: ${changes.join(", ") || "unchanged"}`;
            }),
        ].join("\n");
    }
    if (command === "config list" || command === "config track") {
        const preview = record(result);
        if (command === "config track" && preview?.action === "track") {
            const paths = list(preview.paths).map((entry) => text(entry));
            return `${dryRun ? "Would track" : "Tracked"} ${paths.length} ${plural(paths.length, "configuration file")}.${paths.length ? `\n  ${paths.join("\n  ")}` : ""}`;
        }
        const files = records(result);
        if (!files.length)
            return command === "config list"
                ? "No managed configuration files were found."
                : dryRun
                  ? "No configuration files would be tracked."
                  : "No configuration files were added.";
        return [
            `${files.length} configuration ${plural(files.length, "file")}:`,
            ...files.map((file) => `  ${text(file.relative)}`),
        ].join("\n");
    }
    const item = record(result);
    if (command === "config untrack") {
        const paths = list(item?.untracked).map((entry) => text(entry));
        return `${dryRun ? "Would stop tracking" : "Stopped tracking"} ${paths.length} ${plural(paths.length, "configuration file")}. Runtime files are unchanged.${paths.length ? `\n  ${paths.join("\n  ")}` : ""}`;
    }
    if (command === "config resolve")
        return `${dryRun ? "Would resolve" : "Resolved"} ${text(item?.path)} using the ${text(item?.resolution)} version.`;
    return "Configuration operation completed.";
}

function renderBackupPlan(value: unknown, label = "Backup plan"): string {
    const plan = record(value);
    if (!plan) return `${label}: details are unavailable.`;
    const files = list(plan.files);
    const roots = list(plan.roots);
    const databases = list(plan.databaseIds);
    const lines = [
        `${label}: ${files.length} ${plural(files.length, "file")}, ${formatBytes(plan.bytes)}, ${databases.length} ${plural(databases.length, "database")}.`,
        `Staging estimate: ${formatBytes(plan.stagingBytes)}`,
        roots.length ? "Roots:" : "Roots: none",
        ...boundedLines(roots, (value) => {
            const root = record(value);
            return `  ${text(root?.id)}: ${text(root?.path)} (${text(root?.kind)}${root?.external === true ? ", external" : ""})`;
        }),
        files.length
            ? "Selected files after exclusions:"
            : "Selected files after exclusions: none",
        ...boundedLines(files, (value) => {
            const file = record(value);
            return `  ${text(file?.destination)} <- ${text(file?.source)} (${formatBytes(file?.size)})`;
        }),
        databases.length
            ? `Databases: ${databases.map((database) => text(database)).join(", ")}`
            : "Databases: none",
        ...list(plan.warnings).map((warning) => `Warning: ${text(warning)}`),
    ];
    return lines.join("\n");
}

function backupPlans(result: unknown): { label: string; plan: ResultRecord }[] {
    if (!Array.isArray(result)) {
        const plan = record(result);
        return plan ? [{ label: "Backup plan", plan }] : [];
    }
    return list(result).flatMap((value) => {
        const wrapper = record(value);
        const plan = record(wrapper?.result);
        if (!wrapper || !plan) return [];
        return [
            {
                label: `Backup plan for ${text(wrapper.project ?? wrapper.group, "selected recovery unit")}`,
                plan,
            },
        ];
    });
}

function renderBackupApply(result: unknown, dryRun: boolean): string {
    const item = record(result);
    if (!item)
        return dryRun
            ? "Restore application preview is unavailable; no live data was changed."
            : "Restore application completed; verify the stopped server before continuing.";
    const label = text(item.project ?? item.group, "selected recovery unit");
    const changes = list(item.changes);
    if (dryRun) {
        return [
            `Restore application preview for ${label}: ${item.files === undefined ? "group file changes are listed below" : `${count(item.files)} ${plural(count(item.files), "file")}`}, ${count(item.databases)} ${plural(count(item.databases), "database")}, ${changes.length} planned ${plural(changes.length, "change")}.`,
            ...boundedLines(changes, (value) => {
                const change = record(value);
                const action =
                    change?.before === null
                        ? "create"
                        : change?.after === null
                          ? "remove"
                          : "replace";
                return `  ${text(change?.kind)} ${action}: ${text(change?.target)}`;
            }),
            ...list(item.unresolved).map(
                (entry) => `Still checked during apply: ${text(entry)}`,
            ),
            "No live data was changed.",
        ].join("\n");
    }
    const lines = [
        item.applied === true
            ? `Applied verified restored data for ${label}. The server remains stopped.`
            : `Restore application completed for ${label}; verify the stopped server before continuing.`,
    ];
    if (item.preRestoreSnapshot)
        lines.push(
            `Pre-restore snapshot: ${text(item.preRestoreSnapshot).slice(0, 12)}`,
        );
    if (item.pendingDiscarded === true)
        lines.push("The previous pending installation was discarded.");
    if (item.cleanupRequired)
        lines.push(
            `Warning: temporary restore data still requires cleanup at ${text(item.cleanupRequired)}.`,
        );
    return lines.join("\n");
}

function renderBackup(
    result: unknown,
    command: string,
    dryRun: boolean,
): string {
    const item = record(result);
    if (command === "backup plan") return renderBackupPlan(result);
    if (command === "backup setup")
        return `${dryRun ? "Would configure" : "Configured"} backup repository "${text(item?.alias)}" at ${text(item?.path)}.`;
    if (command === "backup list") {
        const snapshots = records(result);
        if (!snapshots.length)
            return "No snapshots were found for this recovery unit.";
        return [
            `${snapshots.length} backup ${plural(snapshots.length, "snapshot")}:`,
            ...snapshots.map(
                (snapshot) =>
                    `  ${text(snapshot.shortId ?? snapshot.id)}  ${text(snapshot.time)}`,
            ),
        ].join("\n");
    }
    if (command === "backup show")
        return `Snapshot created ${text(item?.createdAt)} for project ${text(item?.projectId)}: ${count(item?.files)} ${plural(count(item?.files), "file")}, ${count(item?.databases)} ${plural(count(item?.databases), "database")}.`;
    if (command === "backup diff") {
        const differences = list(result).filter(
            (value) => record(value)?.message_type !== "statistics",
        );
        return differences.length
            ? [
                  `${differences.length} backup ${plural(differences.length, "difference")} found:`,
                  ...boundedLines(differences, (value) => {
                      const difference = record(value);
                      const target =
                          difference?.path ??
                          difference?.changed ??
                          difference?.source;
                      const action =
                          difference?.modifier ?? difference?.type ?? "changed";
                      return `  ${text(action)}: ${text(target)}`;
                  }),
              ].join("\n")
            : "The selected snapshots have no reported differences.";
    }
    if (command === "backup check")
        return "Backup repository integrity check passed.";
    if (command === "backup prune") {
        const groups = records(item?.plan);
        const structured = groups.every((group) =>
            Array.isArray(group?.remove),
        );
        const removed = structured
            ? groups.flatMap((group) => records(group.remove))
            : [];
        const lines = [
            structured
                ? item?.applied === true
                    ? `Applied retention and pruned repository data; ${removed.length} ${plural(removed.length, "snapshot")} removed.`
                    : `Retention preview: ${removed.length} ${plural(removed.length, "snapshot")} would be removed. Run craflet backup prune --apply to delete them.`
                : `Retention ${item?.applied === true ? "result" : "preview"}: restic reported ${groups.length} ${plural(groups.length, "retention group")}; use --json to inspect its provider-specific structure.`,
        ];
        lines.push(
            ...boundedLines(removed, (value) => {
                const snapshot = record(value);
                const reasons = list(snapshot?.reasons)
                    .map((reason) => text(reason))
                    .join(", ");
                return `  ${text(snapshot?.shortId ?? snapshot?.short_id ?? snapshot?.id)}  ${text(snapshot?.time)}${reasons ? ` (${reasons})` : ""}`;
            }),
        );
        return lines.join("\n");
    }
    if (command === "backup restore") {
        return `${dryRun ? "Restore plan verified" : "Restored snapshot"} ${text(item?.snapshotId)} ${dryRun ? "for" : "to"} ${text(item?.target)}${item?.requiredBytes !== undefined ? `; ${formatBytes(item.requiredBytes)} required` : ""}.`;
    }
    if (command === "backup create") {
        const failures = failureLines(result);
        if (dryRun) {
            const plans = backupPlans(result);
            return [
                ...(plans.length
                    ? plans.map(({ label, plan }) =>
                          renderBackupPlan(plan, label),
                      )
                    : [
                          "Backup preview details are unavailable; no server was stopped.",
                      ]),
                ...failures,
            ].join("\n\n");
        }
        const operations = Array.isArray(result) ? list(result) : [result];
        const backups = operations.flatMap((operation) => {
            const wrapper = record(operation);
            const nested = record(wrapper?.result);
            const backup = record(wrapper?.backup) ?? record(nested?.backup);
            return backup
                ? [{ wrapper: nested ?? wrapper, outer: wrapper, backup }]
                : wrapper?.snapshotId
                  ? [{ wrapper, outer: wrapper, backup: wrapper }]
                  : [];
        });
        if (backups.length)
            return [
                ...backups.map(({ wrapper, outer, backup }) => {
                    const snapshotId = text(backup.snapshotId).slice(0, 12);
                    const files =
                        typeof backup.fileCount === "number"
                            ? backup.fileCount
                            : 0;
                    const resumed = Array.isArray(wrapper?.resumed)
                        ? list(wrapper?.resumed).map((entry) => text(entry))
                        : [];
                    const label = optionalText(outer?.project ?? outer?.group);
                    return `${label ? `${label}: ` : ""}Created cold backup ${snapshotId} with ${files} ${plural(files, "file")} (${formatBytes(backup.bytes)}).${wrapper?.resumed === true ? " The previously running server was resumed with the same active installation." : resumed.length ? ` Resumed with the same active installation: ${resumed.join(", ")}.` : ""}`;
                }),
                ...failures,
            ].join("\n");
        return failures.length
            ? failures.join("\n")
            : "Cold backup operation completed.";
    }
    if (command === "backup apply") return renderBackupApply(result, dryRun);
    return "Backup operation completed.";
}

function renderCache(result: unknown, command: string): string {
    const item = record(result);
    if (command === "cache prune") {
        const candidates = count(item?.candidates);
        return [
            item?.applied === true
                ? `Removed ${candidates} unreferenced cache ${plural(candidates, "entry", "entries")}; ${text(item?.retained, "0")} retained.`
                : `Cache prune preview: ${candidates} unreferenced ${plural(candidates, "entry", "entries")}; ${text(item?.retained, "0")} retained.`,
            ...list(item?.warnings).map(
                (warning) => `Warning: ${text(warning)}`,
            ),
        ].join("\n");
    }
    const entries = count(item?.entries);
    const invalid = records(item?.entries).filter(
        (entry) => entry.valid === false,
    ).length;
    const ignored = list(item?.ignored).map((entry) => text(entry));
    return [
        `${command === "cache verify" ? "Verified" : "Cache contains"} ${entries} ${plural(entries, "artifact")} (${formatBytes(item?.bytes)})${invalid ? `; ${invalid} failed verification` : ""}.`,
        `Cache directory: ${text(item?.directory)}`,
        ...(ignored.length
            ? [
                  `Ignored ${ignored.length} unrecognized ${plural(ignored.length, "entry", "entries")}: ${ignored.slice(0, ITEM_LIMIT).join(", ")}${ignored.length > ITEM_LIMIT ? `, ... ${ignored.length - ITEM_LIMIT} more` : ""}`,
              ]
            : []),
    ].join("\n");
}

function renderInspect(result: unknown): string {
    const item = record(result);
    if (!item) return "JAR inspection completed.";
    const names: Record<string, string> = {
        bukkit: "Bukkit/Spigot",
        paper: "Paper",
        velocity: "Velocity",
    };
    const format = text(item.format);
    const dependencies = list(item.dependencies).map((entry) => text(entry));
    return [
        `Plugin: ${text(item.id)}`,
        `Version: ${text(item.version)}`,
        `Descriptor: ${names[format] ?? format}`,
        dependencies.length
            ? `Required plugins: ${dependencies.join(", ")}`
            : "Required plugins: none",
    ].join("\n");
}

function renderRecovery(result: unknown, dryRun: boolean): string {
    const rows = records(result);
    if (!rows.length)
        return dryRun
            ? "No interrupted operation was found; no state was changed."
            : "No interrupted operation required recovery.";
    const changed = rows.filter(
        (row) =>
            row?.ok !== false &&
            (row?.declarations === true ||
                row?.restore === true ||
                row?.recovered === true),
    ).length;
    const failures = rows.filter((row) => row?.ok === false).length;
    const lines = [
        dryRun
            ? `Recovery preview produced ${rows.length} project/group ${plural(rows.length, "report")}; ${changed} would require work${failures ? ` and ${failures} failed inspection` : ""}.`
            : failures
              ? `Recovery produced ${rows.length - failures} successful project/group ${plural(rows.length - failures, "report")}; ${failures} failed.`
              : changed
                ? `Recovered interrupted state in ${changed} of ${rows.length} project/group ${plural(rows.length, "report")}.`
                : `Checked ${rows.length} project/group recovery ${plural(rows.length, "report")}; no recovery was needed.`,
    ];
    for (const row of rows) {
        if (row?.ok === false) {
            lines.push(
                formatFailure(row.project ?? row.group, row.code, row.message),
            );
            continue;
        }
        const actions = [
            row?.declarations === true ? "declarations" : undefined,
            row?.restore === true ? "restore" : undefined,
            row?.recovered === true ? "deployment" : undefined,
        ].filter((value): value is string => Boolean(value));
        lines.push(
            `${text(row?.project ?? row?.group, "Recovery unit")}: ${actions.length ? `${dryRun ? "would recover" : "recovered"} ${actions.join(", ")}` : "no recovery needed"}.`,
        );
    }
    if (!dryRun)
        lines.push(
            "Run craflet validate, craflet status, and craflet deploy plan before continuing.",
        );
    return lines.join("\n");
}

function renderDeployApply(result: unknown, dryRun: boolean): string {
    const wrappers = records(result);
    if (!wrappers.length)
        return dryRun
            ? "No deployment application was selected; runtime files were not changed."
            : "No deployment application was selected.";
    const failures = wrappers.filter((wrapper) => wrapper?.ok === false).length;
    const successes = wrappers.length - failures;
    const lines = [
        dryRun
            ? failures
                ? `Deployment application preview: ${successes} ${plural(successes, "recovery unit")} could be applied; ${failures} failed. Runtime files were not changed.`
                : `Deployment application preview for ${successes} ${plural(successes, "recovery unit")}; runtime files were not changed.`
            : failures
              ? `Deployment application completed for ${successes} ${plural(successes, "recovery unit")}; ${failures} failed. No server was started.`
              : `Deployment application completed for ${successes} ${plural(successes, "recovery unit")}. No server was started.`,
    ];
    for (const wrapper of wrappers) {
        const label = text(wrapper?.project ?? wrapper?.group, "Recovery unit");
        if (wrapper?.ok === false) {
            lines.push(formatFailure(label, wrapper.code, wrapper.message));
            continue;
        }
        const nested = wrapper?.result;
        if (Array.isArray(nested)) {
            const plans = records(nested);
            if (!plans.length) {
                lines.push(
                    `${label}: deployment completed; all members remain stopped.`,
                );
                continue;
            }
            for (const [index, plan] of plans.entries())
                lines.push(
                    ...renderDeploymentPlan(
                        plan,
                        `${label} member ${index + 1}`,
                        dryRun,
                    ),
                );
            continue;
        }
        if (isDeploymentPlan(nested))
            lines.push(...renderDeploymentPlan(nested, label, dryRun));
        else lines.push(`${label}: deployment result details are unavailable.`);
    }
    return lines.join("\n");
}

function renderSimple(
    result: unknown,
    command: string,
    dryRun: boolean,
): string {
    const item = record(result);
    if (command === "import") {
        const files = optionalText(item?.files);
        const plugins = count(item?.plugins);
        const lines = [
            `${dryRun ? "Would import" : "Imported"} the stopped server from ${text(item?.source)} to ${text(item?.target)}.`,
            "The original server files were left unchanged.",
        ];
        if (files)
            lines.push(
                `Selected ${files} ${plural(Number(files), "file")} and ${plugins} ${plural(plugins, "plugin")}.`,
            );
        if (typeof item?.next === "string")
            lines.push(`Next: ${text(item.next)}`);
        return lines.join("\n");
    }
    if (command === "workspace init")
        return `${dryRun ? "Would create" : "Created"} workspace at ${text(item?.directory)} with ${count(item?.projects)} project ${plural(count(item?.projects), "pattern")}.`;
    if (command === "command")
        return item?.sent === true
            ? "Console command sent."
            : "Dry run: console command was not sent.";
    if (command === "logs")
        return item?.detached === true
            ? "Detached from server logs; the server was not stopped."
            : "Server log stream ended.";
    if (command === "deploy discard") {
        if (Array.isArray(result)) {
            const rows = records(result);
            const discarded = rows.flatMap((row) =>
                list(row?.discarded).map((entry) => text(entry)),
            );
            const failures = rows.filter((row) => row?.ok === false);
            return [
                `${dryRun ? "Would discard" : "Discarded"} pending installations for ${discarded.length} ${plural(discarded.length, "project")}; ${failures.length} failed. Desired YAML and lock entries are unchanged.`,
                ...(discarded.length
                    ? [`  Completed: ${discarded.join(", ")}`]
                    : []),
                ...failures.map(
                    (failure) =>
                        `  ${formatFailure(failure.project ?? failure.group, failure.code, failure.message, "Project")}`,
                ),
            ].join("\n");
        }
        const discarded = list(item?.discarded).map((entry) => text(entry));
        return `${dryRun ? "Would discard" : "Discarded"} pending installations for ${discarded.length} ${plural(discarded.length, "project")}. Desired YAML and lock entries are unchanged.`;
    }
    if (command === "tools prepare")
        return dryRun
            ? `Would prepare restic under ${text(item?.home)}.`
            : `Prepared restic ${text(item?.version)} at ${text(item?.path)}.`;
    if (command === "console")
        return dryRun
            ? [
                  "Console preview; no terminal was attached.",
                  ...formatServerStatus(result),
              ].join("\n")
            : "Detached from the server console; the server was not stopped.";
    if (command === "run")
        return dryRun && isDeploymentPlan(result)
            ? [
                  "Run preview; the server was not started.",
                  ...renderDeploymentPlan(result, "Server"),
              ].join("\n")
            : "The foreground server session ended.";
    if (command === "recover") return renderRecovery(result, dryRun);
    if (command === "deploy apply") return renderDeployApply(result, dryRun);
    if (command === "deploy plan") {
        const projects = records(result);
        if (!projects.length) return "No deployment previews were found.";
        return [
            `Deployment preview for ${projects.length} ${plural(projects.length, "project")}:`,
            ...projects.flatMap((project) =>
                renderDeploymentPlan(
                    project,
                    text(project.project, "Project"),
                    true,
                ),
            ),
        ].join("\n");
    }
    return dryRun
        ? "Operation preview completed; no changes were made."
        : "Operation completed successfully.";
}

export function renderHumanResult(
    result: unknown,
    context: HumanResultContext,
): string {
    const { command, dryRun } = context;
    switch (command) {
        case "init":
            return renderInit(result, dryRun);
        case "plugins inspect":
            return renderInspect(result);
        case "plugins add":
        case "plugins remove":
        case "plugins update":
        case "server update":
        case "install":
            return renderInstall(result, command, dryRun);
        case "plugins":
            return renderPluginList(result);
        case "server":
            return renderServerList(result);
        case "plugins check":
            return renderUpdateCheck(result, "plugins");
        case "server check":
            return renderUpdateCheck(result, "server");
        case "start":
        case "restart":
        case "stop":
        case "status":
            return renderRuntime(result, command, dryRun);
        case "workspace list":
            return renderWorkspaceList(result);
        case "validate":
            return renderValidation(result);
        case "doctor":
            return renderDoctor(result);
        case "config list":
        case "config track":
        case "config untrack":
        case "config diff":
        case "config capture":
        case "config resolve":
            return renderConfig(result, command, dryRun);
        case "backup setup":
        case "backup plan":
        case "backup create":
        case "backup list":
        case "backup show":
        case "backup diff":
        case "backup check":
        case "backup restore":
        case "backup apply":
        case "backup prune":
            return renderBackup(result, command, dryRun);
        case "cache info":
        case "cache verify":
        case "cache prune":
            return renderCache(result, command);
        default:
            return renderSimple(result, command, dryRun);
    }
}
