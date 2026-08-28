import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
    type ConfigBundle,
    CrafletError,
    type LockedArtifact,
    type ProjectLock,
    type ProjectManifest,
    portablePluginJarName,
    validateConfigBundle,
    validatePluginSet,
    validateProject,
    validateProjectLock,
} from "@craflet/core";
import { type } from "arktype";
import { assertNoSymlinks, exists, writeJson } from "./io.js";

export interface Installation {
    id: string;
    createdAt: string;
    manifest: ProjectManifest;
    lock: ProjectLock;
    config: ConfigBundle;
}
export interface ProjectState {
    schemaVersion: 1;
    active?: Installation;
    pending?: Installation;
}

/** A single checked filename mapping for deploy, import validation and backup restore. */
export function installationJars(
    installation: Installation | null,
): Map<string, LockedArtifact> {
    if (!installation) return new Map();
    const result = new Map<string, LockedArtifact>([
        ["server.jar", installation.lock.server],
    ]);
    const identities = [];
    for (const [name, artifact] of Object.entries(installation.lock.plugins)) {
        const jarName = portablePluginJarName(name);
        if (artifact.identity?.id !== name)
            throw new CrafletError(
                "JAR_PATH",
                "Installation contains an inconsistent plugin filename and identity.",
                4,
            );
        result.set(`plugins/${jarName}`, artifact);
        identities.push(artifact.identity);
    }
    validatePluginSet(identities, installation.manifest.server.type);
    return result;
}
const InstallationSchema = type({
    "+": "reject",
    id: "string.uuid",
    createdAt: "string",
    manifest: "unknown",
    lock: "unknown",
    config: "unknown",
});
const StateSchema = type({
    "+": "reject",
    schemaVersion: "1",
    "active?": InstallationSchema,
    "pending?": InstallationSchema,
});

export function validateInstallation(input: unknown): Installation {
    const result = InstallationSchema(input);
    if (result instanceof type.errors)
        throw new CrafletError(
            "STATE_INVALID",
            "Invalid installation state; recover before starting.",
            4,
        );
    let manifest: ProjectManifest;
    let lock: ProjectLock;
    try {
        manifest = validateProject(result.manifest);
        lock = validateProjectLock(result.lock);
    } catch {
        throw new CrafletError(
            "STATE_INVALID",
            "Invalid installation declarations or resolutions; recover before starting.",
            4,
        );
    }
    return {
        ...result,
        manifest,
        lock,
        config: validateConfigBundle(result.config),
    };
}

export async function readState(projectDir: string): Promise<ProjectState> {
    const file = path.join(projectDir, ".craflet/state.json");
    await assertNoSymlinks(projectDir, ".craflet/state.json");
    if (!(await exists(file))) return { schemaVersion: 1 };
    if ((await stat(file)).size > 32 * 1024 * 1024)
        throw new CrafletError(
            "STATE_SIZE",
            "State exceeds its size limit.",
            4,
        );
    return parseStateText(await readFile(file, "utf8"));
}

export function parseStateText(text: string | null): ProjectState {
    if (text === null) return { schemaVersion: 1 };
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new CrafletError("STATE_INVALID", "Unreadable project state.", 4);
    }
    const value = StateSchema(data);
    if (value instanceof type.errors)
        throw new CrafletError("STATE_INVALID", "Invalid project state.", 4);
    return {
        schemaVersion: 1,
        ...(value.active ? { active: validateInstallation(value.active) } : {}),
        ...(value.pending
            ? { pending: validateInstallation(value.pending) }
            : {}),
    };
}

export async function saveState(
    projectDir: string,
    state: ProjectState,
): Promise<void> {
    await assertNoSymlinks(projectDir, ".craflet/state.json");
    await writeJson(path.join(projectDir, ".craflet/state.json"), state);
}
