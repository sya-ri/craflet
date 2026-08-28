// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Secret tokens are deliberately literal fixture data, not JavaScript interpolation.
import { describe, expect, it } from "vitest";
import {
    ConfigBundleSchema,
    ConfigStateSchema,
    configEqual,
    configFormat,
    configPointer,
    isConfigRecord,
    mergeConfigText,
    mergeConfigValues,
    validateConfigBundle,
    validateConfigState,
} from "./config.js";

describe("configuration values", () => {
    it("rejects observation maps encoded as arrays through state and bundle entry points", () => {
        const state = { schemaVersion: 1, files: [] };
        expect(() => validateConfigState(state)).toThrow(
            "observation state is invalid",
        );
        expect(() =>
            validateConfigBundle({
                schemaVersion: 1,
                projectId: "fixture",
                stateFingerprint: "a".repeat(64),
                state,
                files: [],
            }),
        ).toThrow("Pending configuration is invalid");
        expect(ConfigStateSchema.toJsonSchema()).toMatchObject({
            properties: { files: { type: "object" } },
        });
        expect(ConfigBundleSchema.toJsonSchema()).toMatchObject({
            properties: {
                state: { properties: { files: { type: "object" } } },
            },
        });
    });
    it("merges independent edits, nested additions, and deletions without overwriting a pending base", () => {
        const observed = {
            network: { port: 25565, motd: "old" },
            removed: true,
        };
        const base = { network: { port: 25566, motd: "old" }, local: { x: 1 } };
        const runtime = {
            network: { port: 25565, motd: "new" },
            removed: true,
            remote: true,
        };
        expect(mergeConfigValues(observed, base, runtime)).toEqual({
            value: {
                network: { port: 25566, motd: "new" },
                local: { x: 1 },
                remote: true,
            },
            conflicts: [],
        });
    });

    it("merges independently created mappings but treats lists as atomic", () => {
        expect(
            mergeConfigValues({}, { added: { a: 1 } }, { added: { b: 2 } }),
        ).toEqual({ value: { added: { a: 1, b: 2 } }, conflicts: [] });
        expect(
            mergeConfigValues(
                { players: ["a"] },
                { players: ["a", "b"] },
                { players: ["a", "c"] },
            ).conflicts,
        ).toEqual(["/players"]);
    });

    it("reports value-free paths for conflicting values and delete/change conflicts", () => {
        const result = mergeConfigValues(
            { "a/b~": "old", other: true },
            { "a/b~": "private-value" },
            { "a/b~": "different-private", other: false },
        );
        expect(result.conflicts).toEqual(["/a~1b~0", "/other"]);
        expect(JSON.stringify(result.conflicts)).not.toContain("private");
        expect(mergeConfigValues({ a: 1 }, {}, {}).conflicts).toEqual([]);
        expect(
            mergeConfigValues({ a: null }, { a: null }, { a: "changed" }).value,
        ).toEqual({ a: "changed" });
    });

    it("does not mutate any input or use prototype keys for inherited data", () => {
        const base = JSON.parse(
            '{"__proto__":{"local":true},"constructor":"base"}',
        ) as unknown;
        const runtime = JSON.parse(
            '{"__proto__":{"remote":true},"constructor":"base"}',
        ) as unknown;
        const merged = mergeConfigValues({}, base, runtime);
        expect(merged.conflicts).toEqual([]);
        expect(Object.getPrototypeOf(merged.value)).toBeNull();
        expect({}).not.toHaveProperty("local");
        expect(base).toEqual(
            JSON.parse('{"__proto__":{"local":true},"constructor":"base"}'),
        );
    });

    it("compares scalar, date, list and mapping values deliberately", () => {
        expect(
            configEqual(new Date("2025-01-01"), new Date("2025-01-01")),
        ).toBe(true);
        expect(
            configEqual(new Date("2025-01-01"), new Date("2025-01-02")),
        ).toBe(false);
        expect(configEqual([1], [1, 2])).toBe(false);
        expect(configEqual({ x: 1 }, { y: 1 })).toBe(false);
        expect(configEqual({ x: 1 }, { x: 1, y: 2 })).toBe(false);
        expect(configEqual(1n, 1n)).toBe(true);
        expect(configEqual(Number.NaN, Number.NaN)).toBe(true);
        expect(isConfigRecord(Object.create(null))).toBe(true);
        expect(isConfigRecord(null)).toBe(false);
        expect(isConfigRecord([])).toBe(false);
        expect(configPointer([])).toBe("/");
    });
});

describe("configuration text", () => {
    it.each([
        [null, null, null, null],
        ["old", "same", "same", "same"],
        ["old", "old", "new", "new"],
        ["old", "new", "old", "new"],
        ["old", "old", null, null],
        ["old", null, "old", null],
        [null, "new", null, "new"],
    ])(
        "handles unchanged and unilateral changes",
        (observed, base, runtime, content) => {
            expect(mergeConfigText(observed, base, runtime)).toEqual({
                content,
                conflicts: [],
            });
        },
    );

    it("preserves CRLF and combines changes on separate lines", () => {
        expect(
            mergeConfigText(
                "one\r\ntwo\r\nthree\r\n",
                "ONE\r\ntwo\r\nthree\r\n",
                "one\r\ntwo\r\nTHREE\r\n",
            ),
        ).toEqual({ content: "ONE\r\ntwo\r\nTHREE\r\n", conflicts: [] });
        expect(mergeConfigText("a\nb\nc", "a\nc", "a\nb\nC")).toEqual({
            content: "a\nC",
            conflicts: [],
        });
    });

    it("coalesces identical edits and preserves independent insertions", () => {
        expect(mergeConfigText("a\nb\nc\n", "A\nb\nc\n", "A\nb\nC\n")).toEqual({
            content: "A\nb\nC\n",
            conflicts: [],
        });
        expect(
            mergeConfigText("a\nb\nc\n", "start\na\nb\nc\n", "a\nb\nc\nend\n"),
        ).toEqual({ content: "start\na\nb\nc\nend\n", conflicts: [] });
    });

    it("fails closed on overlapping changes, insertions, or deletion", () => {
        expect(mergeConfigText("old", null, "new").conflicts).toEqual(["/"]);
        expect(mergeConfigText(null, "base", "runtime").conflicts).toEqual([
            "/",
        ]);
        expect(
            mergeConfigText("a\nb\n", "a\nlocal\nb\n", "a\nremote\nb\n")
                .conflicts,
        ).toEqual(["/lines/2"]);
        expect(
            mergeConfigText("a\nb\nc\n", "a\nc\n", "a\nB\nc\n").conflicts,
        ).not.toEqual([]);
    });

    it("bounds merge work for large unfamiliar files", () => {
        const observed = "line\n".repeat(1001);
        expect(
            mergeConfigText(
                observed,
                `${observed}base\n`,
                `${observed}runtime\n`,
            ).conflicts,
        ).toEqual(["/"]);
    });
});

describe("configuration contracts", () => {
    it.each([
        ["a.yml", "yaml"],
        ["A.YAML", "yaml"],
        ["a.json", "json"],
        ["a.properties", "properties"],
        ["a.toml", "toml"],
        ["notes", "text"],
    ])("recognizes %s", (name, format) => {
        expect(configFormat(name)).toBe(format);
    });

    it("validates persisted state and bundles without rendering invalid input", () => {
        const state = {
            schemaVersion: 1 as const,
            files: { "a.yml": { observed: "password: ${secret:AUTH}\n" } },
        };
        expect(validateConfigState(state)).toEqual(state);
        const bundle = {
            schemaVersion: 1 as const,
            projectId: "project",
            stateFingerprint: "0".repeat(64),
            state,
            files: [
                {
                    relative: "a.yml",
                    format: "yaml" as const,
                    base: null,
                    observed: state.files["a.yml"].observed,
                    runtime: null,
                    content: null,
                },
            ],
        };
        expect(validateConfigBundle(bundle)).toEqual(bundle);
        expect(ConfigBundleSchema.toJsonSchema()).toHaveProperty("properties");
        expect(ConfigStateSchema.toJsonSchema()).toHaveProperty("properties");
        expect(() =>
            validateConfigState({ ...state, leaked: "do-not-print-this" }),
        ).toThrow("observation state is invalid");
        expect(() =>
            validateConfigBundle({
                ...bundle,
                files: [{ ...bundle.files[0], runtime: 123 }],
            }),
        ).toThrow("Pending configuration is invalid");
        try {
            validateConfigBundle({ plaintext: "do-not-print-this" });
        } catch (error) {
            expect(String(error)).not.toContain("do-not-print-this");
        }
    });
});
