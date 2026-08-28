import {
    type ConfigFormat,
    CrafletError,
    configEqual,
    configFormat,
    isConfigRecord,
    mergeConfigText,
    mergeConfigValues,
} from "@craflet/core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { type Document, isScalar, parseDocument, visit } from "yaml";

export interface ConfigDocument {
    format: ConfigFormat;
    text: string;
    value: unknown;
    render(value: unknown): string;
}

function invalid(): never {
    // Parser errors often contain source excerpts, including credentials.
    throw new CrafletError(
        "CONFIG_INVALID",
        "A configuration file cannot be parsed safely. Inspect it locally; its contents have not been included in this error.",
        3,
    );
}

function unsupported(): never {
    throw new CrafletError(
        "CONFIG_UNSUPPORTED",
        "This configuration uses a structure that cannot be safely merged automatically.",
        3,
    );
}

function assertTree(value: unknown): void {
    const ancestors = new Set<object>();
    let count = 0;
    function walk(node: unknown, depth: number): void {
        if (++count > 100_000 || depth > 100) unsupported();
        if (
            node === null ||
            ["string", "boolean", "bigint"].includes(typeof node)
        )
            return;
        if (typeof node === "number") {
            if (Number.isInteger(node) && !Number.isSafeInteger(node))
                unsupported();
            return;
        }
        if (node instanceof Date) return;
        if (!Array.isArray(node) && !isConfigRecord(node)) unsupported();
        const object = node as object;
        if (ancestors.has(object)) unsupported();
        ancestors.add(object);
        for (const child of Array.isArray(node)
            ? node
            : Object.values(node as Record<string, unknown>))
            walk(child, depth + 1);
        ancestors.delete(object);
    }
    walk(value, 0);
}

function preserveLineEndings(original: string, result: string): string {
    return original.includes("\r\n")
        ? result.replaceAll(/(?<!\r)\n/g, "\r\n")
        : result;
}

interface PropertyLine {
    raw: string;
    key?: string;
}

function decodeProperty(value: string): string {
    let decoded = "";
    for (let index = 0; index < value.length; index++) {
        const character = value[index] ?? "";
        if (character !== "\\") {
            decoded += character;
            continue;
        }
        const escaped = value[++index];
        if (escaped === undefined) invalid();
        if (escaped === "u") {
            const digits = value.slice(index + 1, index + 5);
            if (!/^[a-f\d]{4}$/i.test(digits)) invalid();
            decoded += String.fromCharCode(Number.parseInt(digits, 16));
            index += 4;
        } else
            decoded +=
                (
                    { t: "\t", r: "\r", n: "\n", f: "\f" } as Record<
                        string,
                        string
                    >
                )[escaped] ?? escaped;
    }
    return decoded;
}

function encodeProperty(value: string, key = false): string {
    let encoded = "";
    for (let index = 0; index < value.length; index++) {
        const character = value[index] ?? "";
        const code = value.charCodeAt(index);
        if (character === "\\") encoded += "\\\\";
        else if (character === "\n") encoded += "\\n";
        else if (character === "\r") encoded += "\\r";
        else if (character === "\t") encoded += "\\t";
        else if (character === "\f") encoded += "\\f";
        else if (code < 32 || code >= 127)
            encoded += `\\u${code.toString(16).padStart(4, "0")}`;
        else if (
            (key && /[ =:#!]/.test(character)) ||
            (!key && index === 0 && character === " ")
        )
            encoded += `\\${character}`;
        else encoded += character;
    }
    return encoded;
}

function propertyDocument(text: string): ConfigDocument {
    const physical =
        text
            .match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)
            ?.filter((line) => line !== "") ?? [];
    const entries: PropertyLine[] = [];
    const value: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < physical.length; index++) {
        let raw = physical[index] ?? "";
        let logical = raw.replace(/[\r\n]+$/, "");
        if (/^[ \t\f]*(?:[#!]|$)/.test(logical)) {
            entries.push({ raw });
            continue;
        }
        while ((logical.match(/\\+$/)?.[0].length ?? 0) % 2 === 1) {
            logical = logical.slice(0, -1);
            if (index + 1 === physical.length) break;
            const continuation = physical[++index] ?? "";
            raw += continuation;
            logical += continuation
                .replace(/[\r\n]+$/, "")
                .replace(/^[ \t\f]+/, "");
        }
        logical = logical.replace(/^[ \t\f]+/, "");
        let separator = logical.length;
        let escaped = false;
        for (let position = 0; position < logical.length; position++) {
            const character = logical[position] ?? "";
            if (!escaped && /[=: \t\f]/.test(character)) {
                separator = position;
                break;
            }
            escaped = !escaped && character === "\\";
        }
        const key = decodeProperty(logical.slice(0, separator));
        let rest = logical.slice(separator).replace(/^[ \t\f]+/, "");
        if (/^[=:]/.test(rest)) rest = rest.slice(1);
        rest = rest.replace(/^[ \t\f]+/, "");
        if (Object.hasOwn(value, key)) unsupported();
        value[key] = decodeProperty(rest);
        entries.push({ raw, key });
    }
    return {
        format: "properties",
        text,
        value,
        render(next) {
            if (configEqual(value, next)) return text;
            if (
                !isConfigRecord(next) ||
                Object.values(next).some((item) => typeof item !== "string")
            )
                unsupported();
            const newline = text.includes("\r\n") ? "\r\n" : "\n";
            const rendered: string[] = [];
            const seen = new Set<string>();
            for (const entry of entries) {
                if (entry.key === undefined) {
                    rendered.push(entry.raw);
                    continue;
                }
                seen.add(entry.key);
                if (!Object.hasOwn(next, entry.key)) continue;
                if (next[entry.key] === value[entry.key])
                    rendered.push(entry.raw);
                else
                    rendered.push(
                        `${encodeProperty(entry.key, true)}=${encodeProperty(next[entry.key] as string)}${newline}`,
                    );
            }
            for (const [key, item] of Object.entries(next)) {
                if (seen.has(key)) continue;
                if (
                    rendered.length > 0 &&
                    !/[\r\n]$/.test(rendered.at(-1) ?? "")
                )
                    rendered.push(newline);
                rendered.push(
                    `${encodeProperty(key, true)}=${encodeProperty(item as string)}${newline}`,
                );
            }
            return rendered.join("");
        },
    };
}

export function parseConfigDocument(
    relative: string,
    text: string,
): ConfigDocument {
    if (text.length > 4 * 1024 * 1024 || text.includes("\0")) unsupported();
    const format = configFormat(relative);
    try {
        if (format === "text")
            return {
                format,
                text,
                value: text,
                render: (value) =>
                    typeof value === "string" ? value : unsupported(),
            };
        if (format === "properties") return propertyDocument(text);
        if (format === "json") {
            const value: unknown = JSON.parse(text);
            // JSON.parse silently accepts duplicate keys. Reject that ambiguity before rewriting.
            if (
                parseDocument(text, { schema: "json", uniqueKeys: true }).errors
                    .length > 0
            )
                invalid();
            assertTree(value);
            return {
                format,
                text,
                value,
                render(next) {
                    if (configEqual(value, next)) return text;
                    const indent = text.match(/\n([\t ]+)\S/)?.[1] ?? "  ";
                    const output = JSON.stringify(next, null, indent);
                    if (output === undefined) unsupported();
                    return preserveLineEndings(
                        text,
                        `${output}${/[\r\n]$/.test(text) ? "\n" : ""}`,
                    );
                },
            };
        }
        if (format === "toml") {
            const value = parseToml(text, { integersAsBigInt: true });
            assertTree(value);
            return {
                format,
                text,
                value,
                render: (next) =>
                    configEqual(value, next)
                        ? text
                        : preserveLineEndings(
                              text,
                              stringifyToml(
                                  next as Parameters<typeof stringifyToml>[0],
                                  { numbersAsFloat: true },
                              ),
                          ),
            };
        }
        const document = parseDocument(text, {
            uniqueKeys: true,
            intAsBigInt: true,
            keepSourceTokens: true,
        });
        if (document.errors.length > 0 || document.warnings.length > 0)
            invalid();
        let aliases = false;
        visit(document, {
            Alias() {
                aliases = true;
            },
            Map(_key, node) {
                for (const item of node.items)
                    if (
                        !isScalar(item.key) ||
                        typeof item.key.value !== "string"
                    )
                        unsupported();
            },
        });
        const value: unknown = document.toJS({ maxAliasCount: 50 });
        assertTree(value);
        return {
            format,
            text,
            value,
            render(next) {
                if (configEqual(value, next)) return text;
                if (aliases) unsupported();
                const edited: Document = document.clone();
                function patch(
                    previous: unknown,
                    replacement: unknown,
                    keys: string[],
                ): void {
                    if (configEqual(previous, replacement)) return;
                    if (
                        isConfigRecord(previous) &&
                        isConfigRecord(replacement)
                    ) {
                        for (const key of Object.keys(previous))
                            if (!Object.hasOwn(replacement, key))
                                edited.deleteIn([...keys, key]);
                        for (const [key, item] of Object.entries(replacement)) {
                            if (Object.hasOwn(previous, key))
                                patch(previous[key], item, [...keys, key]);
                            else edited.setIn([...keys, key], item);
                        }
                        return;
                    }
                    const node = edited.getIn(keys, true);
                    if (
                        isScalar(node) &&
                        (replacement === null ||
                            typeof replacement !== "object")
                    )
                        node.value = replacement;
                    else if (keys.length === 0)
                        edited.contents = edited.createNode(replacement);
                    else edited.setIn(keys, replacement);
                }
                patch(value, next, []);
                return preserveLineEndings(
                    text,
                    edited.toString({ lineWidth: 0 }),
                );
            },
        };
    } catch (error) {
        if (error instanceof CrafletError) throw error;
        invalid();
    }
}

export function mapConfigStrings(
    value: unknown,
    transform: (value: string, path: (string | number)[]) => string,
    path: (string | number)[] = [],
): unknown {
    if (typeof value === "string") return transform(value, path);
    if (Array.isArray(value))
        return value.map((item, index) =>
            mapConfigStrings(item, transform, [...path, index]),
        );
    if (isConfigRecord(value)) {
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, item] of Object.entries(value))
            result[key] = mapConfigStrings(item, transform, [...path, key]);
        return result;
    }
    return value;
}

export function mergeConfigDocuments(
    relative: string,
    observed: string | null,
    base: string | null,
    runtime: string | null,
): { content: string | null; conflicts: string[] } {
    if (
        configFormat(relative) === "text" ||
        observed === null ||
        base === null ||
        runtime === null
    )
        return mergeConfigText(observed, base, runtime);
    const old = parseConfigDocument(relative, observed);
    const ours = parseConfigDocument(relative, base);
    const theirs = parseConfigDocument(relative, runtime);
    const merged = mergeConfigValues(old.value, ours.value, theirs.value);
    return {
        content:
            merged.conflicts.length === 0 ? ours.render(merged.value) : base,
        conflicts: merged.conflicts,
    };
}
