import path from "node:path";
import type { BackupMetadata } from "@craflet/core";
import { describe, expect, it } from "vitest";
import {
    backupArchiveDirectories,
    backupArchiveFiles,
    backupJson,
    backupPathKey,
    validateBackupMetadata,
    validateBackupRelativePath,
} from "./metadata.js";

function metadata(): BackupMetadata {
    return {
        format: 1,
        projectId: "fixture",
        createdAt: "2026-08-29T00:00:00.000Z",
        active: { generation: "fixed" },
        roots: [
            {
                id: "runtime",
                path: path.resolve("fixture/runtime"),
                external: false,
                kind: "directory",
            },
        ],
        files: [
            {
                destination: "data/runtime/world/level.dat",
                size: 0,
                sha256: "a".repeat(64),
                mode: 0o600,
            },
        ],
        databases: [],
    };
}

describe("portable backup metadata validation", () => {
    it("provides exact payload sizes and metadata digests for archive extraction", () => {
        const value = metadata();
        value.databases.push({
            id: "players",
            kind: "sqlite",
            file: "databases/players.sqlite3",
            bytes: 1,
            sha256: "b".repeat(64),
        });
        expect(validateBackupMetadata(value, "fixture")).toBe(value);
        const files = backupArchiveFiles(value);
        expect(files.get("metadata/backup.json")?.size).toBe(
            backupJson(value).length,
        );
        expect(files.get("metadata/active.json")?.sha256).toMatch(
            /^[a-f0-9]{64}$/u,
        );
        expect(backupArchiveDirectories(files)).toEqual(
            new Set([
                "data",
                "data/runtime",
                "data/runtime/world",
                "databases",
                "metadata",
            ]),
        );
        expect(backupPathKey("DaTa/Café")).toBe(
            backupPathKey("data/Cafe\u0301"),
        );
    });

    it.each([
        { roots: [] },
        {
            roots: [
                {
                    id: "runtime",
                    path: "relative",
                    external: false,
                    kind: "directory",
                },
            ],
        },
        {
            roots: [
                {
                    id: "other",
                    path: "/absolute",
                    external: false,
                    kind: "directory",
                },
            ],
        },
        {
            roots: [
                {
                    id: "runtime",
                    path: "/absolute",
                    external: true,
                    kind: "directory",
                },
            ],
        },
        { createdAt: "invalid date" },
        { active: [] },
        {
            files: [
                {
                    destination: "data/runtime/file",
                    size: -1,
                    sha256: "a".repeat(64),
                    mode: 0o600,
                },
            ],
        },
        {
            files: [
                {
                    destination: "data/runtime/file",
                    size: 0,
                    sha256: "bad",
                    mode: 0o600,
                },
            ],
        },
        {
            files: [
                {
                    destination: "data/external/undeclared/file",
                    size: 0,
                    sha256: "a".repeat(64),
                    mode: 0o600,
                },
            ],
        },
        {
            files: [
                {
                    destination: "metadata/active.json",
                    size: 0,
                    sha256: "a".repeat(64),
                    mode: 0o600,
                },
            ],
        },
        {
            databases: [
                {
                    id: "db",
                    kind: "sqlite",
                    file: "databases/other.sqlite3",
                    bytes: 1,
                    sha256: "a".repeat(64),
                },
            ],
        },
        {
            databases: [
                {
                    id: "db",
                    kind: "mysql",
                    file: "databases/db.sqlite3",
                    bytes: 1,
                    sha256: "a".repeat(64),
                },
            ],
        },
    ])(
        "rejects malformed mappings or payload declarations: %j",
        (overrides) => {
            expect(() =>
                validateBackupMetadata(
                    { ...metadata(), ...overrides },
                    "fixture",
                ),
            ).toThrow();
        },
    );

    it("rejects portable case collisions, duplicate roots/databases and file-parent collisions", () => {
        const value = metadata();
        const file = value.files[0];
        if (!file) throw new Error("Fixture file missing");
        expect(() =>
            validateBackupMetadata(
                {
                    ...value,
                    files: [
                        file,
                        {
                            ...file,
                            destination: file.destination.toUpperCase(),
                        },
                    ],
                },
                "fixture",
            ),
        ).toThrow();
        expect(() =>
            validateBackupMetadata(
                {
                    ...value,
                    files: [
                        file,
                        { ...file, destination: "data/runtime/world" },
                    ],
                },
                "fixture",
            ),
        ).toThrow(/collision/u);
        expect(() =>
            validateBackupMetadata(
                { ...value, roots: [...value.roots, ...value.roots] },
                "fixture",
            ),
        ).toThrow(/root ID/u);
        const db = {
            id: "db",
            kind: "mysql",
            file: "databases/db.sql",
            bytes: 1,
            sha256: "a".repeat(64),
        };
        expect(() =>
            validateBackupMetadata(
                {
                    ...value,
                    databases: [
                        db,
                        { ...db, id: "DB", file: "databases/DB.sql" },
                    ],
                },
                "fixture",
            ),
        ).toThrow(/duplicate database/u);
        expect(() =>
            validateBackupMetadata(
                { ...value, active: { text: "界".repeat(2 * 1024 * 1024) } },
                "fixture",
            ),
        ).toThrow(/limits/u);
    });

    it("checks path bounds and destination-platform filename constraints", () => {
        for (const name of [
            "../escape",
            "a/../escape",
            "/absolute",
            "a\\b",
            "a//b",
            "a\0b",
            "x".repeat(4097),
        ])
            expect(() => validateBackupRelativePath(name)).toThrow();
        if (process.platform === "win32") {
            for (const name of [
                "data/runtime/CON",
                "data/runtime/name.",
                "data/runtime/name:stream",
                "data/runtime/name?",
            ])
                expect(() => validateBackupRelativePath(name)).toThrow();
        }
    });
});
