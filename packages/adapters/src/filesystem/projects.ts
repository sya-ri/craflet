import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
    CrafleetError,
    type LockFile,
    newProject,
    type ProjectManifest,
    parseServerSource,
    type SourceInput,
    stableStringify,
    validateLock,
    validateProject,
    validationError,
    WorkspaceSchema,
} from "@crafleet/core";
import { type } from "arktype";
import picomatch from "picomatch";
import { Document, parseDocument } from "yaml";
import {
    ensureUserEulaConsent,
    type RequestEulaConsent,
} from "./eula-consent.js";
import { proposedEulaDocument } from "./eula-file.js";
import {
    appendToBoundedRegularFile,
    assertNoSymlinks,
    atomicCreate,
    atomicWrite,
    type BoundedFileFailure,
    exists,
    readBoundedRegularFile,
} from "./io.js";

export const MAX_YAML_BYTES = 2 * 1024 * 1024;
const MAX_GITIGNORE_BYTES = 1024 * 1024;
const GITIGNORE_RULES = [
    "runtime/",
    "shared-data/",
    ".crafleet/",
    "imports/",
    ".env",
    ".env.*",
] as const;

export interface ProjectContext {
    dir: string;
    manifest: ProjectManifest;
    lockRoot: string;
    lockKey: string;
    home: string;
    /** Exact declaration text parsed when this context was loaded. */
    manifestText?: string;
}

export function recoveryJournalPaths(
    project: Pick<ProjectContext, "dir" | "lockRoot">,
): string[] {
    return [
        ...["deploy.json", "restore.json", "import-incomplete.json"].map(
            (name) => path.join(project.dir, ".crafleet", name),
        ),
        ...[
            "manifest-transaction.json",
            "group-operation.json",
            "group-restore.json",
        ].map((name) => path.join(project.lockRoot, ".crafleet", name)),
    ];
}

export async function hasRecoveryJournal(
    project: Pick<ProjectContext, "dir" | "lockRoot">,
): Promise<boolean> {
    for (const file of recoveryJournalPaths(project))
        if (await exists(file)) return true;
    return false;
}

export async function readYaml(file: string): Promise<unknown> {
    const text = await readYamlText(file);
    return parseYamlContent(text, file);
}

function parseYamlContent(text: string, file: string): unknown {
    const document = parseDocument(text, {
        uniqueKeys: true,
        prettyErrors: false,
    });
    if (document.errors.length)
        throw new CrafleetError(
            "YAML_SYNTAX",
            `${path.basename(file)}: invalid YAML (input values omitted).`,
            2,
        );
    try {
        return document.toJS({ maxAliasCount: 50 });
    } catch {
        throw new CrafleetError(
            "YAML_ALIASES",
            `${path.basename(file)}: excessive YAML alias expansion.`,
            2,
        );
    }
}

async function readYamlText(file: string): Promise<string> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    if ((await stat(file)).size > MAX_YAML_BYTES)
        throw new CrafleetError(
            "YAML_SIZE",
            `${path.basename(file)} exceeds the 2 MiB limit.`,
            2,
        );
    return readFile(file, "utf8");
}

function boundedYamlText(file: string, text: string): string {
    if (Buffer.byteLength(text) > MAX_YAML_BYTES)
        throw new CrafleetError(
            "YAML_SIZE",
            `${path.basename(file)} exceeds the 2 MiB limit.`,
            2,
        );
    return text;
}

export async function yamlText(
    file: string,
    value: unknown,
    snapshot?: string | null,
): Promise<string> {
    const original =
        snapshot === undefined
            ? (await exists(file))
                ? await readYamlText(file)
                : null
            : snapshot;
    if (original === null)
        return boundedYamlText(
            file,
            new Document(value).toString({ indent: 4 }),
        );
    const doc = parseDocument(original, {
        uniqueKeys: true,
        prettyErrors: false,
    });
    if (doc.errors.length)
        throw new CrafleetError(
            "YAML_SYNTAX",
            `Cannot edit invalid YAML: ${path.basename(file)}`,
            2,
        );
    const previous: unknown = doc.toJS({ maxAliasCount: 50 });
    if (stableStringify(previous) === stableStringify(value))
        return boundedYamlText(file, original);
    function update(keys: string[], before: unknown, after: unknown) {
        if (stableStringify(before) === stableStringify(after)) return;
        if (
            after !== null &&
            typeof after === "object" &&
            !Array.isArray(after) &&
            before !== null &&
            typeof before === "object" &&
            !Array.isArray(before)
        ) {
            const old = before as Record<string, unknown>;
            const next = after as Record<string, unknown>;
            for (const key of Object.keys(old))
                if (!Object.hasOwn(next, key)) doc.deleteIn([...keys, key]);
            for (const [key, child] of Object.entries(next))
                update([...keys, key], old[key], child);
        } else doc.setIn(keys, after);
    }
    update([], previous, value);
    return boundedYamlText(file, doc.toString());
}

export async function writeYaml(file: string, value: unknown): Promise<void> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    const text = await yamlText(file, value);
    if ((await exists(file)) && (await readFile(file, "utf8")) === text) return;
    await atomicWrite(file, text);
}

export async function nearestFile(
    start: string,
    name: string,
): Promise<string | undefined> {
    let current = path.resolve(start);
    while (true) {
        if (await exists(path.join(current, name)))
            return path.join(current, name);
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

export async function loadProject(
    dir: string,
    home: string,
): Promise<ProjectContext> {
    const absolute = path.resolve(dir);
    await assertNoSymlinks(absolute, "crafleet.yaml");
    const manifestText = await readYamlText(
        path.join(absolute, "crafleet.yaml"),
    );
    const manifest = validateProject(
        parseYamlContent(manifestText, "crafleet.yaml"),
    );
    const workspace = await nearestFile(absolute, "crafleet-workspace.yaml");
    const lockRoot = workspace ? path.dirname(workspace) : absolute;
    return {
        dir: absolute,
        manifest,
        manifestText,
        lockRoot,
        lockKey:
            path.relative(lockRoot, absolute).replaceAll(path.sep, "/") || ".",
        home,
    };
}

export async function readLock(root: string): Promise<LockFile> {
    const file = path.join(root, "crafleet-lock.yaml");
    return parseLockText(
        (await exists(file)) ? await readYamlText(file) : null,
    );
}

export function parseLockText(text: string | null): LockFile {
    return validateLock(
        text === null
            ? { lockVersion: 1, projects: {} }
            : parseYamlContent(text, "crafleet-lock.yaml"),
    );
}

export async function workspaceProjects(root: string): Promise<string[]> {
    const workspaceFile = await nearestFile(root, "crafleet-workspace.yaml");
    if (!workspaceFile)
        return (await exists(path.join(root, "crafleet.yaml")))
            ? [path.resolve(root)]
            : [];
    const workspace = WorkspaceSchema(await readYaml(workspaceFile));
    if (workspace instanceof type.errors)
        throw validationError("crafleet-workspace.yaml", workspace);
    const base = path.dirname(workspaceFile);
    const matchers = workspace.projects.map(workspacePattern);
    const includes = matchers.filter((entry) => !entry.excluded);
    const excludes = matchers.filter((entry) => entry.excluded);
    const projects: string[] = [];
    async function walk(directory: string, depth: number) {
        if (depth > 12)
            throw new CrafleetError(
                "WORKSPACE_DEPTH",
                "Workspace nesting exceeds 12 directories.",
                2,
            );
        const relative =
            path.relative(base, directory).replaceAll(path.sep, "/") || ".";
        if (
            (await exists(path.join(directory, "crafleet.yaml"))) &&
            includes.some(({ matches }) => matches(relative)) &&
            !excludes.some(({ matches }) => matches(relative))
        )
            projects.push(directory);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (
                !entry.isDirectory() ||
                entry.isSymbolicLink() ||
                entry.name.startsWith(".") ||
                ["node_modules", "runtime", "config"].includes(entry.name)
            )
                continue;
            await walk(path.join(directory, entry.name), depth + 1);
        }
    }
    await walk(base, 0);
    return projects.sort();
}

export async function selectProjects(
    cwd: string,
    home: string,
    options: { recursive?: boolean; filters?: string[] } = {},
): Promise<ProjectContext[]> {
    const projectFile = await nearestFile(cwd, "crafleet.yaml");
    const recursive = options.recursive || Boolean(options.filters?.length);
    const dirs = recursive
        ? await workspaceProjects(cwd)
        : projectFile
          ? [path.dirname(projectFile)]
          : [];
    if (!dirs.length)
        throw new CrafleetError(
            "NO_PROJECT",
            "No project selected. Use --recursive at a workspace root, or -C <project>.",
            2,
        );
    const all = await Promise.all(dirs.map((dir) => loadProject(dir, home)));
    const filters = options.filters?.map((filter) => picomatch(filter));
    const selected = filters?.length
        ? all.filter((project) =>
              filters.some(
                  (matches) =>
                      matches(project.manifest.name) ||
                      matches(project.lockKey),
              ),
          )
        : all;
    if (!selected.length)
        throw new CrafleetError(
            "EMPTY_SELECTION",
            "The workspace filter matched no projects.",
            2,
        );
    const names = new Set<string>();
    for (const project of all) {
        if (names.has(project.manifest.name))
            throw new CrafleetError(
                "DUPLICATE_PROJECT",
                `Duplicate project name: ${project.manifest.name}`,
                2,
            );
        names.add(project.manifest.name);
    }
    return selected;
}

async function isGitManaged(directory: string): Promise<boolean> {
    let current = path.resolve(directory);
    while (true) {
        try {
            const marker = await lstat(path.join(current, ".git"));
            if (marker.isDirectory() || marker.isFile()) return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}

interface GitIgnoreSnapshot {
    text: string | null;
    mode: number;
    stats: BigIntStats | null;
}

function gitIgnoreChanged(): never {
    throw new CrafleetError(
        "CONCURRENT_EDIT",
        ".gitignore changed while the project was being initialized. Review it and retry.",
        3,
    );
}

function gitIgnoreReadFailure(reason: BoundedFileFailure): never {
    if (reason === "changed") gitIgnoreChanged();
    if (reason === "unsafe")
        throw new CrafleetError(
            "GITIGNORE_UNSAFE",
            ".gitignore must be a regular file without symbolic or hard links.",
            3,
        );
    if (reason === "too-large")
        throw new CrafleetError(
            "GITIGNORE_SIZE",
            ".gitignore exceeds the 1 MiB safety limit.",
            3,
        );
    throw new CrafleetError(
        "GITIGNORE_UNREADABLE",
        ".gitignore cannot be read safely. Its contents are omitted.",
        3,
    );
}

async function readGitIgnoreSnapshot(file: string): Promise<GitIgnoreSnapshot> {
    const snapshot = await readBoundedRegularFile(file, {
        maxBytes: MAX_GITIGNORE_BYTES,
        failure: gitIgnoreReadFailure,
    });
    if (snapshot === null) return { text: null, mode: 0o644, stats: null };
    try {
        return {
            text: new TextDecoder("utf-8", {
                fatal: true,
                ignoreBOM: true,
            }).decode(snapshot.bytes),
            mode: Number(snapshot.stats.mode & 0o777n),
            stats: snapshot.stats,
        };
    } catch {
        return gitIgnoreReadFailure("unreadable");
    }
}

interface GitIgnoreUpdate {
    content: string;
    suffix: string;
}

function updatedGitIgnore(
    snapshot: GitIgnoreSnapshot,
): GitIgnoreUpdate | undefined {
    const original = snapshot.text ?? "";
    const entries = original.split(/\r?\n/);
    if (entries[0]?.startsWith("\uFEFF")) entries[0] = entries[0].slice(1);
    const lines = new Set(entries);
    const missing = GITIGNORE_RULES.filter((rule) => !lines.has(rule));
    if (!missing.length) return undefined;
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const suffix = `${original && !original.endsWith("\n") ? newline : ""}${missing.join(newline)}${newline}`;
    const content = `${original}${suffix}`;
    if (Buffer.byteLength(content) > MAX_GITIGNORE_BYTES)
        return gitIgnoreReadFailure("too-large");
    return { content, suffix };
}

async function writeGitIgnore(
    directory: string,
    snapshot: GitIgnoreSnapshot,
): Promise<void> {
    const file = path.join(directory, ".gitignore");
    const updated = updatedGitIgnore(snapshot);
    if (updated === undefined) return;
    if (snapshot.text === null) {
        try {
            await atomicCreate(file, updated.content, snapshot.mode);
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
                gitIgnoreChanged();
            throw error;
        }
    }
    const current = await readGitIgnoreSnapshot(file);
    if (
        current.text !== snapshot.text ||
        current.mode !== snapshot.mode ||
        current.stats === null
    )
        gitIgnoreChanged();
    await appendToBoundedRegularFile(file, current.stats, updated.suffix, {
        maxBytes: MAX_GITIGNORE_BYTES,
        failure: gitIgnoreReadFailure,
    });
}

function projectExists(): never {
    throw new CrafleetError(
        "PROJECT_EXISTS",
        "crafleet.yaml already exists; it will not be overwritten.",
        3,
    );
}

function workspaceExists(): never {
    throw new CrafleetError(
        "WORKSPACE_EXISTS",
        "Workspace manifest already exists.",
        3,
    );
}

async function prepareProjectInitialization(
    directory: string,
    manifestFile: string,
): Promise<GitIgnoreSnapshot | undefined> {
    await assertNoSymlinks(directory);
    for (const child of ["crafleet.yaml", "config", "runtime", "shared-data"])
        await assertNoSymlinks(directory, child);
    if (await exists(manifestFile)) projectExists();
    if (!(await isGitManaged(directory))) return undefined;
    return readGitIgnoreSnapshot(path.join(directory, ".gitignore"));
}

async function createExclusiveFile(
    file: string,
    text: string,
    onConflict: () => never,
): Promise<void> {
    try {
        await atomicCreate(file, text);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") onConflict();
        throw error;
    }
}

export async function initProject(
    dir: string,
    options: {
        name: string;
        kind: "paper" | "velocity";
        version: string;
        build?: string;
        source?: SourceInput;
        dryRun?: boolean;
        eula?: {
            home: string;
            requestConsent: RequestEulaConsent;
            signal?: AbortSignal;
        };
    },
): Promise<ProjectManifest> {
    const defaults = newProject(options.name, options.kind, options.version);
    if (options.source !== undefined)
        parseServerSource(options.source, options.kind);
    const manifest = validateProject({
        ...defaults,
        id: randomUUID(),
        server: {
            ...defaults.server,
            ...(options.build !== undefined ? { build: options.build } : {}),
            ...(options.source !== undefined ? { source: options.source } : {}),
        },
    });
    const file = path.join(dir, "crafleet.yaml");
    const manifestText = await yamlText(file, manifest, null);
    let gitIgnore = await prepareProjectInitialization(dir, file);
    if (options.kind === "paper" && options.eula) {
        await ensureUserEulaConsent(
            options.eula.home,
            options.eula.requestConsent,
            {
                ...(options.dryRun !== undefined
                    ? { dryRun: options.dryRun }
                    : {}),
                ...(options.eula.signal ? { signal: options.eula.signal } : {}),
                document: proposedEulaDocument(
                    path.join(dir, "runtime/eula.txt"),
                ),
            },
        );
        if (!options.dryRun)
            gitIgnore = await prepareProjectInitialization(dir, file);
    }
    if (!options.dryRun) {
        for (const child of ["config", "runtime", "shared-data"])
            await mkdir(path.join(dir, child), { recursive: true });
        if (gitIgnore) await writeGitIgnore(dir, gitIgnore);
        // The manifest is the commit marker: retries remain possible after an earlier write fails.
        await createExclusiveFile(file, manifestText, projectExists);
    }
    return manifest;
}

export async function initWorkspace(
    dir: string,
    projects: string[],
    dryRun = false,
): Promise<void> {
    const file = path.join(dir, "crafleet-workspace.yaml");
    await assertNoSymlinks(dir, "crafleet-workspace.yaml");
    if (await exists(file)) workspaceExists();
    for (const pattern of projects) workspacePattern(pattern);
    const text = await yamlText(file, { schemaVersion: 1, projects }, null);
    if (dryRun) return;
    await createExclusiveFile(file, text, workspaceExists);
}

function workspacePattern(input: string): {
    excluded: boolean;
    matches: (value: string) => boolean;
} {
    const excluded = input.startsWith("!");
    const pattern = (excluded ? input.slice(1) : input).replaceAll("\\", "/");
    if (
        !pattern ||
        path.posix.isAbsolute(pattern) ||
        path.win32.isAbsolute(pattern) ||
        pattern.includes(":") ||
        pattern.split("/").includes("..")
    ) {
        throw new CrafleetError(
            "WORKSPACE_PATH",
            "Workspace patterns must be nonempty and remain under the workspace directory.",
            2,
        );
    }
    return {
        excluded,
        matches: picomatch(pattern, { dot: false, nonegate: true }),
    };
}

export function fingerprint(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}
