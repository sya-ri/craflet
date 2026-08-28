import { describe, expect, it } from "vitest";
import {
    assertStopped,
    mayRollback,
    shouldResumeBackup,
} from "./deployment.js";
import {
    diagnosticsFailed,
    javaRequirement,
    parseJavaVersion,
} from "./doctor.js";
import { CrafletError, invariant } from "./errors.js";
import {
    LockSchema,
    newProject,
    ProjectLockSchema,
    ProjectSchema,
    stableStringify,
    validateLock,
    validateProject,
    validateProjectLock,
} from "./project.js";

describe("project schema", () => {
    it.each(["plugins", "secrets", "java", "retention"])(
        "rejects an array used as the %s mapping while keeping JSON Schema object semantics",
        (field) => {
            const value = newProject("test", "paper", "26.2");
            const patched =
                field === "retention"
                    ? { ...value, backup: { files: [], retention: [] } }
                    : { ...value, [field]: [] };
            expect(() => validateProject(patched)).toThrow(CrafletError);
            expect(ProjectSchema.toJsonSchema()).toMatchObject({
                properties: {
                    plugins: { type: "object" },
                    secrets: { type: "object" },
                    java: { type: "object" },
                    backup: { properties: { retention: { type: "object" } } },
                },
            });
        },
    );
    it("rejects array resolutions and requests through both lock entry points", () => {
        const entry = {
            name: "test",
            requests: { server: "paper:paper@26.1#1", plugins: {} },
            server: {
                source: {
                    provider: "paper",
                    project: "paper",
                    version: "26.1",
                    build: "1",
                },
                version: "1",
                sha256: "a".repeat(64),
                size: 1,
            },
            plugins: {},
        };
        expect(validateProjectLock(entry)).toEqual(entry);
        expect(
            validateLock({ lockVersion: 1, projects: { ".": entry } }).projects[
                "."
            ],
        ).toEqual(entry);
        const empty = validateLock({ lockVersion: 1, projects: {} });
        expect(Object.getPrototypeOf(empty.projects)).toBeNull();
        expect(empty.projects.constructor).toBeUndefined();
        const unusual = Object.fromEntries([
            ["constructor", entry],
            ["__proto__", entry],
        ]);
        const unusualLock = validateLock({ lockVersion: 1, projects: unusual });
        expect(Object.keys(unusualLock.projects)).toEqual([
            "constructor",
            "__proto__",
        ]);
        expect(Reflect.get(unusualLock.projects, "__proto__")).toEqual(entry);
        for (const changed of [
            { ...entry, plugins: [] },
            { ...entry, requests: { ...entry.requests, plugins: [] } },
        ]) {
            expect(() => validateProjectLock(changed)).toThrow(CrafletError);
            expect(() =>
                validateLock({ lockVersion: 1, projects: { ".": changed } }),
            ).toThrow(CrafletError);
        }
        expect(() => validateLock({ lockVersion: 1, projects: [] })).toThrow(
            CrafletError,
        );
        expect(() => validateProjectLock({})).toThrow(CrafletError);
        expect(() => validateLock({})).toThrow(CrafletError);
        expect(LockSchema.toJsonSchema()).toMatchObject({
            properties: { projects: { type: "object" } },
        });
        expect(ProjectLockSchema.toJsonSchema()).toMatchObject({
            properties: {
                plugins: { type: "object" },
                requests: { properties: { plugins: { type: "object" } } },
            },
        });
        expect(
            validateProject({
                ...newProject("test", "paper", "26.2"),
                plugins: { length: "file:length.jar" },
            }).plugins.length,
        ).toBe("file:length.jar");
    });
    it("provides an editable backup policy and generates a JSON schema", () => {
        expect(newProject("survival", "paper", "26.2").backup?.files).toContain(
            "!**/*.[jJ][aA][rR]",
        );
        expect(ProjectSchema.toJsonSchema()).toHaveProperty("properties");
    });
    it.each([
        { name: "bad name" },
        { typo: true },
        { plugins: { Example: 1 } },
        { secrets: { TOKEN: { env: "TOKEN", file: "key" } } },
    ])("rejects invalid owned input without disclosing its value", (patch) => {
        expect(() =>
            validateProject({
                ...newProject("test", "paper", "26.2"),
                ...patch,
            }),
        ).toThrow(CrafletError);
    });
    it("does not include secret inputs in messages", () => {
        expect(() =>
            validateProject({ password: "do-not-leak-12345" }),
        ).not.toThrow(/do-not-leak/);
    });
    it("accepts structured sources and databases", () => {
        const value = newProject("test", "velocity", "4.1.1");
        value.plugins.example = {
            provider: "github",
            owner: "owner",
            repo: "repo",
            version: "v1",
            asset: "a.jar",
        };
        value.backup = {
            repository: "main",
            files: ["runtime/**"],
            databases: [
                {
                    id: "db",
                    kind: "sqlite",
                    path: "runtime/plugins/test/data.db",
                },
            ],
            retention: { keepLast: 3 },
        };
        expect(validateProject(value)).toEqual(value);
    });
    it("canonicalizes object keys but preserves arrays and primitive values", () => {
        expect(stableStringify({ b: [1, null, true], a: "x" })).toBe(
            '{"a":"x","b":[1,null,true]}',
        );
    });
});

describe("Java and health decisions", () => {
    it.each([
        ['java version "1.8.0_501"', 8],
        ['openjdk version "25.0.3"', 25],
        ["openjdk 21.0.2 2024-01-16", 21],
        ["bad output", undefined],
        ['java version "1"', undefined],
    ])("parses %s", (input, expected) =>
        expect(parseJavaVersion(input)).toBe(expected),
    );
    it.each([
        ["paper", "26.2", 25],
        ["paper", "1.21.11", undefined],
        ["paper", "1.20.6", undefined],
        ["velocity", "4.1.1", 25],
        ["velocity", "3.4.0", undefined],
        ["paper", "future", undefined],
        ["velocity", "future", undefined],
    ] as const)(
        "uses only documented minimums for %s %s",
        (kind, version, minimum) =>
            expect(javaRequirement(kind, version).minimum).toBe(minimum),
    );
    it("does not mark unknown required checks as successful", () => {
        expect(
            diagnosticsFailed([
                {
                    id: "java",
                    status: "unknown",
                    message: "unknown",
                    required: true,
                },
            ]),
        ).toBe(true);
        expect(
            diagnosticsFailed([
                { id: "plugin", status: "unknown", message: "unknown" },
                { id: "backup", status: "skip", message: "unused" },
            ]),
        ).toBe(false);
        expect(
            diagnosticsFailed([
                { id: "config", status: "fail", message: "bad" },
            ]),
        ).toBe(true);
    });
});

describe("safety decisions", () => {
    it.each(["starting", "running", "stopping", "unknown"] as const)(
        "rejects %s for file replacement",
        (status) => expect(() => assertStopped(status)).toThrow(CrafletError),
    );
    it("allows confirmed stopped state and no automatic post-spawn rollback", () => {
        expect(() => assertStopped("stopped")).not.toThrow();
        expect(mayRollback("spawned")).toBe(false);
        expect(mayRollback("applying")).toBe(true);
        expect(shouldResumeBackup(true, true, false)).toBe(true);
        expect(shouldResumeBackup(false, true, false)).toBe(false);
        expect(shouldResumeBackup(true, false, false)).toBe(false);
        expect(shouldResumeBackup(true, true, true)).toBe(false);
        expect(() => invariant(true, "test", "test")).not.toThrow();
        expect(() => invariant(false, "test", "test", 2)).toThrow(CrafletError);
    });
});
