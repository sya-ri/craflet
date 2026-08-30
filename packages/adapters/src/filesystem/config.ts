import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
    type ConfigBundle,
    type ConfigBundleFile,
    type ConfigCandidate,
    type ConfigCaptureOptions,
    type ConfigCaptureResult,
    type ConfigDiff,
    type ConfigFileInfo,
    type ConfigState,
    CrafleetError,
    configFormat,
    type SecretReference,
    validateConfigBundle,
    validateConfigState,
} from "@crafleet/core";
import { mergeConfigDocuments } from "../formats/config.js";
import {
    assertNoSymlinks,
    atomicWrite,
    exists,
    listFiles,
    withMutex,
} from "./io.js";
import { type ConfigSecrets, loadConfigSecrets } from "./secrets.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 32 * 1024 * 1024;

export function normalizeConfigRelative(relative: string): string {
    const normalized = relative.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (
        normalized.length === 0 ||
        normalized.includes(":") ||
        [...normalized].some((character) => character.charCodeAt(0) < 32) ||
        parts.some(
            (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                /[. ]$/.test(part) ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ) ||
        /\.jar$/i.test(normalized)
    ) {
        throw new CrafleetError(
            "CONFIG_PATH",
            "Configuration paths must be portable relative file paths without links, traversal, or JAR files.",
            3,
        );
    }
    return normalized;
}

function fingerprint(state: ConfigState): string {
    const files = Object.fromEntries(
        Object.entries(state.files).sort(([left], [right]) =>
            left.localeCompare(right, "en"),
        ),
    );
    return createHash("sha256")
        .update(JSON.stringify({ schemaVersion: 1, files }))
        .digest("hex");
}

function cloneState(state: ConfigState): ConfigState {
    return {
        schemaVersion: 1,
        files: Object.assign(
            Object.create(null),
            Object.fromEntries(
                Object.entries(state.files).map(([relative, entry]) => [
                    relative,
                    { ...entry },
                ]),
            ),
        ),
    };
}

function stale(): never {
    throw new CrafleetError(
        "CONFIG_CHANGED",
        "Configuration changed after it was inspected. Recreate the pending configuration after reviewing the changes.",
        3,
    );
}

async function readManagedText(
    root: string,
    relative: string,
    maximum = MAX_FILE_BYTES,
): Promise<string | null> {
    const file = await assertNoSymlinks(root, relative);
    if (!(await exists(file))) return null;
    try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size > maximum)
            throw new CrafleetError(
                "CONFIG_UNSUPPORTED",
                "A managed configuration is not a bounded regular text file.",
                3,
            );
        const data = await readFile(file);
        if (data.length > maximum)
            throw new CrafleetError(
                "CONFIG_UNSUPPORTED",
                "A managed configuration exceeds the supported size.",
                3,
            );
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch (error) {
        if (error instanceof CrafleetError) throw error;
        throw new CrafleetError(
            "CONFIG_UNREADABLE",
            "A managed configuration cannot be read safely.",
            3,
        );
    }
}

async function writeManagedText(
    root: string,
    relative: string,
    text: string | null,
): Promise<void> {
    const file = await assertNoSymlinks(root, relative);
    if (text === null) {
        if (await exists(file)) {
            if (!(await lstat(file)).isFile())
                throw new CrafleetError(
                    "CONFIG_PATH",
                    "Refusing to remove a configuration directory or non-file.",
                    3,
                );
            await rm(file);
        }
    } else {
        await atomicWrite(file, text);
    }
}

/**
 * The config tree is desired input. State is the last observed, tokenized runtime,
 * not the last merged base; keeping those distinct preserves undeployed edits.
 */
export class NodeConfigManager {
    readonly projectDir: string;
    private readonly baseDir: string;
    private readonly runtimeDir: string;
    private readonly stateDir: string;
    private readonly projectId: string;

    constructor(
        projectDir: string,
        private readonly references: Readonly<
            Record<string, SecretReference>
        > = {},
    ) {
        this.projectDir = path.resolve(projectDir);
        this.baseDir = path.join(this.projectDir, "config");
        this.runtimeDir = path.join(this.projectDir, "runtime");
        this.stateDir = path.join(this.projectDir, ".crafleet");
        this.projectId = createHash("sha256")
            .update(
                process.platform === "win32"
                    ? this.projectDir.toLowerCase()
                    : this.projectDir,
            )
            .digest("hex");
    }

    private async mutate<T>(action: () => Promise<T>): Promise<T> {
        await assertNoSymlinks(this.stateDir);
        return withMutex(path.join(this.stateDir, "config-mutex"), action);
    }

    private async state(): Promise<ConfigState> {
        const raw = await readManagedText(
            this.stateDir,
            "config-state.json",
            MAX_STATE_BYTES,
        );
        if (raw === null)
            return { schemaVersion: 1, files: Object.create(null) };
        let input: unknown;
        try {
            input = JSON.parse(raw);
        } catch {
            throw new CrafleetError(
                "CONFIG_STATE_INVALID",
                "Configuration observation state cannot be parsed safely.",
                3,
            );
        }
        const state = validateConfigState(input);
        for (const relative of Object.keys(state.files))
            if (normalizeConfigRelative(relative) !== relative)
                throw new CrafleetError(
                    "CONFIG_STATE_INVALID",
                    "Configuration state contains a non-canonical path.",
                    3,
                );
        return state;
    }

    private async writeState(state: ConfigState): Promise<void> {
        await writeManagedText(
            this.stateDir,
            "config-state.json",
            `${JSON.stringify(state, null, 2)}\n`,
        );
    }

    private async tracked(
        state: ConfigState,
        extra: readonly string[] = [],
    ): Promise<string[]> {
        await assertNoSymlinks(this.baseDir);
        const paths = [
            ...new Set(
                [
                    ...(await listFiles(this.baseDir)),
                    ...Object.keys(state.files),
                    ...extra,
                ].map(normalizeConfigRelative),
            ),
        ].sort();
        if (
            paths.length > 10_000 ||
            new Set(paths.map((relative) => relative.toLowerCase())).size !==
                paths.length
        )
            throw new CrafleetError(
                "CONFIG_PATH",
                "Configuration paths collide across platforms or exceed the supported file count.",
                3,
            );
        return paths;
    }

    private async snapshot(
        state: ConfigState,
        secrets: ConfigSecrets,
        extra: readonly string[] = [],
        initial: ReadonlySet<string> = new Set(),
    ): Promise<ConfigDiff[]> {
        const files: ConfigDiff[] = [];
        for (const relative of await this.tracked(state, extra)) {
            const base = await readManagedText(this.baseDir, relative);
            const entry = state.files[relative];
            const observed = entry?.observed ?? null;
            const appliedBase =
                entry && Object.hasOwn(entry, "appliedBase")
                    ? (entry.appliedBase ?? null)
                    : undefined;
            if (base !== null) secrets.assertTemplate(relative, base);
            if (observed !== null) secrets.assertTemplate(relative, observed);
            if (appliedBase !== undefined && appliedBase !== null)
                secrets.assertTemplate(relative, appliedBase);
            const raw = await readManagedText(this.runtimeDir, relative);
            const templates = [base, observed].filter(
                (content): content is string => content !== null,
            );
            const runtime =
                raw === null
                    ? null
                    : secrets.tokenize(
                          relative,
                          raw,
                          initial.has(relative) ? undefined : templates,
                      );
            // A deployment can retain uncaptured runtime edits without writing the Git base.
            // Project only subsequent base edits onto that deployed observation first.
            const projected =
                appliedBase === undefined
                    ? { content: base, conflicts: [] }
                    : mergeConfigDocuments(
                          relative,
                          appliedBase,
                          base,
                          observed,
                      );
            const merged =
                projected.conflicts.length > 0
                    ? projected
                    : mergeConfigDocuments(
                          relative,
                          observed,
                          projected.content,
                          runtime,
                      );
            files.push({
                relative,
                format: configFormat(relative),
                base,
                observed,
                runtime,
                content: merged.content,
                baseChanged:
                    base !==
                    (appliedBase === undefined ? observed : appliedBase),
                runtimeChanged: runtime !== observed,
                conflicts: merged.conflicts.map((pointer) =>
                    secrets.redact(pointer),
                ),
            });
        }
        return files;
    }

    async list(): Promise<ConfigFileInfo[]> {
        const state = await this.state();
        const result: ConfigFileInfo[] = [];
        for (const relative of await this.tracked(state)) {
            result.push({
                relative,
                format: configFormat(relative),
                baseExists:
                    (await readManagedText(this.baseDir, relative)) !== null,
                runtimeExists:
                    (await readManagedText(this.runtimeDir, relative)) !== null,
                observed: Object.hasOwn(state.files, relative),
            });
        }
        return result;
    }

    async track(input: string): Promise<ConfigFileInfo> {
        const relative = normalizeConfigRelative(input);
        return this.mutate(async () => {
            const state = await this.state();
            const secrets = await loadConfigSecrets(
                this.projectDir,
                this.references,
            );
            const base = await readManagedText(this.baseDir, relative);
            const raw = await readManagedText(this.runtimeDir, relative);
            if (base === null && raw === null)
                throw new CrafleetError(
                    "CONFIG_NOT_FOUND",
                    "The configuration does not exist in the base or runtime tree.",
                    3,
                );
            if (base !== null) secrets.assertTemplate(relative, base);
            if (Object.hasOwn(state.files, relative))
                return {
                    relative,
                    format: configFormat(relative),
                    baseExists: base !== null,
                    runtimeExists: raw !== null,
                    observed: true,
                };
            await this.tracked(state, [relative]);
            const runtime =
                raw === null ? null : secrets.tokenize(relative, raw);
            if (base === null)
                await writeManagedText(this.baseDir, relative, runtime);
            state.files[relative] = { observed: runtime };
            await this.writeState(state);
            return {
                relative,
                format: configFormat(relative),
                baseExists: base !== null || runtime !== null,
                runtimeExists: runtime !== null,
                observed: true,
            };
        });
    }

    async untrack(input: string): Promise<void> {
        const relative = normalizeConfigRelative(input);
        await this.mutate(async () => {
            const state = await this.state();
            const base = await readManagedText(this.baseDir, relative);
            if (base === null && !Object.hasOwn(state.files, relative))
                throw new CrafleetError(
                    "CONFIG_NOT_TRACKED",
                    "The configuration is not tracked.",
                    3,
                );
            // Commit the observation removal first. A crash may leave an untracked
            // base file, but must never leave a tombstone that deletes runtime later.
            const next = cloneState(state);
            delete next.files[relative];
            await this.writeState(next);
            try {
                await writeManagedText(this.baseDir, relative, null);
            } catch (error) {
                if (fingerprint(await this.state()) === fingerprint(next))
                    await this.writeState(state);
                throw error;
            }
        });
    }

    async diff(): Promise<ConfigDiff[]> {
        const state = await this.state();
        return this.snapshot(
            state,
            await loadConfigSecrets(this.projectDir, this.references),
        );
    }

    private bundle(
        state: ConfigState,
        files: readonly ConfigBundleFile[],
    ): ConfigBundle {
        return {
            schemaVersion: 1,
            projectId: this.projectId,
            stateFingerprint: fingerprint(state),
            state: cloneState(state),
            files: files.map(
                ({ relative, format, base, observed, runtime, content }) => ({
                    relative,
                    format,
                    base,
                    observed,
                    runtime,
                    content,
                }),
            ),
        };
    }

    private checkedBundle(
        input: ConfigBundle,
        secrets: ConfigSecrets,
    ): ConfigBundle {
        const bundle = validateConfigBundle(input);
        if (
            bundle.projectId !== this.projectId ||
            bundle.stateFingerprint !== fingerprint(bundle.state)
        )
            throw new CrafleetError(
                "CONFIG_BUNDLE_INVALID",
                "Pending configuration belongs to another project or has inconsistent observations.",
                3,
            );
        const names = new Set<string>();
        for (const [relative, entry] of Object.entries(bundle.state.files)) {
            if (normalizeConfigRelative(relative) !== relative)
                throw new CrafleetError(
                    "CONFIG_BUNDLE_INVALID",
                    "Pending configuration has an invalid observation path.",
                    3,
                );
            if (entry.observed !== null)
                secrets.assertTemplate(relative, entry.observed);
            if (entry.appliedBase !== undefined && entry.appliedBase !== null)
                secrets.assertTemplate(relative, entry.appliedBase);
        }
        for (const file of bundle.files) {
            if (
                normalizeConfigRelative(file.relative) !== file.relative ||
                names.has(file.relative.toLowerCase()) ||
                file.format !== configFormat(file.relative) ||
                file.observed !==
                    (bundle.state.files[file.relative]?.observed ?? null)
            )
                throw new CrafleetError(
                    "CONFIG_BUNDLE_INVALID",
                    "Pending configuration contains duplicate, invalid, or inconsistent paths.",
                    3,
                );
            names.add(file.relative.toLowerCase());
            for (const content of [
                file.base,
                file.observed,
                file.runtime,
                file.content,
            ])
                if (content !== null)
                    secrets.assertTemplate(file.relative, content);
            const entry = bundle.state.files[file.relative];
            const projected =
                entry && Object.hasOwn(entry, "appliedBase")
                    ? mergeConfigDocuments(
                          file.relative,
                          entry.appliedBase ?? null,
                          file.base,
                          file.observed,
                      )
                    : { content: file.base, conflicts: [] };
            const expected =
                projected.conflicts.length > 0
                    ? projected
                    : mergeConfigDocuments(
                          file.relative,
                          file.observed,
                          projected.content,
                          file.runtime,
                      );
            if (
                expected.conflicts.length > 0 ||
                expected.content !== file.content
            )
                throw new CrafleetError(
                    "CONFIG_BUNDLE_INVALID",
                    "Pending configuration does not match its source snapshots.",
                    3,
                );
        }
        return bundle;
    }

    private async unchanged(
        bundle: ConfigBundle,
        secrets: ConfigSecrets,
    ): Promise<void> {
        const state = await this.state();
        if (fingerprint(state) !== bundle.stateFingerprint) stale();
        const current = await this.snapshot(state, secrets);
        if (current.length !== bundle.files.length) stale();
        for (const file of bundle.files) {
            const found = current.find(
                (entry) => entry.relative === file.relative,
            );
            if (
                !found ||
                found.base !== file.base ||
                found.runtime !== file.runtime ||
                found.observed !== file.observed
            )
                stale();
        }
    }

    async prepare(): Promise<ConfigBundle> {
        const state = await this.state();
        const secrets = await loadConfigSecrets(
            this.projectDir,
            this.references,
        );
        const files = await this.snapshot(state, secrets);
        if (files.some((file) => file.conflicts.length > 0))
            throw new CrafleetError(
                "CONFIG_CONFLICT",
                "Configuration has unresolved changes. Review config diff and resolve the affected files before preparing a deployment.",
                3,
            );
        const bundle = this.bundle(state, files);
        this.checkedBundle(bundle, secrets);
        await this.unchanged(bundle, secrets);
        return bundle;
    }

    async assertUnchanged(input: ConfigBundle): Promise<void> {
        const secrets = await loadConfigSecrets(
            this.projectDir,
            this.references,
        );
        await this.unchanged(this.checkedBundle(input, secrets), secrets);
    }

    /** Caller must verify the persistent project identity before allowing a backup to move hosts. */
    async prepareRestoredBundle(
        input: ConfigBundle,
        rebindProject = false,
    ): Promise<ConfigBundle> {
        const secrets = await loadConfigSecrets(
            this.projectDir,
            this.references,
        );
        const bundle = validateConfigBundle(input);
        return this.checkedBundle(
            rebindProject ? { ...bundle, projectId: this.projectId } : bundle,
            secrets,
        );
    }

    private async captureCommit(
        state: ConfigState,
        files: ConfigDiff[],
        secrets: ConfigSecrets,
    ): Promise<void> {
        // All conflicts are checked before the first write. Baseline is committed last.
        if (fingerprint(await this.state()) !== fingerprint(state)) stale();
        for (const file of files) {
            if (
                (await readManagedText(this.baseDir, file.relative)) !==
                file.base
            )
                stale();
            const raw = await readManagedText(this.runtimeDir, file.relative);
            if (
                (raw === null ? null : secrets.tokenize(file.relative, raw)) !==
                file.runtime
            )
                stale();
        }
        const next = cloneState(state);
        const written: ConfigDiff[] = [];
        try {
            for (const file of files) {
                if (file.content !== file.base) {
                    if (file.content !== null)
                        secrets.assertTemplate(file.relative, file.content);
                    await writeManagedText(
                        this.baseDir,
                        file.relative,
                        file.content,
                    );
                    written.push(file);
                }
                next.files[file.relative] = { observed: file.runtime };
            }
            if (fingerprint(next) !== fingerprint(state))
                await this.writeState(next);
        } catch {
            for (const file of written.reverse()) {
                if (
                    (await readManagedText(this.baseDir, file.relative)) !==
                    file.content
                )
                    throw new CrafleetError(
                        "CONFIG_RECOVERY_REQUIRED",
                        "Configuration changed while capture was being recovered. Review the base files before retrying.",
                        3,
                    );
                await writeManagedText(this.baseDir, file.relative, file.base);
            }
            const currentState = fingerprint(await this.state());
            if (
                currentState === fingerprint(next) &&
                currentState !== fingerprint(state)
            )
                await this.writeState(state);
            else if (currentState !== fingerprint(state))
                throw new CrafleetError(
                    "CONFIG_RECOVERY_REQUIRED",
                    "Configuration observations changed while capture was being recovered.",
                    3,
                );
            throw new CrafleetError(
                "CONFIG_CAPTURE_FAILED",
                "Configuration capture failed; completed base writes were reverted.",
                3,
            );
        }
    }

    async capture(
        options: ConfigCaptureOptions = {},
    ): Promise<ConfigCaptureResult> {
        const operation = async () => {
            const state = await this.state();
            const secrets = await loadConfigSecrets(
                this.projectDir,
                this.references,
            );
            const initial = new Set<string>();
            if (options.initial) {
                if (!options.kind)
                    throw new CrafleetError(
                        "CONFIG_KIND",
                        "Initial configuration discovery requires the server kind.",
                        2,
                    );
                for (const candidate of await discoverConfigCandidates(
                    this.runtimeDir,
                    options.kind,
                )) {
                    if (
                        candidate.selectedByDefault ||
                        (options.includeBans &&
                            candidate.category === "ban-list")
                    )
                        initial.add(candidate.relative);
                }
            }
            const selected = options.paths
                ? new Set(options.paths.map(normalizeConfigRelative))
                : undefined;
            const all = await this.snapshot(
                state,
                secrets,
                [...initial, ...(selected ?? [])],
                initial,
            );
            const files = selected
                ? all.filter((file) => selected.has(file.relative))
                : all;
            for (const file of files)
                if (
                    !Object.hasOwn(state.files, file.relative) &&
                    file.base === null &&
                    file.runtime === null
                )
                    throw new CrafleetError(
                        "CONFIG_NOT_FOUND",
                        "A selected configuration does not exist.",
                        3,
                    );
            const result: ConfigCaptureResult = {
                captured: files
                    .filter((file) => file.content !== file.base)
                    .map((file) => file.relative),
                unchanged: files
                    .filter((file) => file.content === file.base)
                    .map((file) => file.relative),
                conflicts: files
                    .filter((file) => file.conflicts.length > 0)
                    .map((file) => ({
                        relative: file.relative,
                        paths: file.conflicts,
                    })),
            };
            if (!options.dryRun && result.conflicts.length === 0)
                await this.captureCommit(state, files, secrets);
            // Conflicts mean no base files or observation state were committed.
            if (result.conflicts.length > 0) result.captured = [];
            return result;
        };
        return options.dryRun ? operation() : this.mutate(operation);
    }

    async resolve(input: string, choice: "base" | "runtime"): Promise<void> {
        const relative = normalizeConfigRelative(input);
        if (choice !== "base" && choice !== "runtime")
            throw new CrafleetError(
                "CONFIG_RESOLUTION",
                "Select base or runtime for a conflict resolution.",
                2,
            );
        await this.mutate(async () => {
            const state = await this.state();
            if (!(await this.tracked(state)).includes(relative))
                throw new CrafleetError(
                    "CONFIG_NOT_TRACKED",
                    "The configuration is not tracked.",
                    3,
                );
            const secrets = await loadConfigSecrets(
                this.projectDir,
                this.references,
            );
            const file = (await this.snapshot(state, secrets)).find(
                (entry) => entry.relative === relative,
            );
            if (!file)
                throw new CrafleetError(
                    "CONFIG_NOT_FOUND",
                    "The configuration does not exist.",
                    3,
                );
            await this.captureCommit(
                state,
                [
                    {
                        ...file,
                        content: choice === "base" ? file.base : file.runtime,
                        conflicts: [],
                    },
                ],
                secrets,
            );
        });
    }

    /** Caller must hold the project lifecycle lock and prove the JVM is stopped. */
    async apply(input: ConfigBundle): Promise<void> {
        await this.mutate(async () => {
            const secrets = await loadConfigSecrets(
                this.projectDir,
                this.references,
            );
            const bundle = this.checkedBundle(input, secrets);
            await this.unchanged(bundle, secrets);
            // Resolve all values before touching runtime. Plaintext stays in memory/runtime.
            const emitted = bundle.files.map((file) => ({
                file,
                raw:
                    file.content === null
                        ? null
                        : secrets.inject(file.relative, file.content),
            }));
            const next = cloneState(bundle.state);
            for (const { file, raw } of emitted) {
                if (
                    (await readManagedText(this.runtimeDir, file.relative)) !==
                    raw
                )
                    await writeManagedText(this.runtimeDir, file.relative, raw);
                next.files[file.relative] = {
                    observed:
                        raw === null
                            ? null
                            : secrets.tokenize(
                                  file.relative,
                                  raw,
                                  file.content === null ? [] : [file.content],
                              ),
                    appliedBase: file.base,
                };
            }
            if (fingerprint(next) !== bundle.stateFingerprint)
                await this.writeState(next);
        });
    }

    private async restorePlan(input: ConfigBundle) {
        const secrets = await loadConfigSecrets(
            this.projectDir,
            this.references,
        );
        const bundle = this.checkedBundle(input, secrets);
        const oldState = cloneState(bundle.state);
        const appliedState = cloneState(bundle.state);
        const restore: {
            relative: string;
            raw: string | null;
            current: string | null;
        }[] = [];
        for (const file of bundle.files) {
            const oldRaw =
                file.runtime === null
                    ? null
                    : secrets.inject(file.relative, file.runtime);
            const newRaw =
                file.content === null
                    ? null
                    : secrets.inject(file.relative, file.content);
            const templates = [file.runtime, file.content].filter(
                (text): text is string => text !== null,
            );
            const oldToken =
                oldRaw === null
                    ? null
                    : secrets.tokenize(file.relative, oldRaw, templates);
            const newToken =
                newRaw === null
                    ? null
                    : secrets.tokenize(file.relative, newRaw, templates);
            appliedState.files[file.relative] = {
                observed: newToken,
                appliedBase: file.base,
            };
            const current = await readManagedText(
                this.runtimeDir,
                file.relative,
            );
            const currentToken =
                current === null
                    ? null
                    : secrets.tokenize(file.relative, current, templates);
            if (
                currentToken !== file.runtime &&
                currentToken !== oldToken &&
                currentToken !== newToken
            )
                throw new CrafleetError(
                    "CONFIG_RECOVERY_REQUIRED",
                    "Runtime configuration changed outside the pending deployment; refusing to overwrite it during recovery.",
                    3,
                );
            restore.push({ relative: file.relative, raw: oldRaw, current });
        }
        const currentState = fingerprint(await this.state());
        if (
            currentState !== fingerprint(oldState) &&
            currentState !== fingerprint(appliedState)
        )
            throw new CrafleetError(
                "CONFIG_RECOVERY_REQUIRED",
                "Configuration observations changed outside the pending deployment; recovery requires review.",
                3,
            );
        return {
            files: restore,
            state: oldState,
            stateChanged: currentState !== fingerprint(oldState),
        };
    }

    /** Read-only validation for lifecycle recovery before any JAR is restored. */
    async assertRestorable(input: ConfigBundle): Promise<void> {
        await this.restorePlan(input);
    }

    /** Recovery is allowed only before a replacement JVM has been spawned. */
    async restore(input: ConfigBundle): Promise<void> {
        await this.mutate(async () => {
            const plan = await this.restorePlan(input);
            for (const file of plan.files) {
                if (
                    (await readManagedText(this.runtimeDir, file.relative)) !==
                    file.current
                )
                    throw new CrafleetError(
                        "CONFIG_RECOVERY_REQUIRED",
                        "Runtime configuration changed during recovery; refusing to overwrite it.",
                        3,
                    );
                if (file.raw !== file.current)
                    await writeManagedText(
                        this.runtimeDir,
                        file.relative,
                        file.raw,
                    );
            }
            if (plan.stateChanged) await this.writeState(plan.state);
        });
    }
}

/** Known existing files only; arbitrary plugin YAML and generated player data are not inferred to be configuration. */
export async function discoverConfigCandidates(
    runtimeDir: string,
    kind: "paper" | "velocity",
): Promise<ConfigCandidate[]> {
    await assertNoSymlinks(runtimeDir);
    const candidates: ConfigCandidate[] = [];
    const add = async (
        relative: string,
        category: ConfigCandidate["category"] = "configuration",
        selectedByDefault = true,
    ) => {
        const file = await assertNoSymlinks(runtimeDir, relative);
        if ((await exists(file)) && (await lstat(file)).isFile())
            candidates.push({ relative, category, selectedByDefault });
    };
    if (kind === "velocity") {
        await add("velocity.toml");
        return candidates;
    }
    for (const relative of [
        "server.properties",
        "bukkit.yml",
        "spigot.yml",
        "commands.yml",
        "permissions.yml",
        "help.yml",
        "config/paper-global.yml",
        "config/paper-world-defaults.yml",
        "paper.yml",
    ])
        await add(relative);
    for (const relative of ["ops.json", "whitelist.json"])
        await add(relative, "access-list");
    for (const relative of ["banned-players.json", "banned-ips.json"])
        await add(relative, "ban-list", false);
    let directories = 0;
    const excluded = new Set([
        "plugins",
        "libraries",
        "versions",
        "cache",
        "logs",
        "crash-reports",
        ".git",
        ".crafleet",
    ]);
    async function discoverWorld(
        directory: string,
        prefix: string,
        depth: number,
    ): Promise<void> {
        if (++directories > 10_000 || depth > 16)
            throw new CrafleetError(
                "CONFIG_DISCOVERY_LIMIT",
                "World configuration discovery exceeded its bound; track additional files explicitly.",
                3,
            );
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isFile() && entry.name === "paper-world.yml")
                await add(relative, "world");
            else if (entry.isDirectory() && !excluded.has(entry.name))
                await discoverWorld(
                    path.join(directory, entry.name),
                    relative,
                    depth + 1,
                );
        }
    }
    if (await exists(runtimeDir)) await discoverWorld(runtimeDir, "", 0);
    return candidates.sort((left, right) =>
        left.relative.localeCompare(right.relative, "en"),
    );
}
