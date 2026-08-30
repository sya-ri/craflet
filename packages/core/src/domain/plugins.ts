import type { PluginIdentity, ServerKind } from "./artifacts.js";
import { CrafleetError } from "./errors.js";

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
        throw new CrafleetError(
            "JAR_PATH",
            "The plugin identity cannot be represented as a portable managed JAR filename.",
            3,
        );
    }
    return `${id}.jar`;
}

function pluginIdentifiers(
    plugins: readonly PluginIdentity[],
    serverKind: ServerKind,
    reservedIds: readonly string[] = [],
): Set<string> {
    const names = new Set<string>();
    const claim = (value: string) => {
        const name = value.toLowerCase();
        if (names.has(name))
            throw new CrafleetError(
                "DUPLICATE_PLUGIN",
                `Multiple plugins claim the identifier ${name}.`,
                3,
            );
        names.add(name);
    };
    for (const id of reservedIds) {
        portablePluginJarName(id);
        claim(id);
    }
    for (const plugin of plugins) {
        portablePluginJarName(plugin.id);
        const velocityPlugin = plugin.format === "velocity";
        if ((serverKind === "velocity") !== velocityPlugin) {
            throw new CrafleetError(
                "PLUGIN_PLATFORM",
                `Plugin ${plugin.id} is not a ${serverKind} plugin.`,
                3,
            );
        }
        for (const name of new Set(
            [plugin.id, ...(plugin.provides ?? [])].map((value) =>
                value.toLowerCase(),
            ),
        ))
            claim(name);
    }
    return names;
}

/** Validate properties that do not depend on the complete managed plugin set. */
export function validatePluginIdentities(
    plugins: readonly PluginIdentity[],
    serverKind: ServerKind,
    reservedIds: readonly string[] = [],
): void {
    pluginIdentifiers(plugins, serverKind, reservedIds);
}

/** Validate the shared identifier namespace and required dependencies. */
export function validatePluginSet(
    plugins: readonly PluginIdentity[],
    serverKind: ServerKind,
): void {
    const names = pluginIdentifiers(plugins, serverKind);
    const missing: string[] = [];
    for (const plugin of plugins) {
        for (const dependency of plugin.dependencies) {
            if (!names.has(dependency.toLowerCase()))
                missing.push(`${plugin.id} requires ${dependency}`);
        }
    }
    if (missing.length) {
        throw new CrafleetError(
            "MISSING_PLUGIN_DEPENDENCY",
            missing.join("; "),
            3,
            "Add the required plugins before applying this generation.",
        );
    }
}
