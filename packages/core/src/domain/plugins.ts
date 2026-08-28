import type { PluginIdentity, ServerKind } from "./artifacts.js";
import { CrafletError } from "./errors.js";

/** The loaded identity remains unchanged; reject filenames unsafe on any supported host. */
export function portablePluginJarName(id: string): string {
    if (
        !/^[A-Za-z0-9_.-]{1,128}$/.test(id) ||
        id === "." ||
        id === ".." ||
        id.endsWith(".") ||
        ["__proto__", "constructor", "prototype"].includes(id.toLowerCase()) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)
    ) {
        throw new CrafletError(
            "JAR_PATH",
            "The plugin identity cannot be represented as a portable managed JAR filename.",
            3,
        );
    }
    return `${id}.jar`;
}

/** Names and provides aliases share a namespace, including on case-insensitive hosts. */
export function validatePluginSet(
    plugins: readonly PluginIdentity[],
    serverKind: ServerKind,
): void {
    const names = new Map<string, PluginIdentity>();
    for (const plugin of plugins) {
        portablePluginJarName(plugin.id);
        if ((serverKind === "velocity") !== (plugin.format === "velocity")) {
            throw new CrafletError(
                "PLUGIN_PLATFORM",
                `Plugin ${plugin.id} is not a ${serverKind} plugin.`,
                3,
            );
        }
        for (const name of new Set(
            [plugin.id, ...(plugin.provides ?? [])].map((value) =>
                value.toLowerCase(),
            ),
        )) {
            if (names.has(name)) {
                throw new CrafletError(
                    "DUPLICATE_PLUGIN",
                    `Multiple plugins claim the identifier ${name}.`,
                    3,
                );
            }
            names.set(name, plugin);
        }
    }
    const missing: string[] = [];
    for (const plugin of plugins) {
        for (const dependency of plugin.dependencies) {
            if (!names.has(dependency.toLowerCase()))
                missing.push(`${plugin.id} requires ${dependency}`);
        }
    }
    if (missing.length) {
        throw new CrafletError(
            "MISSING_PLUGIN_DEPENDENCY",
            missing.join("; "),
            3,
            "Add the required plugins before applying this generation.",
        );
    }
}
