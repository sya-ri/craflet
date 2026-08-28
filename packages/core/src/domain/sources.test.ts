import { describe, expect, it } from "vitest";
import type { SourceInput } from "./artifacts.js";
import { formatSource, parseSource } from "./sources.js";

describe("parseSource", () => {
    it.each([
        [
            "modrinth:luckperms@release-id",
            {
                provider: "modrinth",
                project: "luckperms",
                version: "release-id",
            },
        ],
        [
            "modrinth:luckperms",
            { provider: "modrinth", project: "luckperms", version: "latest" },
        ],
        [
            "hangar:Owner/Plugin@2.0",
            { provider: "hangar", project: "Owner/Plugin", version: "2.0" },
        ],
        [
            "spigotmc:123@not-semver",
            { provider: "spigotmc", resource: "123", version: "not-semver" },
        ],
        [
            "github:user/repo@release/1.0#Plugin.jar",
            {
                provider: "github",
                owner: "user",
                repo: "repo",
                version: "release/1.0",
                asset: "Plugin.jar",
            },
        ],
        [
            "github:user/repo@v1%40test%23one#Plugin%23all.jar",
            {
                provider: "github",
                owner: "user",
                repo: "repo",
                version: "v1@test#one",
                asset: "Plugin#all.jar",
            },
        ],
        [
            "paper:1.21.4@200",
            {
                provider: "paper",
                project: "paper",
                version: "1.21.4",
                build: "200",
            },
        ],
        [
            "velocity:3.4.0",
            {
                provider: "paper",
                project: "velocity",
                version: "3.4.0",
                build: "latest",
            },
        ],
        [
            "file:../build/libs/*.jar",
            { provider: "file", path: "../build/libs/*.jar" },
        ],
        ["build/Plugin.JAR", { provider: "file", path: "build/Plugin.JAR" }],
        [
            "C:\\build\\Plugin.jar",
            { provider: "file", path: "C:\\build\\Plugin.jar" },
        ],
        [
            "\\\\host\\share\\Plugin.jar",
            { provider: "file", path: "\\\\host\\share\\Plugin.jar" },
        ],
    ])("parses %s", (value, expected) => {
        expect(parseSource(value as string)).toEqual(expected);
    });

    it("accepts structured opaque values without a homemade escape grammar", () => {
        const source = {
            provider: "github",
            owner: "user",
            repo: "repo",
            version: "tag/@#",
            asset: "Plugin.jar",
        } as const;
        expect(parseSource(source)).toEqual(source);
        expect(parseSource(source)).not.toBe(source);
    });

    it.each([
        "",
        "unknown",
        "https://example.com/p.jar",
        "file:",
        "modrinth:@v1",
        "modrinth:a@",
        "modrinth:a@b@c",
        "modrinth:%zz@v1",
        "modrinth:a@%00",
        "github:owner@tag#p.jar",
        "github:a/b/c@tag#p.jar",
        "github:a/b@tag",
        "github:a/b@tag#p#q.jar",
        "file:bad\n.jar",
    ])("rejects malformed reference %j", (input) => {
        expect(() => parseSource(input)).toThrowError(
            expect.objectContaining({ code: "INVALID_SOURCE" }),
        );
    });

    it.each([
        null,
        {},
        { provider: "file", path: "" },
        { provider: "file", path: "a\u0000.jar" },
        { provider: "paper", project: "spigot", version: "1", build: "2" },
    ])("rejects malformed structured source", (input) => {
        expect(() => parseSource(input as SourceInput)).toThrowError(
            expect.objectContaining({ code: "INVALID_SOURCE" }),
        );
    });

    it.each([
        "modrinth:p@v",
        "hangar:p@v",
        "spigotmc:123@456",
        "github:a/b@release/1#plugin.jar",
        "paper:1.21.4@200",
        "velocity:3.4.0@20",
        "file:../plugin #1.jar",
    ])("formats a normal source losslessly: %s", (input) => {
        expect(formatSource(parseSource(input))).toBe(input);
    });
    it("uses a structured form for ambiguous opaque values", () => {
        const source = {
            provider: "github",
            owner: "user",
            repo: "repo",
            version: "v1#test@one",
            asset: "plugin.jar",
        } as const;
        expect(formatSource(source)).toEqual(source);
        const repository = { ...source, version: "v1", owner: "with/slash" };
        expect(formatSource(repository)).toEqual(repository);
    });
});
