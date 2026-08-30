import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { CrafleetError, type Diagnostic, newProject } from "@crafleet/core";
import { NodeServerController } from "../runtime/controller.js";
import { inspectJava } from "../runtime/java.js";
import { NodeConfigManager } from "./config.js";
import { readRepositories } from "./host.js";
import { assertNoSymlinks, exists } from "./io.js";
import {
    hasRecoveryJournal,
    loadProject,
    type ProjectContext,
    readLock,
} from "./projects.js";
import { installationJars, readState } from "./state.js";

export async function diagnoseProject(
    dir: string,
    home: string,
): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    let project: ProjectContext | undefined;
    try {
        project = await loadProject(dir, home);
        diagnostics.push({
            id: "project.manifest",
            status: "pass",
            message: `Project "${project.manifest.name}" declaration is valid.`,
        });
    } catch (error) {
        diagnostics.push({
            id: "project.manifest",
            status: "fail",
            message:
                error instanceof CrafleetError
                    ? error.message
                    : "Project declaration could not be read.",
        });
    }
    diagnostics.push(
        ...(
            await inspectJava(
                project?.manifest ??
                    newProject("diagnostic", "paper", "unknown"),
            )
        ).diagnostics,
    );
    if (!project) return diagnostics;
    try {
        const lock = await readLock(project.lockRoot);
        diagnostics.push({
            id: "project.lock",
            status: lock.projects[project.lockKey] ? "pass" : "warn",
            message: lock.projects[project.lockKey]
                ? "A structurally valid lock entry exists."
                : "No lock entry yet; run crafleet install.",
        });
    } catch {
        diagnostics.push({
            id: "project.lock",
            status: "fail",
            message: "Lockfile is unreadable or invalid.",
        });
    }
    try {
        const config = new NodeConfigManager(dir, project.manifest.secrets);
        const diff = await config.diff();
        diagnostics.push({
            id: "config.syntax",
            status: "pass",
            message: `${diff.length} managed configuration files passed syntax and secret-reference checks.`,
        });
        if (diff.some((item) => item.conflicts.length))
            diagnostics.push({
                id: "config.conflicts",
                status: "fail",
                message:
                    "Conflicting runtime/base changes exist; use config diff and config resolve.",
            });
        else if (diff.some((item) => item.runtimeChanged))
            diagnostics.push({
                id: "config.drift",
                status: "warn",
                message: "Server-side changes are waiting for config capture.",
            });
        diagnostics.push({
            id: "config.plugin-semantics",
            status: "unknown",
            message:
                "Arbitrary plugin-specific settings are checked for syntax, not complete semantic correctness.",
        });
    } catch (error) {
        diagnostics.push({
            id: "config.validation",
            status: "fail",
            message:
                error instanceof CrafleetError
                    ? error.message
                    : "Configuration could not be inspected safely.",
        });
    }
    try {
        const state = await readState(dir);
        if (state.pending)
            diagnostics.push({
                id: "deployment.pending",
                status: "warn",
                message: `Prepared installation ${state.pending.id} will be applied at the next managed start.`,
            });
        if (state.active) {
            for (const [relative, artifact] of installationJars(state.active)) {
                const file = await assertNoSymlinks(dir, `runtime/${relative}`);
                let valid = false;
                if (await exists(file)) {
                    const hash = createHash("sha256");
                    for await (const chunk of createReadStream(file))
                        hash.update(chunk as Buffer);
                    valid = hash.digest("hex") === artifact.sha256;
                }
                diagnostics.push({
                    id: `jar.${relative}`,
                    status: valid ? "pass" : "fail",
                    message: valid
                        ? `${relative} matches the active lock.`
                        : `${relative} is missing or differs from the active lock.`,
                });
            }
        }
        const status = await new NodeServerController(dir, home).status();
        diagnostics.push({
            id: "runtime.identity",
            status: status.status === "unknown" ? "unknown" : "pass",
            required: true,
            message: `Server status: ${status.status}.`,
        });
        if (status.clean === false)
            diagnostics.push({
                id: "runtime.clean-stop",
                status: "warn",
                message: "The previous termination was not confirmed clean.",
            });
    } catch {
        diagnostics.push({
            id: "deployment.state",
            status: "fail",
            message: "State is invalid or inaccessible; use recover.",
        });
    }
    if (await hasRecoveryJournal(project))
        diagnostics.push({
            id: "deployment.recovery",
            status: "fail",
            message: "An interrupted transaction requires crafleet recover.",
        });
    const alias = project.manifest.backup?.repository;
    if (!alias)
        diagnostics.push({
            id: "backup.repository",
            status: "warn",
            message:
                "No backup repository is configured; changes to existing data will be blocked.",
        });
    else {
        try {
            const repository = (await readRepositories(home))[alias];
            const present =
                repository?.id &&
                path.isAbsolute(repository.path) &&
                (await exists(repository.path)) &&
                (
                    await stat(await assertNoSymlinks(repository.path))
                ).isDirectory();
            diagnostics.push({
                id: "backup.repository",
                status: present ? "pass" : "fail",
                message: present
                    ? "The configured repository path exists. Run backup check for integrity verification."
                    : "The configured backup destination is missing; no alternate destination will be created.",
            });
            diagnostics.push({
                id: "backup.restore-readiness",
                status: "unknown",
                message:
                    "Repository decryption, DB connectivity and restore integrity were not probed by this read-only diagnostic.",
            });
        } catch {
            diagnostics.push({
                id: "backup.repository",
                status: "fail",
                message: "Backup repository configuration is invalid.",
            });
        }
    }
    return diagnostics;
}
