import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    checkRelease,
    npmPublishArguments,
    type PublishRequest,
    parseReleaseArguments,
    prepareRelease,
    publishRelease,
    type ReleasePreflight,
    type ReleaseReceipt,
} from "../../scripts/release.mjs";

const execute = promisify(execFile);
const temporaryPrefix = "crafleet-release-";
const roots: string[] = [];
const portablePreflight: ReleasePreflight = async () => {};

interface ReleaseFixture {
    root: string;
    manifest: string;
    tarball: string;
}

function releaseOptions(root: string) {
    return { root, preflight: portablePreflight };
}

async function git(root: string, args: string[]): Promise<string> {
    const result = await execute("git", args, {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
    });
    return result.stdout.trim();
}

async function commit(root: string, message: string): Promise<void> {
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "--quiet", "--no-gpg-sign", "-m", message]);
}

async function releaseFixture(version = "1.2.3"): Promise<ReleaseFixture> {
    const root = await realpath(
        await mkdtemp(path.join(await realpath(tmpdir()), temporaryPrefix)),
    );
    roots.push(root);
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.name", "Crafleet Release Test"]);
    await git(root, ["config", "user.email", "release-test@example.invalid"]);
    await git(root, ["config", "commit.gpgSign", "false"]);
    await git(root, ["config", "core.autocrlf", "false"]);

    const manifest = path.join(root, "packages/cli/package.json");
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(
        manifest,
        `${JSON.stringify({ name: "crafleet", version }, null, 4)}\n`,
    );
    await writeFile(path.join(root, ".gitignore"), "artifacts/\n");
    await commit(root, "Create release fixture");

    const tarball = path.join(root, `artifacts/crafleet-${version}.tgz`);
    await mkdir(path.dirname(tarball), { recursive: true });
    await writeFile(tarball, "verified package bytes\n");
    return { root, manifest, tarball };
}

async function tagRelease(root: string, tag = "v1.2.3"): Promise<void> {
    await git(root, ["tag", tag]);
}

async function artifactNames(root: string): Promise<string[]> {
    return (await readdir(path.join(root, "artifacts"))).sort();
}

function stubValidCi(receipt: ReleaseReceipt): void {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REPOSITORY", "sya-ri/crafleet");
    vi.stubEnv("GITHUB_EVENT_NAME", "push");
    vi.stubEnv("GITHUB_REF", `refs/tags/v${receipt.version}`);
    vi.stubEnv("GITHUB_REF_TYPE", "tag");
    vi.stubEnv("GITHUB_REF_NAME", `v${receipt.version}`);
    vi.stubEnv("GITHUB_SHA", receipt.head);
}

beforeEach(() => {
    vi.stubEnv("GITHUB_ACTIONS", "false");
});

afterEach(async () => {
    vi.unstubAllEnvs();
    const temporaryParent = await realpath(tmpdir());
    for (const root of roots.splice(0)) {
        if (
            path.dirname(root) !== temporaryParent ||
            !path.basename(root).startsWith(temporaryPrefix)
        )
            throw new Error("Unsafe release fixture cleanup.");
        await rm(root, { recursive: true, force: true });
    }
});

describe("release verification", () => {
    it.each(["1.2.3-beta.1", "1.2.3+build.1"])(
        "rejects non-stable package version %s",
        async (version) => {
            const fixture = await releaseFixture(version);
            await expect(
                prepareRelease(releaseOptions(fixture.root)),
            ).rejects.toThrow("unsupported release version");
        },
    );

    it("pins npm publication and accepts only the three release commands", () => {
        const request = {
            root: "/repository",
            tarball: "/repository/artifacts/release.tgz",
            provenance: false,
        };
        expect(npmPublishArguments(request)).toEqual([
            "publish",
            request.tarball,
            "--registry",
            "https://registry.npmjs.org/",
            "--dry-run=false",
            "--tag",
            "latest",
            "--access",
            "public",
            "--provenance=false",
        ]);
        expect(npmPublishArguments({ ...request, provenance: true })).toEqual([
            ...npmPublishArguments(request).slice(0, -1),
            "--provenance",
        ]);
        expect(parseReleaseArguments(["prepare"])).toEqual({ mode: "prepare" });
        expect(parseReleaseArguments(["publish"])).toEqual({ mode: "publish" });
        expect(() =>
            parseReleaseArguments(["publish", "--provenance"]),
        ).toThrow("Usage:");
    });

    it("requires the production signature verification by default", async () => {
        const fixture = await releaseFixture();
        await expect(prepareRelease({ root: fixture.root })).rejects.toThrow(
            "valid Git commit signature",
        );
        expect(await artifactNames(fixture.root)).toEqual([
            "crafleet-1.2.3.tgz",
        ]);
    });

    it("records and checks the exact clean release state", async () => {
        const fixture = await releaseFixture();
        const expectedHead = await git(fixture.root, ["rev-parse", "HEAD"]);
        const bytes = await readFile(fixture.tarball);
        const prepared = await prepareRelease(releaseOptions(fixture.root));
        expect(prepared.receipt).toEqual({
            head: expectedHead,
            version: "1.2.3",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.length,
        });
        expect(
            JSON.parse(
                await readFile(
                    path.join(fixture.root, "artifacts/release-receipt.json"),
                    "utf8",
                ),
            ),
        ).toEqual(prepared.receipt);

        await tagRelease(fixture.root);
        await expect(
            checkRelease(releaseOptions(fixture.root)),
        ).resolves.toEqual(prepared);
        expect(await git(fixture.root, ["status", "--porcelain=v1"])).toBe("");
    });

    it("rejects dirty, mismatched, and incorrectly tagged releases", async () => {
        const dirty = await releaseFixture();
        await prepareRelease(releaseOptions(dirty.root));
        await tagRelease(dirty.root);
        await writeFile(dirty.manifest, "dirty\n");
        await expect(checkRelease(releaseOptions(dirty.root))).rejects.toThrow(
            "worktree is not clean",
        );

        const changed = await releaseFixture();
        await prepareRelease(releaseOptions(changed.root));
        await tagRelease(changed.root);
        await writeFile(changed.tarball, "changed package bytes\n");
        await expect(
            checkRelease(releaseOptions(changed.root)),
        ).rejects.toThrow("does not match the receipt");

        const missingTag = await releaseFixture();
        await prepareRelease(releaseOptions(missingTag.root));
        await expect(
            checkRelease(releaseOptions(missingTag.root)),
        ).rejects.toThrow("does not exist or is invalid");

        const wrongTag = await releaseFixture();
        await tagRelease(wrongTag.root);
        await writeFile(path.join(wrongTag.root, "later.txt"), "later\n");
        await commit(wrongTag.root, "Advance release HEAD");
        await prepareRelease(releaseOptions(wrongTag.root));
        await expect(
            checkRelease(releaseOptions(wrongTag.root)),
        ).rejects.toThrow("does not point to receipt HEAD");
    });

    it("publishes an isolated staged copy with provenance disabled locally", async () => {
        const fixture = await releaseFixture();
        const prepared = await prepareRelease(releaseOptions(fixture.root));
        await tagRelease(fixture.root);
        const expected = await readFile(fixture.tarball);
        let request: PublishRequest | undefined;

        await publishRelease({
            ...releaseOptions(fixture.root),
            publish: async (value) => {
                request = value;
                await writeFile(fixture.tarball, "replacement bytes\n");
                expect(await readFile(value.tarball)).toEqual(expected);
            },
        });

        expect(request).toMatchObject({
            root: fixture.root,
            provenance: false,
        });
        expect(request?.tarball).not.toBe(fixture.tarball);
        expect(await artifactNames(fixture.root)).toEqual([
            "crafleet-1.2.3.tgz",
            "release-receipt.json",
        ]);
        expect(prepared.receipt.sha256).toBe(
            createHash("sha256").update(expected).digest("hex"),
        );
    });

    it("enables provenance only for the exact GitHub Actions tag context", async () => {
        const fixture = await releaseFixture();
        const prepared = await prepareRelease(releaseOptions(fixture.root));
        await tagRelease(fixture.root);
        stubValidCi(prepared.receipt);
        const publish = vi.fn(async (_request: PublishRequest) => {});
        await publishRelease({ ...releaseOptions(fixture.root), publish });
        expect(publish.mock.calls[0]?.[0]?.provenance).toBe(true);

        const invalidContexts = [
            ["GITHUB_REPOSITORY", "someone/crafleet"],
            ["GITHUB_EVENT_NAME", "workflow_dispatch"],
            ["GITHUB_REF", "refs/tags/v9.9.9"],
            ["GITHUB_REF_TYPE", "branch"],
            ["GITHUB_REF_NAME", "v9.9.9"],
            ["GITHUB_SHA", "0".repeat(40)],
        ] as const;
        for (const [name, value] of invalidContexts) {
            stubValidCi(prepared.receipt);
            vi.stubEnv(name, value);
            const rejectedPublisher = vi.fn(async () => {});
            await expect(
                publishRelease({
                    ...releaseOptions(fixture.root),
                    publish: rejectedPublisher,
                }),
            ).rejects.toThrow("GitHub Actions release context is invalid");
            expect(rejectedPublisher).not.toHaveBeenCalled();
        }
        expect(await artifactNames(fixture.root)).toEqual([
            "crafleet-1.2.3.tgz",
            "release-receipt.json",
        ]);
    });

    it("holds one cooperative lock through publication", async () => {
        const fixture = await releaseFixture();
        await prepareRelease(releaseOptions(fixture.root));
        await tagRelease(fixture.root);
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const first = publishRelease({
            ...releaseOptions(fixture.root),
            publish: async () => {
                entered.resolve();
                await finish.promise;
            },
        });
        await entered.promise;
        const secondPublisher = vi.fn(async () => {});
        try {
            await expect(
                publishRelease({
                    ...releaseOptions(fixture.root),
                    publish: secondPublisher,
                }),
            ).rejects.toThrow("another release publication is already running");
            expect(secondPublisher).not.toHaveBeenCalled();
        } finally {
            finish.resolve();
            await first;
        }
        expect(await artifactNames(fixture.root)).toEqual([
            "crafleet-1.2.3.tgz",
            "release-receipt.json",
        ]);
    });

    it("cleans staged and lock files after publisher failure", async () => {
        const fixture = await releaseFixture();
        await prepareRelease(releaseOptions(fixture.root));
        await tagRelease(fixture.root);
        await expect(
            publishRelease({
                ...releaseOptions(fixture.root),
                publish: async () => {
                    throw new Error("publisher failed");
                },
            }),
        ).rejects.toMatchObject({
            message: expect.stringContaining(
                "npm may have accepted crafleet@1.2.3",
            ),
            errors: [expect.objectContaining({ message: "publisher failed" })],
        });
        expect(await artifactNames(fixture.root)).toEqual([
            "crafleet-1.2.3.tgz",
            "release-receipt.json",
        ]);
    });

    it("warns against retrying when cleanup fails after npm reports success", async () => {
        const fixture = await releaseFixture();
        await prepareRelease(releaseOptions(fixture.root));
        await tagRelease(fixture.root);
        let staged = "";
        await expect(
            publishRelease({
                ...releaseOptions(fixture.root),
                publish: async (request) => {
                    staged = request.tarball;
                },
                remove: async (file) => {
                    await rm(file, { force: true });
                    if (file === staged) throw new Error("cleanup failed");
                },
            }),
        ).rejects.toThrow(
            "npm may have accepted crafleet@1.2.3; query the registry before retrying",
        );
        expect(await artifactNames(fixture.root)).toEqual([
            "crafleet-1.2.3.tgz",
            "release-receipt.json",
        ]);
    });
});
