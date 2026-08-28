import { describe, expect, it } from "vitest";
import {
    assertCompleteBackup,
    createBackupSelector,
    DEFAULT_BACKUP_PATTERNS,
    parseBackupRules,
    retentionArguments,
    validateBackupIdentifier,
    validateSnapshotId,
} from "./backup.js";

describe("ordered backup selection", () => {
    it("includes dotfiles and excludes all case variants of JAR by default", () => {
        const select = createBackupSelector(DEFAULT_BACKUP_PATTERNS);
        for (const file of [
            "world/level.dat",
            ".secret",
            "plugins/data/.cache",
            "data.jar.json",
        ])
            expect(select(file).included).toBe(true);
        for (const file of [
            "server.jar",
            "plugins/self.JAR",
            "plugins/Some.JaR",
        ])
            expect(select(file).included).toBe(false);
    });

    it("uses the last matching rule and permits reinclusion below an excluded directory", () => {
        const select = createBackupSelector([
            "**",
            "!plugins/cache",
            "plugins/cache/keep/**",
            "!plugins/cache/keep/private",
        ]);
        expect(select("plugins/cache/tmp.bin")).toEqual({
            included: false,
            matchedRule: 1,
        });
        expect(select("plugins/cache/keep/a.yml")).toEqual({
            included: true,
            matchedRule: 2,
        });
        expect(select("plugins/cache/keep/private/key")).toEqual({
            included: false,
            matchedRule: 3,
        });
    });

    it("supports globstars, character classes, question marks, and explicit reallowed JARs", () => {
        const select = createBackupSelector([
            "world/**/r.[0-9].?.mca",
            "plugins/*.jar",
        ]);
        expect(select("world/region/r.2.0.mca").included).toBe(true);
        expect(select("world/r.2.0.mca").included).toBe(true);
        expect(select("world/region/r.a.0.mca").included).toBe(false);
        expect(select("plugins/own.jar").included).toBe(true);
        expect(select(".env").included).toBe(false);
    });

    it("matches external paths only against supplied explicit absolute paths", () => {
        const select = createBackupSelector([
            "/srv/shared/**",
            "!**/*.[jJ][aA][rR]",
        ]);
        expect(
            select("../../shared/player.dat", "/srv/shared/player.dat")
                .included,
        ).toBe(true);
        expect(
            select("../../shared/plugin.jar", "/srv/shared/plugin.jar")
                .included,
        ).toBe(false);
        expect(select("world/level.dat").included).toBe(false);
        expect(
            createBackupSelector(["../external/**"])("../external/.hidden")
                .included,
        ).toBe(true);
    });

    it("normalizes separators without changing letter case", () => {
        const select = createBackupSelector(["./plugins\\data\\**"]);
        expect(select("plugins\\data\\file.yml").included).toBe(true);
        expect(select("Plugins/data/file.yml").included).toBe(false);
        expect(
            createBackupSelector(["world/"])("world/region/a").included,
        ).toBe(true);
        expect(createBackupSelector([])("file")).toEqual({
            included: false,
            matchedRule: -1,
        });
    });

    it("describes external prefixes without importing host filesystem semantics", () => {
        expect(
            parseBackupRules([
                "../shared/**",
                "/srv/data.db",
                "C:\\data\\**",
                "!**/*.jar",
            ]).map(({ external, absolute, staticPrefix, include }) => ({
                external,
                absolute,
                staticPrefix,
                include,
            })),
        ).toEqual([
            {
                external: true,
                absolute: false,
                staticPrefix: "../shared",
                include: true,
            },
            {
                external: true,
                absolute: true,
                staticPrefix: "/srv/data.db",
                include: true,
            },
            {
                external: true,
                absolute: true,
                staticPrefix: "C:/data",
                include: true,
            },
            {
                external: false,
                absolute: false,
                staticPrefix: "",
                include: false,
            },
        ]);
    });

    it.each([
        "",
        "!",
        "!!private/**",
        "a\0b",
        "a\nb",
        "{a,b}",
        "@(a)",
        "**/../secret",
        "x".repeat(4097),
    ])("rejects unsupported or ambiguous rule %j", (rule) => {
        expect(() => createBackupSelector([rule])).toThrow();
    });

    it("bounds the rule count", () => {
        expect(() =>
            parseBackupRules(Array.from({ length: 513 }, () => "**")),
        ).toThrow(/512/u);
    });
});

describe("backup operation guards", () => {
    it("does not report an incomplete or unknown restic exit as success", () => {
        expect(() => assertCompleteBackup(0)).not.toThrow();
        expect(() => assertCompleteBackup(3)).toThrow(/partial snapshot/u);
        expect(() => assertCompleteBackup(130)).toThrow(/130/u);
        expect(() => assertCompleteBackup(99)).toThrow(/99/u);
    });

    it("requires stable aliases and unambiguous explicit snapshot IDs", () => {
        expect(validateBackupIdentifier("local-nas_1.v2")).toBe(
            "local-nas_1.v2",
        );
        expect(validateSnapshotId("a".repeat(64))).toHaveLength(64);
        expect(validateSnapshotId("abcdef12")).toBe("abcdef12");
        for (const id of [
            "",
            "../outside",
            "-flag",
            "with space",
            "__proto__",
            "constructor",
            "Prototype",
            "a".repeat(65),
        ])
            expect(() => validateBackupIdentifier(id)).toThrow();
        for (const id of ["latest", "abc", "ABCDEF12", "-a", "a".repeat(65)])
            expect(() => validateSnapshotId(id)).toThrow();
    });

    it("constructs only positive, explicit retention rules", () => {
        expect(
            retentionArguments({
                keepLast: 5,
                keepDaily: 7,
                keepWeekly: 4,
                keepMonthly: 12,
                keepYearly: 2,
            }),
        ).toEqual([
            "--keep-last",
            "5",
            "--keep-daily",
            "7",
            "--keep-weekly",
            "4",
            "--keep-monthly",
            "12",
            "--keep-yearly",
            "2",
        ]);
        expect(retentionArguments({ keepLast: 1 })).toEqual([
            "--keep-last",
            "1",
        ]);
        for (const value of [
            0,
            -1,
            1.5,
            Number.NaN,
            Number.MAX_SAFE_INTEGER + 1,
        ])
            expect(() => retentionArguments({ keepDaily: value })).toThrow();
        expect(() => retentionArguments({})).toThrow(/at least one/u);
    });
});
