import { crc32 } from "node:zlib";
import {
    CrafleetError,
    type PluginIdentity,
    type ServerKind,
} from "@crafleet/core";
import { type } from "arktype";
import { parseDocument } from "yaml";
import { type Entry, openPromise, type ZipFile } from "yauzl";

export interface JarInspectionOptions {
    serverKind?: ServerKind;
    maxEntries?: number;
    maxDescriptorBytes?: number;
}

const commonYamlSchema = type({
    name: "string > 0",
    version: "string > 0 | number",
    main: "string > 0",
    "api-version?": "string | number",
    "provides?": "string[]",
});
const bukkitSchema = commonYamlSchema.and({
    "depend?": "string[]",
    "softdepend?": "string[]",
});
const paperSchema = commonYamlSchema.and({
    "dependencies?": {
        "bootstrap?": {
            "[string]": {
                "required?": "boolean",
                "load?": "'BEFORE' | 'AFTER' | 'OMIT'",
                "join-classpath?": "boolean",
            },
        },
        "server?": {
            "[string]": {
                "required?": "boolean",
                "load?": "'BEFORE' | 'AFTER' | 'OMIT'",
                "join-classpath?": "boolean",
            },
        },
    },
});
const velocitySchema = type({
    id: "string > 0",
    main: "string > 0",
    "version?": "string",
    "dependencies?": type({ id: "string > 0", "optional?": "boolean" }).array(),
});

function metadata<T>(schema: { assert(value: unknown): T }, value: unknown): T {
    try {
        return schema.assert(value);
    } catch {
        throw new CrafleetError(
            "INVALID_PLUGIN_DESCRIPTOR",
            "The selected plugin descriptor has invalid or missing fields.",
            3,
        );
    }
}

function safeName(value: string): string {
    if (
        value.length > 128 ||
        /\p{Cc}/u.test(value) ||
        value.includes("/") ||
        value.includes("\\") ||
        !value.trim()
    ) {
        throw new CrafleetError(
            "INVALID_PLUGIN_DESCRIPTOR",
            "The plugin descriptor contains an invalid identifier.",
            3,
        );
    }
    return value;
}

function identity(
    id: string,
    version: string,
    format: PluginIdentity["format"],
    required: string[],
    optional: string[],
    apiVersion?: string,
    provides?: string[],
): PluginIdentity {
    const dependencies = [...new Set(required.map(safeName))];
    const optionalDependencies = [...new Set(optional.map(safeName))].filter(
        (name) => !dependencies.includes(name),
    );
    return {
        id: safeName(id),
        version,
        format,
        dependencies,
        optionalDependencies,
        ...(apiVersion ? { apiVersion } : {}),
        ...(provides?.length
            ? { provides: [...new Set(provides.map(safeName))] }
            : {}),
    };
}

async function readDescriptor(
    zip: ZipFile,
    entry: Entry,
    maximum: number,
): Promise<string> {
    if (
        entry.uncompressedSize > maximum ||
        entry.compressedSize > maximum ||
        entry.isEncrypted()
    ) {
        throw new CrafleetError(
            "JAR_DESCRIPTOR_LIMIT",
            "The plugin descriptor exceeds the size limit or is encrypted.",
            3,
        );
    }
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for await (const value of stream) {
            const chunk = Buffer.isBuffer(value)
                ? value
                : Buffer.from(value as Uint8Array);
            size += chunk.byteLength;
            if (size > maximum)
                throw new CrafleetError(
                    "JAR_DESCRIPTOR_LIMIT",
                    "The expanded plugin descriptor exceeds the size limit.",
                    3,
                );
            chunks.push(chunk);
        }
    } finally {
        stream.destroy();
    }
    const content = Buffer.concat(chunks);
    if (crc32(content) !== entry.crc32)
        throw new CrafleetError(
            "INVALID_JAR",
            "The plugin descriptor CRC does not match the ZIP directory.",
            3,
        );
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

/** Only root metadata entries are inflated. Other JAR contents are never extracted. */
export async function inspectOptionalPluginJar(
    file: string,
    options: JarInspectionOptions = {},
): Promise<PluginIdentity | undefined> {
    let zip: ZipFile | undefined;
    try {
        zip = await openPromise(file, {
            autoClose: false,
            lazyEntries: true,
            validateEntrySizes: true,
            strictFileNames: true,
        });
        const maximum = options.maxEntries ?? 100_000;
        if (zip.entryCount > maximum)
            throw new CrafleetError(
                "JAR_ENTRY_LIMIT",
                "The JAR contains too many ZIP entries.",
                3,
            );
        const descriptors = new Map<string, Entry>();
        const names = [
            "paper-plugin.yml",
            "plugin.yml",
            "velocity-plugin.json",
        ];
        let count = 0;
        for await (const entry of zip.eachEntry()) {
            if (++count > maximum)
                throw new CrafleetError(
                    "JAR_ENTRY_LIMIT",
                    "The JAR contains too many ZIP entries.",
                    3,
                );
            if (!names.includes(entry.fileName)) continue;
            if (descriptors.has(entry.fileName))
                throw new CrafleetError(
                    "DUPLICATE_PLUGIN_DESCRIPTOR",
                    "The JAR contains a duplicate plugin descriptor.",
                    3,
                );
            descriptors.set(entry.fileName, entry);
        }
        const priority =
            options.serverKind === "velocity"
                ? ["velocity-plugin.json", "paper-plugin.yml", "plugin.yml"]
                : names;
        const selectedName = priority.find((name) => descriptors.has(name));
        if (!selectedName) return undefined;
        const selected = descriptors.get(selectedName);
        if (!selected) return undefined;
        const content = await readDescriptor(
            zip,
            selected,
            options.maxDescriptorBytes ?? 256 * 1024,
        );
        if (selectedName === "velocity-plugin.json") {
            let parsed: unknown;
            try {
                parsed = JSON.parse(content);
            } catch {
                throw new CrafleetError(
                    "INVALID_PLUGIN_DESCRIPTOR",
                    "The Velocity plugin descriptor is not valid JSON.",
                    3,
                );
            }
            const data = metadata(velocitySchema, parsed);
            const dependencies = data.dependencies ?? [];
            return identity(
                data.id,
                data.version || "unspecified",
                "velocity",
                dependencies
                    .filter((item) => !item.optional)
                    .map((item) => item.id),
                dependencies
                    .filter((item) => item.optional)
                    .map((item) => item.id),
            );
        }
        const document = parseDocument(content, { uniqueKeys: true });
        if (document.errors.length || document.warnings.length)
            throw new CrafleetError(
                "INVALID_PLUGIN_DESCRIPTOR",
                "The plugin descriptor is not valid YAML.",
                3,
            );
        let parsed: unknown;
        try {
            parsed = document.toJS({ maxAliasCount: 0 });
        } catch {
            throw new CrafleetError(
                "INVALID_PLUGIN_DESCRIPTOR",
                "YAML aliases are not accepted in plugin descriptors.",
                3,
            );
        }
        if (selectedName === "paper-plugin.yml") {
            const data = metadata(paperSchema, parsed);
            const required: string[] = [];
            const optional: string[] = [];
            for (const phase of [
                data.dependencies?.bootstrap,
                data.dependencies?.server,
            ]) {
                for (const [name, dependency] of Object.entries(phase ?? {})) {
                    (dependency.required === false ? optional : required).push(
                        name,
                    );
                }
            }
            return identity(
                data.name,
                String(data.version),
                "paper",
                required,
                optional,
                data["api-version"] === undefined
                    ? undefined
                    : String(data["api-version"]),
                data.provides,
            );
        }
        const data = metadata(bukkitSchema, parsed);
        return identity(
            data.name,
            String(data.version),
            "bukkit",
            data.depend ?? [],
            data.softdepend ?? [],
            data["api-version"] === undefined
                ? undefined
                : String(data["api-version"]),
            data.provides,
        );
    } catch (error) {
        if (error instanceof CrafleetError) throw error;
        throw new CrafleetError(
            "INVALID_JAR",
            "The JAR or its selected plugin descriptor cannot be read safely.",
            3,
        );
    } finally {
        zip?.close();
    }
}

export async function inspectPluginJar(
    file: string,
    options: JarInspectionOptions = {},
): Promise<PluginIdentity> {
    const result = await inspectOptionalPluginJar(file, options);
    if (!result)
        throw new CrafleetError(
            "PLUGIN_DESCRIPTOR_MISSING",
            "The JAR has no supported root plugin descriptor.",
            3,
        );
    return result;
}
