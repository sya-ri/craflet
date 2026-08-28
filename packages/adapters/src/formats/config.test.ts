import { describe, expect, it } from "vitest";
import {
    mapConfigStrings,
    mergeConfigDocuments,
    parseConfigDocument,
} from "./config.js";

describe("configuration formats", () => {
    it("preserves YAML bytes on no-op and comments when merging values", () => {
        const original =
            "# Operator note\r\nnetwork:\r\n  port: 25565 # internal\r\n  motd: old\r\n";
        const doc = parseConfigDocument("a.yml", original);
        expect(doc.render(doc.value)).toBe(original);
        const result = mergeConfigDocuments(
            "a.yml",
            original,
            original.replace("25565", "25566"),
            "network:\n  port: 25565\n  motd: new\n",
        );
        expect(result.conflicts).toEqual([]);
        expect(result.content).toContain("# Operator note\r\n");
        expect(result.content).toContain("25566 # internal");
        expect(
            parseConfigDocument("a.yml", result.content ?? "").value,
        ).toEqual({ network: { port: 25566n, motd: "new" } });
    });

    it("keeps authored comments when only runtime formatting changed", () => {
        const text = "# Keep this\nvalue: 1\n";
        expect(mergeConfigDocuments("a.yml", text, text, "value: 1\n")).toEqual(
            { content: text, conflicts: [] },
        );
    });

    it("edits YAML mappings, scalar roots, arrays and removals", () => {
        const doc = parseConfigDocument("a.yaml", "# top\na: 1\nb: 2\n");
        expect(
            parseConfigDocument(
                "a.yml",
                doc.render({ a: ["x"], c: { nested: true } }),
            ).value,
        ).toEqual({ a: ["x"], c: { nested: true } });
        expect(
            parseConfigDocument("a.yml", "null\n").render({ nested: true }),
        ).toContain("nested: true");
        expect(
            parseConfigDocument("a.yml", "key: old # note\n").render({
                key: "new",
            }),
        ).toContain("new # note");
    });

    it("preserves JSON indentation and parses only unambiguous JSON", () => {
        const text = '{\r\n\t"a": 1\r\n}\r\n';
        const doc = parseConfigDocument("a.json", text);
        expect(doc.render(doc.value)).toBe(text);
        expect(doc.render({ a: 2 })).toBe('{\r\n\t"a": 2\r\n}\r\n');
        expect(
            parseConfigDocument("a.json", '{"a":1}').render({ a: 2 }),
        ).not.toMatch(/\n$/);
        expect(() => parseConfigDocument("a.json", '{"a":1,"a":2}')).toThrow();
        expect(() => parseConfigDocument("a.json", "9007199254740993")).toThrow(
            "cannot be safely merged",
        );
    });

    it("merges TOML with large integers, floats, dates and independent fields", () => {
        const observed =
            '# Keep on no-op\nport = 25565\nratio = 1.0\nid = 9223372036854775807\ndate = 2025-01-01\nmotd = "old"\n';
        const document = parseConfigDocument("velocity.toml", observed);
        expect(document.render(document.value)).toBe(observed);
        const result = mergeConfigDocuments(
            "velocity.toml",
            observed,
            observed.replace("25565", "25566"),
            observed.replace('"old"', '"new"'),
        );
        expect(result.conflicts).toEqual([]);
        expect(result.content).toContain("9223372036854775807");
        expect(result.content).toContain("ratio = 1.0");
        expect(
            parseConfigDocument("a.toml", result.content ?? "").value,
        ).toMatchObject({ port: 25566n, motd: "new" });
        expect(
            parseConfigDocument("a.toml", "x = 1\r\n").render({ x: 2n }),
        ).toContain("\r\n");
    });

    it("reads Java properties escapes and continuations and retains untouched comments", () => {
        const text =
            "# managed note\r\na\\ key : value\\\r\n  continued\r\nunicode=\\u65e5\\u672c\r\nempty\r\n";
        const doc = parseConfigDocument("server.properties", text);
        expect(doc.value).toEqual({
            "a key": "valuecontinued",
            unicode: "日本",
            empty: "",
        });
        expect(doc.render(doc.value)).toBe(text);
        const next = {
            "a key": "changed",
            unicode: "日本",
            new: " \n\r\t\f\\日本",
        };
        const rendered = doc.render(next);
        expect(rendered).toContain("# managed note\r\n");
        expect(rendered).toContain("unicode=\\u65e5\\u672c\r\n");
        expect(
            parseConfigDocument("server.properties", rendered).value,
        ).toEqual(next);
        expect(
            parseConfigDocument("a.properties", "value=tail\\").value,
        ).toEqual({ value: "tail" });
        expect(
            parseConfigDocument("a.properties", "a=1").render({
                a: "1",
                b: "2",
            }),
        ).toBe("a=1\nb=2\n");
    });

    it("handles property key separators without treating escaped separators as delimiters", () => {
        const next = { "a=b:c #!": "x", other: "line\nnext" };
        const rendered = parseConfigDocument(
            "a.properties",
            "! comment\n",
        ).render(next);
        expect(parseConfigDocument("a.properties", rendered).value).toEqual(
            next,
        );
        expect(() =>
            parseConfigDocument("a.properties", "a=1\na=2\n"),
        ).toThrow();
        expect(() =>
            parseConfigDocument("a.properties", "a=\\uXXXX\n"),
        ).toThrow();
        expect(() =>
            parseConfigDocument("a.properties", "a=1\n").render({ a: true }),
        ).toThrow();
    });

    it("provides line merging for unknown text and keeps lists atomic", () => {
        expect(
            mergeConfigDocuments("a.txt", "a\nb\n", "A\nb\n", "a\nB\n"),
        ).toEqual({ content: "A\nB\n", conflicts: [] });
        expect(
            mergeConfigDocuments("ops.json", '["a"]', '["a","b"]', '["a","c"]')
                .conflicts,
        ).toEqual(["/"]);
        expect(
            mergeConfigDocuments("a.yml", "a: 1\n", null, "a: 2\n").conflicts,
        ).toEqual(["/"]);
        expect(() => parseConfigDocument("a.txt", "text").render({})).toThrow();
    });

    it("does not include parser input in errors", () => {
        for (const [file, content] of [
            ["a.json", '{"secret":"never-print-credential"'],
            ["a.yml", "x: [never-print-credential"],
            ["a.toml", 'password="never-print-credential'],
            ["a.yml", "x: !unknown never-print-credential\n"],
        ]) {
            try {
                parseConfigDocument(file ?? "", content ?? "");
                throw new Error("expected failure");
            } catch (error) {
                expect(String(error)).not.toContain("never-print-credential");
            }
        }
    });

    it("refuses unsafe binary, deep data, complex keys and cyclic YAML", () => {
        expect(() => parseConfigDocument("a.txt", "bad\0data")).toThrow();
        expect(() =>
            parseConfigDocument("a.txt", "x".repeat(4 * 1024 * 1024 + 1)),
        ).toThrow();
        expect(() =>
            parseConfigDocument(
                "a.json",
                `${"[".repeat(102)}0${"]".repeat(102)}`,
            ),
        ).toThrow();
        expect(() =>
            parseConfigDocument("a.yml", "? [a, b]\n: value\n"),
        ).toThrow();
        expect(() =>
            parseConfigDocument("a.yml", "x: &x {self: *x}\n"),
        ).toThrow();
        const aliases = parseConfigDocument("a.yml", "x: &x 1\ny: *x\n");
        expect(aliases.render(aliases.value)).toBe(aliases.text);
        expect(() => aliases.render({ x: 2n, y: 1n })).toThrow();
    });

    it("maps string values without converting dates, numbers or null", () => {
        const date = new Date("2025-01-01");
        expect(
            mapConfigStrings(
                { list: ["hello", 1, null, date] },
                (value, path) => `${path.join(".")}:${value}`,
            ),
        ).toEqual({ list: ["list.0:hello", 1, null, date] });
    });
});
