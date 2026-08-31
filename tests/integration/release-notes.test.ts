import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    loadReleaseNotes,
    parseReleaseNotesArguments,
} from "../../scripts/release-notes.mjs";

const temporaryPrefix = "crafleet-release-notes-";
const roots: string[] = [];

interface FixtureOptions {
    changelog?: string;
    notes?: string;
    version?: string;
}

async function releaseNotesFixture(options: FixtureOptions = {}) {
    const version = options.version ?? "1.2.3";
    const tag = `v${version}`;
    const root = await realpath(
        await mkdtemp(path.join(await realpath(tmpdir()), temporaryPrefix)),
    );
    roots.push(root);
    await mkdir(path.join(root, "packages/cli"), { recursive: true });
    await mkdir(path.join(root, "docs/releases"), { recursive: true });
    await writeFile(
        path.join(root, "packages/cli/package.json"),
        `${JSON.stringify({ name: "crafleet", version })}\n`,
    );
    await writeFile(
        path.join(root, "CHANGELOG.md"),
        options.changelog ??
            `# Changelog\n\n## ${version} - 2026-08-30\n\n### Added\n\n- Added a release.\n`,
    );
    await writeFile(
        path.join(root, `docs/releases/${tag}.md`),
        options.notes ??
            `# Crafleet ${version}\n\nCrafleet ${version} release details.\n`,
    );
    return { root, version, tag };
}

afterEach(async () => {
    const temporaryParent = await realpath(tmpdir());
    for (const root of roots.splice(0)) {
        if (
            path.dirname(root) !== temporaryParent ||
            !path.basename(root).startsWith(temporaryPrefix)
        )
            throw new Error("Unsafe release-notes fixture cleanup.");
        await rm(root, { recursive: true, force: true });
    }
});

describe("release notes", () => {
    it("loads curated notes for the package version", async () => {
        const fixture = await releaseNotesFixture({
            changelog:
                "# Changelog\r\n\r\n## Unreleased\r\n\r\nNothing yet.\r\n\r\n## 1.2.3 - 2026-08-30\r\n\r\n### Added\r\n\r\n- Added a release.\r\n",
            notes: "# Crafleet 1.2.3\r\n\r\nRelease details.\r\n",
        });
        await expect(loadReleaseNotes({ root: fixture.root })).resolves.toEqual(
            {
                version: fixture.version,
                tag: fixture.tag,
                relativePath: `docs/releases/${fixture.tag}.md`,
                notes: "# Crafleet 1.2.3\n\nRelease details.\n",
            },
        );
    });

    it("rejects a tag that differs from the package version", async () => {
        const fixture = await releaseNotesFixture();
        await expect(
            loadReleaseNotes({ root: fixture.root, tag: "v1.2.4" }),
        ).rejects.toThrow("does not match package version 1.2.3");
    });

    it.each([
        ["missing", "# Changelog\n\n## 1.2.4 - 2026-08-30\n\nChanged.\n"],
        [
            "duplicate",
            "# Changelog\n\n## 1.2.3 - 2026-08-30\n\nFirst.\n\n## 1.2.3 - 2026-08-31\n\nSecond.\n",
        ],
        ["malformed", "# Changelog\n\n## 1.2.3 - 2026-02-30\n\nChanged.\n"],
        ["empty", "# Changelog\n\n## 1.2.3 - 2026-08-30\n"],
    ])("rejects a %s changelog section", async (_name, changelog) => {
        const fixture = await releaseNotesFixture({ changelog });
        await expect(loadReleaseNotes({ root: fixture.root })).rejects.toThrow(
            "CHANGELOG.md",
        );
    });

    it("rejects release notes with the wrong title", async () => {
        const fixture = await releaseNotesFixture({
            notes: "# Version 1.2.3\n\nRelease details.\n",
        });
        await expect(loadReleaseNotes({ root: fixture.root })).rejects.toThrow(
            "# Crafleet 1.2.3",
        );
    });

    it("parses check mode and an optional exact tag", () => {
        expect(parseReleaseNotesArguments([])).toEqual({ check: false });
        expect(parseReleaseNotesArguments(["--check", "v1.2.3"])).toEqual({
            check: true,
            tag: "v1.2.3",
        });
        expect(() =>
            parseReleaseNotesArguments(["--check", "--check"]),
        ).toThrow("Usage:");
        expect(() => parseReleaseNotesArguments(["1.2.3"])).toThrow("Usage:");
    });
});
