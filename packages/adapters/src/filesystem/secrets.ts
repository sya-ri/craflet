import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
    CrafleetError,
    configPointer,
    isConfigRecord,
    type SecretReference,
} from "@crafleet/core";
import {
    type ConfigDocument,
    mapConfigStrings,
    parseConfigDocument,
} from "../formats/config.js";
import { assertNoSymlinks, containedPath } from "./io.js";

const tokenPattern = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

function secretError(code: string): never {
    const messages: Record<string, string> = {
        SECRET_REFERENCE:
            "A secret reference is invalid; select exactly one environment variable or file.",
        SECRET_UNAVAILABLE:
            "A required secret is unavailable or cannot be read safely.",
        SECRET_AMBIGUOUS:
            "Secret values must be nonempty and distinguishable; ambiguous values cannot be tokenized safely.",
        SECRET_PLAINTEXT:
            "A managed configuration contains a resolved secret. Replace it with a secret token before continuing.",
        SECRET_LOCATION:
            "A secret was changed or moved to an unrecognized location. Resolve the source and runtime configuration manually; no values were captured.",
        SECRET_TOKEN:
            "A secret placeholder is invalid, unresolved, or outside a supported string value.",
    };
    throw new CrafleetError(
        code,
        messages[code] ?? "A secret could not be handled safely.",
        3,
    );
}

/** Values live only in this in-memory object; it is never part of a pending bundle. */
export class ConfigSecrets {
    private readonly replacements: RegExp | undefined;
    private readonly redactions: RegExp | undefined;
    private readonly namesByValue: Map<string, string>;

    constructor(private readonly values: ReadonlyMap<string, string>) {
        this.namesByValue = new Map();
        for (const [name, value] of values) {
            if (!/^[A-Za-z0-9_.-]+$/.test(name))
                secretError("SECRET_REFERENCE");
            if (
                value.length === 0 ||
                value.length > 65_536 ||
                value.includes("\0") ||
                value.includes("${secret:") ||
                this.namesByValue.has(value)
            )
                secretError("SECRET_AMBIGUOUS");
            this.namesByValue.set(value, name);
        }
        if (values.size > 0) {
            const alternatives = [...this.namesByValue.keys()]
                .sort((left, right) => right.length - left.length)
                .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            this.replacements = new RegExp(alternatives.join("|"), "g");
            // Log lines can contain only one line, or JSON-escaped text, from a
            // multiline secret. Redaction is intentionally broader than tokenization.
            const fragments = new Set<string>();
            for (const value of values.values()) {
                for (const fragment of [value, ...value.split(/\r\n|\r|\n/)]) {
                    if (!fragment.trim()) continue;
                    fragments.add(fragment);
                    fragments.add(fragment.trim());
                    fragments.add(JSON.stringify(fragment).slice(1, -1));
                    fragments.add(JSON.stringify(fragment.trim()).slice(1, -1));
                }
            }
            this.redactions = fragments.size
                ? new RegExp(
                      [...fragments]
                          .sort((left, right) => right.length - left.length)
                          .map((value) =>
                              value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                          )
                          .join("|"),
                      "g",
                  )
                : undefined;
        }
    }

    redact(value: string): string {
        return this.redactions
            ? value.replace(this.redactions, "[redacted]")
            : value;
    }

    private mask(value: string): string {
        return this.replacements
            ? value.replace(
                  this.replacements,
                  (match) => `\${secret:${this.namesByValue.get(match)}}`,
              )
            : value;
    }

    private withoutTokens(value: string): string {
        return value.replace(tokenPattern, "");
    }

    private names(value: string): string[] {
        const matches = [...value.matchAll(tokenPattern)];
        if (this.withoutTokens(value).includes("${secret:"))
            secretError("SECRET_TOKEN");
        const names = matches.map((match) => match[1] ?? "");
        if (names.some((name) => !this.values.has(name)))
            secretError("SECRET_TOKEN");
        return names;
    }

    private assertKeys(value: unknown): void {
        if (Array.isArray(value)) {
            for (const item of value) this.assertKeys(item);
            return;
        }
        if (!isConfigRecord(value)) return;
        for (const [key, item] of Object.entries(value)) {
            if (key.includes("${secret:") || this.mask(key) !== key)
                secretError("SECRET_LOCATION");
            this.assertKeys(item);
        }
    }

    private assertKnownSecrets(
        relative: string,
        document: ConfigDocument,
    ): void {
        // This is a small safety inventory, not a claim to recognize every plugin secret.
        // PaperMC's server.properties/global-configuration references define these fields.
        const normalized = relative.replaceAll("\\", "/").toLowerCase();
        const paths =
            normalized === "server.properties"
                ? [
                      ["rcon.password"],
                      ["management-server-secret"],
                      ["management-server-tls-keystore-password"],
                  ]
                : normalized === "config/paper-global.yml"
                  ? [["proxies", "velocity", "secret"]]
                  : [];
        for (const keys of paths) {
            let value: unknown = document.value;
            for (const key of keys)
                value = isConfigRecord(value) ? value[key] : undefined;
            if (value === undefined || value === null || value === "") continue;
            if (
                typeof value !== "string" ||
                this.withoutTokens(value).trim() !== ""
            )
                secretError("SECRET_PLAINTEXT");
        }
        if (
            normalized === "forwarding.secret" &&
            this.withoutTokens(document.text).trim() !== ""
        )
            secretError("SECRET_PLAINTEXT");
        if (
            /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/.test(
                this.withoutTokens(document.text),
            )
        )
            secretError("SECRET_PLAINTEXT");
    }

    private locations(document: ConfigDocument): {
        fields: Set<string>;
        tokens: Map<string, Set<string>>;
    } {
        const fields = new Set<string>();
        const tokens = new Map<string, Set<string>>();
        let scalarTokens = 0;
        const add = (value: string, pointer: string) => {
            fields.add(pointer);
            const names = this.names(value);
            scalarTokens += names.length;
            if (names.length > 0) tokens.set(pointer, new Set(names));
            return value;
        };
        if (document.format === "text") {
            for (const [index, line] of document.text
                .split(/\r\n|\r|\n/)
                .entries())
                add(line, `/lines/${index + 1}`);
        } else {
            function recordFields(
                value: unknown,
                parts: (string | number)[] = [],
            ): void {
                fields.add(configPointer(parts));
                if (Array.isArray(value))
                    value.forEach((item, index) => {
                        recordFields(item, [...parts, index]);
                    });
                else if (isConfigRecord(value))
                    for (const [key, item] of Object.entries(value))
                        recordFields(item, [...parts, key]);
            }
            recordFields(document.value);
            mapConfigStrings(document.value, (value, parts) =>
                add(value, configPointer(parts)),
            );
            if (
                [...document.text.matchAll(tokenPattern)].length !==
                scalarTokens
            )
                secretError("SECRET_TOKEN");
        }
        return { fields, tokens };
    }

    assertTemplate(relative: string, text: string): void {
        const document = parseConfigDocument(relative, text);
        this.assertKnownSecrets(relative, document);
        this.assertKeys(document.value);
        mapConfigStrings(document.value, (value) => {
            const publicText = this.withoutTokens(value);
            if (this.mask(publicText) !== publicText)
                secretError("SECRET_PLAINTEXT");
            this.names(value);
            return value;
        });
        const publicText = this.withoutTokens(text);
        if (this.mask(publicText) !== publicText)
            secretError("SECRET_PLAINTEXT");
        this.locations(document);
    }

    tokenize(
        relative: string,
        raw: string,
        templates?: readonly string[],
    ): string {
        const document = parseConfigDocument(relative, raw);
        this.assertKeys(document.value);
        const masked = document.render(
            mapConfigStrings(document.value, (value) => this.mask(value)),
        );
        const publicText = this.withoutTokens(masked);
        if (this.mask(publicText) !== publicText)
            secretError("SECRET_LOCATION");
        const tokenized = parseConfigDocument(relative, masked);
        this.assertKnownSecrets(relative, tokenized);
        const actual = this.locations(tokenized);
        if (templates !== undefined) {
            const expected = new Map<string, Set<string>>();
            for (const template of templates) {
                this.assertTemplate(relative, template);
                for (const [pointer, names] of this.locations(
                    parseConfigDocument(relative, template),
                ).tokens) {
                    expected.set(
                        pointer,
                        new Set([...(expected.get(pointer) ?? []), ...names]),
                    );
                }
            }
            for (const [pointer, names] of actual.tokens) {
                if (
                    [...names].some((name) => !expected.get(pointer)?.has(name))
                )
                    secretError("SECRET_LOCATION");
            }
            for (const [pointer, names] of expected) {
                if (
                    actual.fields.has(pointer) &&
                    [...names].some(
                        (name) => !actual.tokens.get(pointer)?.has(name),
                    )
                )
                    secretError("SECRET_LOCATION");
            }
        }
        return masked;
    }

    inject(relative: string, template: string): string {
        this.assertTemplate(relative, template);
        const document = parseConfigDocument(relative, template);
        return document.render(
            mapConfigStrings(document.value, (value) =>
                value.replace(
                    tokenPattern,
                    (_match, name: string) =>
                        this.values.get(name) ??
                        secretError("SECRET_UNAVAILABLE"),
                ),
            ),
        );
    }
}

export async function loadConfigSecrets(
    projectDir: string,
    references: Readonly<Record<string, SecretReference>> = {},
    environment: NodeJS.ProcessEnv = process.env,
): Promise<ConfigSecrets> {
    const values = new Map<string, string>();
    for (const [name, reference] of Object.entries(references)) {
        if (
            !reference ||
            (reference.env === undefined) === (reference.file === undefined) ||
            Object.keys(reference).some(
                (key) => key !== "env" && key !== "file",
            )
        )
            secretError("SECRET_REFERENCE");
        if (reference.env !== undefined) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.env))
                secretError("SECRET_REFERENCE");
            const value = environment[reference.env];
            if (value === undefined) secretError("SECRET_UNAVAILABLE");
            values.set(name, value);
        } else {
            try {
                if (!reference.file) secretError("SECRET_REFERENCE");
                const file = path.isAbsolute(reference.file)
                    ? reference.file
                    : containedPath(projectDir, reference.file);
                await assertNoSymlinks(path.dirname(file), path.basename(file));
                const stat = await lstat(file);
                if (!stat.isFile() || stat.size > 65_536)
                    secretError("SECRET_UNAVAILABLE");
                const raw = new TextDecoder("utf-8", { fatal: true }).decode(
                    await readFile(file),
                );
                values.set(name, raw.replace(/\r?\n$/, ""));
            } catch {
                secretError("SECRET_UNAVAILABLE");
            }
        }
    }
    return new ConfigSecrets(values);
}
