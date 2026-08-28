import { describe, expect, it } from "vitest";
import type { PluginIdentity } from "./artifacts.js";
import { portablePluginJarName, validatePluginSet } from "./plugins.js";

describe("portable plugin JAR filenames", () => {
    it.each(["Example", "server", "vault-2", "plugin_name", "a.b"])(
        "preserves identity %s exactly",
        (id) => {
            expect(portablePluginJarName(id)).toBe(`${id}.jar`);
        },
    );
    it.each([
        "",
        ".",
        "..",
        "trailing.",
        "../escape",
        "a/b",
        "a\\b",
        "a:stream",
        "con",
        "NUL.txt",
        "COM1",
        "lpt9",
        "foo ",
        "__proto__",
        "constructor",
        "prototype",
        "\0",
        "x".repeat(129),
    ])("rejects unsafe identity %j", (id) => {
        expect(() => portablePluginJarName(id)).toThrowError(
            expect.objectContaining({ code: "JAR_PATH" }),
        );
    });
});

function plugin(
    id: string,
    extra: Partial<PluginIdentity> = {},
): PluginIdentity {
    return {
        id,
        version: "1",
        format: "bukkit",
        dependencies: [],
        optionalDependencies: [],
        ...extra,
    };
}

describe("validatePluginSet", () => {
    it("resolves required aliases case-insensitively and ignores missing optional dependencies", () => {
        expect(() =>
            validatePluginSet(
                [
                    plugin("Consumer", {
                        dependencies: ["VAULT"],
                        optionalDependencies: ["Missing"],
                    }),
                    plugin("VaultReplacement", {
                        format: "paper",
                        provides: ["Vault", "vault"],
                    }),
                ],
                "paper",
            ),
        ).not.toThrow();
        expect(() => validatePluginSet([], "paper")).not.toThrow();
    });
    it.each([
        [plugin("One"), plugin("one")],
        [
            plugin("One", { provides: ["Alias"] }),
            plugin("Two", { provides: ["alias"] }),
        ],
        [plugin("One"), plugin("Two", { provides: ["ONE"] })],
    ])("rejects duplicate plugin identifiers", (...plugins) => {
        expect(() => validatePluginSet(plugins, "paper")).toThrowError(
            expect.objectContaining({ code: "DUPLICATE_PLUGIN" }),
        );
    });
    it("reports required dependencies with their consumers", () => {
        expect(() =>
            validatePluginSet(
                [plugin("A", { dependencies: ["B", "C"] })],
                "paper",
            ),
        ).toThrow("A requires B; A requires C");
    });
    it("rejects a plugin for the wrong server kind", () => {
        expect(() => validatePluginSet([plugin("A")], "velocity")).toThrowError(
            expect.objectContaining({ code: "PLUGIN_PLATFORM" }),
        );
        expect(() =>
            validatePluginSet([plugin("A", { format: "velocity" })], "paper"),
        ).toThrowError(expect.objectContaining({ code: "PLUGIN_PLATFORM" }));
        expect(() =>
            validatePluginSet(
                [plugin("A", { format: "velocity" })],
                "velocity",
            ),
        ).not.toThrow();
    });
});
