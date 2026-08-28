import path from "node:path";
import { CrafletError, parseSource, validatePluginSet } from "@craflet/core";
import { NodeConfigManager } from "./config.js";
import { serverSource } from "./installations.js";
import { exists } from "./io.js";
import { type ProjectContext, readLock } from "./projects.js";
import { installationJars, readState } from "./state.js";

export async function validateManagedProject(project: ProjectContext) {
    if (await exists(path.join(project.dir, ".craflet/import-incomplete.json")))
        throw new CrafletError(
            "IMPORT_INCOMPLETE",
            "The imported destination is incomplete; it cannot be started safely.",
            4,
        );
    parseSource(serverSource(project.manifest));
    for (const source of Object.values(project.manifest.plugins))
        parseSource(source);
    const lock = (await readLock(project.lockRoot)).projects[project.lockKey];
    const state = await readState(project.dir);
    if (state.active) installationJars(state.active);
    if (state.pending) installationJars(state.pending);
    if (lock) {
        for (const [name, artifact] of Object.entries(lock.plugins)) {
            if (artifact.identity?.id !== name)
                throw new CrafletError(
                    "LOCK_IDENTITY",
                    `Lock plugin ${name} does not match its descriptor identity.`,
                    2,
                );
        }
        validatePluginSet(
            Object.values(lock.plugins).flatMap((artifact) =>
                artifact.identity ? [artifact.identity] : [],
            ),
            project.manifest.server.type,
        );
    }
    const configuration = await new NodeConfigManager(
        project.dir,
        project.manifest.secrets,
    ).diff();
    if (configuration.some((file) => file.conflicts.length))
        throw new CrafletError(
            "CONFIG_CONFLICT",
            "Managed configuration has conflicts. Run config diff and config resolve.",
            3,
        );
    return {
        project: project.manifest.name,
        valid: true,
        locked: Boolean(lock),
        active: state.active?.id ?? null,
        pending: state.pending?.id ?? null,
        configurations: configuration.length,
    };
}
