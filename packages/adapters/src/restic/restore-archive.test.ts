import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    type BackupZipFixtureEntry,
    backupTestDirectory,
    backupZipFixture,
    cleanupBackupTestDirectories,
    writeBackupTestFile,
} from "../../../../tests/integration/backup-fixtures.js";
import { ensurePrivateDirectory } from "../filesystem/private.js";
import type { BackupArchiveFile } from "./metadata.js";
import { extractBackupArchive } from "./restore-archive.js";

afterEach(cleanupBackupTestDirectories);

function manifest(
    entries: BackupZipFixtureEntry[],
): Map<string, BackupArchiveFile> {
    return new Map(
        entries
            .filter((entry) => !entry.name.endsWith("/"))
            .map((entry) => [
                entry.name,
                {
                    size: entry.bytes.length,
                    sha256: createHash("sha256")
                        .update(entry.bytes)
                        .digest("hex"),
                },
            ]),
    );
}

async function fixture(entries: BackupZipFixtureEntry[]) {
    const root = await backupTestDirectory();
    const archive = await writeBackupTestFile(
        root,
        "snapshot.zip",
        backupZipFixture(entries),
    );
    const target = path.join(root, "restored");
    await ensurePrivateDirectory(target);
    return { root, archive, target };
}

describe("data-only restore ZIP extraction", () => {
    it("extracts binary, Unicode, empty and deflated files without applying archive permissions", async () => {
        const entries: BackupZipFixtureEntry[] = [
            { name: "data/", bytes: Buffer.alloc(0), mode: 0o40777 },
            {
                name: "data/日本語.dat",
                bytes: Buffer.from([0, 1, 2, 10, 13, 255]),
                compression: 8,
                mode: 0o100000,
            },
            { name: "data/empty", bytes: Buffer.alloc(0), mode: 0o100777 },
        ];
        const { archive, target } = await fixture(entries);
        await extractBackupArchive(archive, target, manifest(entries));
        expect(await readFile(path.join(target, "data/日本語.dat"))).toEqual(
            entries[1]?.bytes,
        );
        expect(await readFile(path.join(target, "data/empty"))).toEqual(
            Buffer.alloc(0),
        );
        if (process.platform !== "win32") {
            expect((await lstat(path.join(target, "data"))).mode & 0o777).toBe(
                0o700,
            );
            expect(
                (await lstat(path.join(target, "data/empty"))).mode & 0o777,
            ).toBe(0o600);
        }
    });

    it.each([
        {
            name: "parent traversal",
            entry: { name: "../escape", bytes: Buffer.from("x") },
        },
        {
            name: "absolute path",
            entry: { name: "/escape", bytes: Buffer.from("x") },
        },
        {
            name: "backslash path",
            entry: { name: "data\\escape", bytes: Buffer.from("x") },
        },
        {
            name: "undeclared file",
            entry: { name: "data/other", bytes: Buffer.from("x") },
        },
        {
            name: "symlink",
            entry: {
                name: "data/file",
                bytes: Buffer.from("x"),
                mode: 0o120777,
            },
        },
        {
            name: "fifo",
            entry: {
                name: "data/file",
                bytes: Buffer.from("x"),
                mode: 0o10700,
            },
        },
        {
            name: "encrypted entry",
            entry: { name: "data/file", bytes: Buffer.from("x"), flags: 0x801 },
        },
    ])("rejects $name before materializing bytes", async ({ entry }) => {
        const { archive, root, target } = await fixture([entry]);
        const expected = manifest([
            { name: "data/file", bytes: Buffer.from("x") },
        ]);
        await expect(
            extractBackupArchive(archive, target, expected),
        ).rejects.toThrow();
        expect(await readdir(target)).toEqual([]);
        expect(await readdir(root)).not.toContain("escape");
    });

    it("rejects duplicate entries, unknown directories and omitted files", async () => {
        const entry = { name: "data/file", bytes: Buffer.from("x") };
        const repeated = await fixture([entry, entry]);
        await expect(
            extractBackupArchive(
                repeated.archive,
                repeated.target,
                manifest([entry]),
            ),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
        const directory = await fixture([
            { name: "unknown/", bytes: Buffer.alloc(0) },
        ]);
        await expect(
            extractBackupArchive(
                directory.archive,
                directory.target,
                manifest([entry]),
            ),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
        const empty = await fixture([]);
        await expect(
            extractBackupArchive(
                empty.archive,
                empty.target,
                manifest([entry]),
            ),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
    });

    it("checks declared size, streaming expansion and cryptographic digest", async () => {
        const expected = manifest([
            { name: "data/file", bytes: Buffer.from("x") },
        ]);
        const huge = await fixture([
            {
                name: "data/file",
                bytes: Buffer.alloc(1024 * 1024),
                compression: 8,
            },
        ]);
        await expect(
            extractBackupArchive(huge.archive, huge.target, expected),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
        expect(await readdir(huge.target)).toEqual([]);
        const bomb = await fixture([
            {
                name: "data/file",
                bytes: Buffer.alloc(1024 * 1024),
                compression: 8,
                declaredSize: 1,
            },
        ]);
        await expect(
            extractBackupArchive(bomb.archive, bomb.target, expected),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
        expect(
            (await readFile(path.join(bomb.target, "data/file"))).length,
        ).toBeLessThanOrEqual(1);
        const corrupted = await fixture([
            { name: "data/file", bytes: Buffer.from("y") },
        ]);
        await expect(
            extractBackupArchive(corrupted.archive, corrupted.target, expected),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_VERIFY" });
    });

    it("never overwrites an existing file or follows a destination junction", async () => {
        const entries = [{ name: "data/file", bytes: Buffer.from("new") }];
        const existing = await fixture(entries);
        await writeBackupTestFile(
            existing.target,
            "data/file",
            "valuable bytes",
        );
        await expect(
            extractBackupArchive(
                existing.archive,
                existing.target,
                manifest(entries),
            ),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
        expect(
            await readFile(path.join(existing.target, "data/file"), "utf8"),
        ).toBe("valuable bytes");
        const linked = await fixture(entries);
        const outside = path.join(linked.root, "outside");
        await mkdir(outside);
        await symlink(
            outside,
            path.join(linked.target, "data"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await expect(
            extractBackupArchive(
                linked.archive,
                linked.target,
                manifest(entries),
            ),
        ).rejects.toMatchObject({ code: "SYMLINK_UNSAFE" });
        expect(await readdir(outside)).toEqual([]);
    });

    it("rejects malformed archives and cancellation", async () => {
        const { root, target } = await fixture([]);
        const archive = await writeBackupTestFile(
            root,
            "invalid.zip",
            "not zip",
        );
        await expect(
            extractBackupArchive(archive, target, new Map()),
        ).rejects.toMatchObject({ code: "BACKUP_RESTORE_ARCHIVE" });
        await expect(
            extractBackupArchive(
                archive,
                target,
                new Map(),
                AbortSignal.abort(),
            ),
        ).rejects.toThrow();
    });
});
