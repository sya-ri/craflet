import { type } from "arktype";
import { CrafleetError } from "./errors.js";

/** Configuration snapshots contain authored text and secret tokens, never resolved secrets. */
const ConfigFormatSchema = type(
    "'yaml' | 'json' | 'properties' | 'toml' | 'text'",
);
export type ConfigFormat = typeof ConfigFormatSchema.infer;

export interface SecretReference {
    env?: string;
    file?: string;
}

const ConfigSnapshot = type("string <= 4194304 | null");
export const ConfigStateSchema = type({
    "+": "reject",
    schemaVersion: "1",
    files: {
        "[string]": {
            "+": "reject",
            observed: ConfigSnapshot,
            "appliedBase?": ConfigSnapshot,
        },
    },
});
export type ConfigState = typeof ConfigStateSchema.infer;
export const ConfigBundleFileSchema = type({
    "+": "reject",
    relative: "string > 0",
    format: ConfigFormatSchema,
    base: ConfigSnapshot,
    observed: ConfigSnapshot,
    runtime: ConfigSnapshot,
    content: ConfigSnapshot,
});
export type ConfigBundleFile = typeof ConfigBundleFileSchema.infer;
export const ConfigBundleSchema = type({
    "+": "reject",
    schemaVersion: "1",
    projectId: "string > 0",
    stateFingerprint: /^[a-f0-9]{64}$/,
    state: ConfigStateSchema,
    files: ConfigBundleFileSchema.array(),
});
export type ConfigBundle = typeof ConfigBundleSchema.infer;

function normalizeConfigState(state: ConfigState): ConfigState {
    const files: ConfigState["files"] = Object.assign(
        Object.create(null),
        state.files,
    );
    return { ...state, files };
}

export function validateConfigState(input: unknown): ConfigState {
    const result = ConfigStateSchema(input);
    if (result instanceof type.errors || Array.isArray(result.files))
        throw new CrafleetError(
            "CONFIG_STATE_INVALID",
            "Configuration observation state is invalid; no input values have been included in this error.",
            3,
        );
    return normalizeConfigState(result);
}

export function validateConfigBundle(input: unknown): ConfigBundle {
    const result = ConfigBundleSchema(input);
    if (result instanceof type.errors || Array.isArray(result.state.files))
        throw new CrafleetError(
            "CONFIG_BUNDLE_INVALID",
            "Pending configuration is invalid; no input values have been included in this error.",
            3,
        );
    return { ...result, state: normalizeConfigState(result.state) };
}

export interface ConfigConflict {
    relative: string;
    /** JSON-pointer-like locations only. Conflicting values must not appear here. */
    paths: string[];
}

export interface ConfigCaptureOptions {
    paths?: readonly string[];
    dryRun?: boolean;
    initial?: boolean;
    kind?: "paper" | "velocity";
    includeBans?: boolean;
}

export interface ConfigCaptureResult {
    captured: string[];
    unchanged: string[];
    conflicts: ConfigConflict[];
}

export interface ConfigFileInfo {
    relative: string;
    format: ConfigFormat;
    baseExists: boolean;
    runtimeExists: boolean;
    observed: boolean;
}

export interface ConfigDiff extends ConfigBundleFile {
    baseChanged: boolean;
    runtimeChanged: boolean;
    conflicts: string[];
}

export interface ConfigCandidate {
    relative: string;
    category: "configuration" | "access-list" | "ban-list" | "world";
    selectedByDefault: boolean;
}

export function configFormat(relative: string): ConfigFormat {
    const extension = relative.toLowerCase().split(".").at(-1);
    if (extension === "yml" || extension === "yaml") return "yaml";
    if (extension === "json") return "json";
    if (extension === "properties") return "properties";
    if (extension === "toml") return "toml";
    return "text";
}

export function isConfigRecord(
    value: unknown,
): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function configEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left instanceof Date && right instanceof Date) {
        return left.toISOString() === right.toISOString();
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return (
            left.length === right.length &&
            left.every((item, index) => configEqual(item, right[index]))
        );
    }
    if (!isConfigRecord(left) || !isConfigRecord(right)) return false;
    const keys = Object.keys(left);
    return (
        keys.length === Object.keys(right).length &&
        keys.every(
            (key) =>
                Object.hasOwn(right, key) && configEqual(left[key], right[key]),
        )
    );
}

export function configPointer(parts: readonly (string | number)[]): string {
    return parts.length === 0
        ? "/"
        : `/${parts.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/** Arrays are atomic: positions do not establish identity for player or plugin data. */
export function mergeConfigValues(
    observed: unknown,
    base: unknown,
    runtime: unknown,
): { value: unknown; conflicts: string[] } {
    const missing = Symbol("missing configuration key");
    const conflicts: string[] = [];
    function merge(
        old: unknown,
        ours: unknown,
        theirs: unknown,
        path: string[],
    ): unknown {
        if (configEqual(ours, theirs)) return ours;
        if (configEqual(ours, old)) return theirs;
        if (configEqual(theirs, old)) return ours;
        if (
            isConfigRecord(ours) &&
            isConfigRecord(theirs) &&
            (isConfigRecord(old) || old === missing)
        ) {
            const previous = isConfigRecord(old) ? old : {};
            const keys = new Set([
                ...Object.keys(ours),
                ...Object.keys(theirs),
                ...Object.keys(previous),
            ]);
            const value: Record<string, unknown> = Object.create(null);
            for (const key of keys) {
                const next = merge(
                    Object.hasOwn(previous, key) ? previous[key] : missing,
                    Object.hasOwn(ours, key) ? ours[key] : missing,
                    Object.hasOwn(theirs, key) ? theirs[key] : missing,
                    [...path, key],
                );
                if (next !== missing) value[key] = next;
            }
            return value;
        }
        conflicts.push(configPointer(path));
        return ours;
    }
    return { value: merge(observed, base, runtime, []), conflicts };
}

interface LineEdit {
    start: number;
    end: number;
    lines: string[];
}

function lines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lineEdits(before: string[], after: string[]): LineEdit[] | null {
    const width = after.length + 1;
    // Bound quadratic work; very large unfamiliar files are a manual merge.
    if ((before.length + 1) * width > 1_000_000) return null;
    const table = new Uint32Array((before.length + 1) * width);
    for (let left = before.length - 1; left >= 0; left--) {
        for (let right = after.length - 1; right >= 0; right--) {
            table[left * width + right] =
                before[left] === after[right]
                    ? (table[(left + 1) * width + right + 1] ?? 0) + 1
                    : Math.max(
                          table[(left + 1) * width + right] ?? 0,
                          table[left * width + right + 1] ?? 0,
                      );
        }
    }
    const edits: LineEdit[] = [];
    let left = 0;
    let right = 0;
    while (left < before.length || right < after.length) {
        if (
            left < before.length &&
            right < after.length &&
            before[left] === after[right]
        ) {
            left++;
            right++;
            continue;
        }
        const start = left;
        const replacement: string[] = [];
        while (left < before.length || right < after.length) {
            if (
                left < before.length &&
                right < after.length &&
                before[left] === after[right]
            )
                break;
            if (
                right < after.length &&
                (left === before.length ||
                    (table[left * width + right + 1] ?? 0) >=
                        (table[(left + 1) * width + right] ?? 0))
            ) {
                replacement.push(after[right] ?? "");
                right++;
            } else left++;
        }
        edits.push({ start, end: left, lines: replacement });
    }
    return edits;
}

function overlaps(left: LineEdit, right: LineEdit): boolean {
    if (left.start === left.end)
        return left.start >= right.start && left.start <= right.end;
    if (right.start === right.end)
        return right.start >= left.start && right.start <= left.end;
    return left.start < right.end && right.start < left.end;
}

/** An unresolved deletion or overlapping text edit never becomes conflict-marker text. */
export function mergeConfigText(
    observed: string | null,
    base: string | null,
    runtime: string | null,
): { content: string | null; conflicts: string[] } {
    if (base === runtime) return { content: base, conflicts: [] };
    if (base === observed) return { content: runtime, conflicts: [] };
    if (runtime === observed) return { content: base, conflicts: [] };
    if (observed === null || base === null || runtime === null)
        return { content: base, conflicts: ["/"] };
    const original = lines(observed);
    const ours = lineEdits(original, lines(base));
    const theirs = lineEdits(original, lines(runtime));
    if (ours === null || theirs === null)
        return { content: base, conflicts: ["/"] };
    const edits: LineEdit[] = [...ours];
    const conflicts: string[] = [];
    for (const incoming of theirs) {
        const intersecting = ours.filter((edit) => overlaps(edit, incoming));
        if (
            intersecting.some(
                (edit) =>
                    edit.start === incoming.start &&
                    edit.end === incoming.end &&
                    configEqual(edit.lines, incoming.lines),
            )
        )
            continue;
        if (intersecting.length > 0) {
            conflicts.push(`/lines/${incoming.start + 1}`);
        } else edits.push(incoming);
    }
    if (conflicts.length > 0) return { content: base, conflicts };
    edits.sort((left, right) => left.start - right.start);
    const output: string[] = [];
    let position = 0;
    for (const edit of edits) {
        output.push(...original.slice(position, edit.start), ...edit.lines);
        position = edit.end;
    }
    output.push(...original.slice(position));
    return { content: output.join(""), conflicts: [] };
}
