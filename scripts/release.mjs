import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
    chmod,
    copyFile,
    lstat,
    open,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MANIFEST_PATH = "packages/cli/package.json";
export const RECEIPT_PATH = "artifacts/release-receipt.json";
const RELEASE_LOCK_PATH = "artifacts/.release-publish.lock";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const RELEASE_REPOSITORY = "sya-ri/craflet";
const RELEASE_SIGNER = "3C7F5488B337C1D85A8620122162A8E62C120348";
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^[a-f\d]{64}$/u;
const HEAD_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/u;
const MAX_TARBALL_SIZE = 256 * 1024 * 1024;

function failure(message, cause) {
    return new Error(
        `Release verification failed: ${message}`,
        cause === undefined ? undefined : { cause },
    );
}

function fail(message, cause) {
    throw failure(message, cause);
}

async function git(directory, args) {
    try {
        const result = await execute("git", args, {
            cwd: directory,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        });
        return result.stdout.trim();
    } catch (error) {
        const detail = String(error.stderr ?? "").trim();
        fail(
            detail
                ? `Git ${args[0]} failed: ${detail}`
                : `Git ${args[0]} failed.`,
            error,
        );
    }
}

async function repositoryRoot(directory) {
    const root = await git(path.resolve(directory), [
        "rev-parse",
        "--show-toplevel",
    ]);
    return realpath(path.resolve(root));
}

async function assertClean(root) {
    const status = await git(root, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ]);
    if (status) fail("the Git worktree is not clean.");
}

async function headCommit(root) {
    const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
    if (!HEAD_PATTERN.test(head)) fail("HEAD is not a commit hash.");
    return head;
}

async function defaultReleasePreflight({ root, head }) {
    try {
        await execute(
            "git",
            ["-c", "gpg.minTrustLevel=undefined", "verify-commit", head],
            { cwd: root, windowsHide: true },
        );
    } catch (error) {
        fail("HEAD does not have a valid Git commit signature.", error);
    }
    const signer = await git(root, ["log", "-1", "--format=%GP", head]);
    if (signer.toUpperCase() !== RELEASE_SIGNER)
        fail("HEAD was not signed by the authorized release key.");

    await git(root, [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        "+master:refs/remotes/origin/master",
    ]);
    try {
        await execute(
            "git",
            ["merge-base", "--is-ancestor", head, "origin/master"],
            { cwd: root, windowsHide: true },
        );
    } catch (error) {
        fail("HEAD is not contained in freshly fetched origin/master.", error);
    }
}

async function runPreflight(root, head, preflight) {
    await (preflight ?? defaultReleasePreflight)({ root, head });
}

async function assertReceiptIgnored(root) {
    try {
        await execute("git", ["check-ignore", "--quiet", "--", RECEIPT_PATH], {
            cwd: root,
            windowsHide: true,
        });
    } catch (error) {
        fail(`${RECEIPT_PATH} is not ignored by Git.`, error);
    }
}

async function releaseDirectory(root) {
    const directory = path.join(root, "artifacts");
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
        fail("artifacts is not a regular directory.");
    return directory;
}

async function readManifest(root) {
    let manifest;
    try {
        manifest = JSON.parse(
            await readFile(path.join(root, MANIFEST_PATH), "utf8"),
        );
    } catch (error) {
        fail(`${MANIFEST_PATH} is not valid JSON.`, error);
    }
    if (manifest?.name !== "craflet")
        fail(`${MANIFEST_PATH} must describe the craflet package.`);
    if (
        typeof manifest.version !== "string" ||
        !VERSION_PATTERN.test(manifest.version)
    )
        fail(`${MANIFEST_PATH} has an unsupported release version.`);
    return manifest.version;
}

function releaseIdentity(root, version) {
    const relativeTarball = `artifacts/craflet-${version}.tgz`;
    return {
        tag: `v${version}`,
        relativeTarball,
        tarball: path.join(root, ...relativeTarball.split("/")),
    };
}

async function artifactDigest(file) {
    let info;
    try {
        info = await lstat(file);
    } catch (error) {
        fail("the release tarball is missing.", error);
    }
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size <= 0 ||
        info.size > MAX_TARBALL_SIZE
    )
        fail("the release tarball is not a bounded nonempty regular file.");
    const bytes = await readFile(file);
    if (bytes.length !== info.size)
        fail("the release tarball changed while it was read.");
    return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
    };
}

function validateReceipt(value) {
    if (
        !value ||
        typeof value !== "object" ||
        typeof value.head !== "string" ||
        !HEAD_PATTERN.test(value.head) ||
        typeof value.version !== "string" ||
        !VERSION_PATTERN.test(value.version) ||
        typeof value.sha256 !== "string" ||
        !SHA256_PATTERN.test(value.sha256) ||
        !Number.isSafeInteger(value.size) ||
        value.size <= 0
    )
        fail("the release receipt is invalid.");
    return {
        head: value.head,
        version: value.version,
        sha256: value.sha256,
        size: value.size,
    };
}

async function readReceipt(root) {
    try {
        return validateReceipt(
            JSON.parse(
                await readFile(
                    path.join(root, ...RECEIPT_PATH.split("/")),
                    "utf8",
                ),
            ),
        );
    } catch (error) {
        if (error.message?.startsWith("Release verification failed:"))
            throw error;
        if (error.code === "ENOENT")
            fail("the release receipt is missing; run prepare first.", error);
        fail("the release receipt is not valid JSON.", error);
    }
}

async function writeReceipt(root, receipt) {
    const directory = await releaseDirectory(root);
    const target = path.join(root, ...RECEIPT_PATH.split("/"));
    const temporary = path.join(directory, `.release-receipt.${randomUUID()}`);
    try {
        await writeFile(temporary, `${JSON.stringify(receipt, null, 4)}\n`, {
            flag: "wx",
            mode: 0o600,
        });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

function sameReceipt(first, second) {
    return (
        first.head === second.head &&
        first.version === second.version &&
        first.sha256 === second.sha256 &&
        first.size === second.size
    );
}

async function assertUnchanged(root, head) {
    await assertClean(root);
    if ((await headCommit(root)) !== head)
        fail("HEAD changed during release verification.");
}

async function tagCommit(root, tag) {
    try {
        const commit = await git(root, [
            "rev-parse",
            "--verify",
            `refs/tags/${tag}^{commit}`,
        ]);
        if (!HEAD_PATTERN.test(commit)) throw new Error("Invalid tag commit.");
        return commit;
    } catch (error) {
        fail(
            `the expected Git tag ${tag} does not exist or is invalid.`,
            error,
        );
    }
}

export async function prepareRelease(options = {}) {
    const root = await repositoryRoot(options.root ?? process.cwd());
    await assertReceiptIgnored(root);
    await assertClean(root);
    const head = await headCommit(root);
    await runPreflight(root, head, options.preflight);
    const version = await readManifest(root);
    const digest = await artifactDigest(releaseIdentity(root, version).tarball);
    const receipt = { head, version, ...digest };
    await writeReceipt(root, receipt);
    await assertUnchanged(root, head);
    return { root, receipt };
}

export async function checkRelease(options = {}) {
    const root = await repositoryRoot(options.root ?? process.cwd());
    await assertReceiptIgnored(root);
    await assertClean(root);
    const head = await headCommit(root);
    await runPreflight(root, head, options.preflight);
    const receipt = await readReceipt(root);
    const version = await readManifest(root);
    const identity = releaseIdentity(root, version);
    const current = {
        head,
        version,
        ...(await artifactDigest(identity.tarball)),
    };
    if (!sameReceipt(receipt, current))
        fail("HEAD, package version, or tarball does not match the receipt.");
    if ((await tagCommit(root, identity.tag)) !== head)
        fail(`the Git tag ${identity.tag} does not point to receipt HEAD.`);
    await assertUnchanged(root, head);
    return { root, receipt };
}

function publicationProvenance(receipt, environment) {
    if (environment.GITHUB_ACTIONS !== "true") return false;
    const tag = `v${receipt.version}`;
    if (
        environment.GITHUB_REPOSITORY !== RELEASE_REPOSITORY ||
        environment.GITHUB_EVENT_NAME !== "push" ||
        environment.GITHUB_REF !== `refs/tags/${tag}` ||
        environment.GITHUB_REF_TYPE !== "tag" ||
        environment.GITHUB_REF_NAME !== tag ||
        environment.GITHUB_SHA !== receipt.head
    )
        fail("the GitHub Actions release context is invalid.");
    return true;
}

export function npmPublishArguments(request) {
    return [
        "publish",
        request.tarball,
        "--registry",
        NPM_REGISTRY,
        "--dry-run=false",
        "--tag",
        "latest",
        "--access",
        "public",
        request.provenance ? "--provenance" : "--provenance=false",
    ];
}

async function npmCommand() {
    const executableDirectory = path.dirname(await realpath(process.execPath));
    for (const candidate of [
        path.join(executableDirectory, "node_modules/npm/bin/npm-cli.js"),
        path.resolve(
            executableDirectory,
            "../lib/node_modules/npm/bin/npm-cli.js",
        ),
    ]) {
        try {
            const resolved = await realpath(candidate);
            if ((await lstat(resolved)).isFile())
                return { executable: process.execPath, args: [resolved] };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    if (process.platform !== "win32") return { executable: "npm", args: [] };
    fail("npm could not be located beside the current Node runtime.");
}

async function defaultPublisher(request) {
    const command = await npmCommand();
    const args = [...command.args, ...npmPublishArguments(request)];
    await new Promise((resolve, reject) => {
        const child = spawn(command.executable, args, {
            cwd: request.root,
            stdio: "inherit",
            windowsHide: true,
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (code === 0) resolve();
            else
                reject(
                    new Error(
                        signal
                            ? `npm publish ended with signal ${signal}.`
                            : `npm publish exited with code ${code ?? "unknown"}.`,
                    ),
                );
        });
    });
}

async function acquirePublishLock(root) {
    await releaseDirectory(root);
    const lockPath = path.join(root, ...RELEASE_LOCK_PATH.split("/"));
    let handle;
    try {
        handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
        if (error.code === "EEXIST")
            fail("another release publication is already running.", error);
        throw error;
    }
    try {
        await handle.writeFile(`${process.pid}\n`);
        return { handle, path: lockPath };
    } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
    }
}

async function stageReleaseTarball(checked) {
    const identity = releaseIdentity(checked.root, checked.receipt.version);
    const staged = path.join(
        await releaseDirectory(checked.root),
        `.release-${checked.receipt.version}-${randomUUID()}.tgz`,
    );
    try {
        await copyFile(identity.tarball, staged, fsConstants.COPYFILE_EXCL);
        const digest = await artifactDigest(staged);
        if (
            digest.sha256 !== checked.receipt.sha256 ||
            digest.size !== checked.receipt.size
        )
            fail("the staged release tarball does not match the receipt.");
        await chmod(staged, 0o400);
        return staged;
    } catch (error) {
        try {
            await rm(staged, { force: true });
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                "Release staging failed and its temporary file could not be removed.",
            );
        }
        throw error;
    }
}

async function cleanupPublication(staged, lock, remove) {
    const errors = [];
    if (staged) {
        try {
            await remove(staged);
        } catch (error) {
            errors.push(error);
        }
    }
    try {
        await lock.handle.close();
    } catch (error) {
        errors.push(error);
    }
    try {
        await remove(lock.path);
    } catch (error) {
        errors.push(error);
    }
    return errors;
}

export async function publishRelease(options = {}) {
    const root = await repositoryRoot(options.root ?? process.cwd());
    const lock = await acquirePublishLock(root);
    const remove = options.remove ?? ((file) => rm(file, { force: true }));
    let checked;
    let staged;
    let operationError;
    let publisherStarted = false;
    let publisherCompleted = false;
    try {
        checked = await checkRelease({ root, preflight: options.preflight });
        const provenance = publicationProvenance(checked.receipt, process.env);
        staged = await stageReleaseTarball(checked);
        publisherStarted = true;
        await (options.publish ?? defaultPublisher)({
            root,
            tarball: staged,
            provenance,
        });
        publisherCompleted = true;
    } catch (error) {
        operationError = error;
    }

    const cleanupErrors = await cleanupPublication(staged, lock, remove);
    if (operationError) {
        if (publisherStarted)
            throw new AggregateError(
                [operationError, ...cleanupErrors],
                `npm publication did not complete cleanly. npm may have accepted craflet@${checked.receipt.version}; query the registry before retrying.`,
            );
        if (cleanupErrors.length > 0) {
            throw new AggregateError(
                [operationError, ...cleanupErrors],
                "Release publication failed and cleanup also failed.",
            );
        }
        throw operationError;
    }
    if (cleanupErrors.length > 0 && publisherCompleted)
        throw new AggregateError(
            cleanupErrors,
            `npm reported success, but release cleanup failed. npm may have accepted craflet@${checked.receipt.version}; query the registry before retrying.`,
        );
    return checked;
}

export function parseReleaseArguments(args) {
    const [mode, ...rest] = args;
    if (!["prepare", "check", "publish"].includes(mode) || rest.length !== 0)
        throw new Error(
            "Usage: node scripts/release.mjs <prepare|check|publish>",
        );
    return { mode };
}

async function main() {
    const { mode } = parseReleaseArguments(process.argv.slice(2));
    const result =
        mode === "prepare"
            ? await prepareRelease()
            : mode === "check"
              ? await checkRelease()
              : await publishRelease();
    const action =
        mode === "prepare"
            ? "Prepared"
            : mode === "check"
              ? "Verified"
              : "Published";
    const identity = releaseIdentity(result.root, result.receipt.version);
    process.stdout.write(
        `${action} ${identity.tag} from ${result.receipt.head} using ${identity.relativeTarball} (${result.receipt.sha256}).\n`,
    );
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href)
    main().catch((error) => {
        process.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
    });
