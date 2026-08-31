import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = "packages/cli/package.json";
const CHANGELOG_PATH = "CHANGELOG.md";
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function failure(message, cause) {
    return new Error(
        `Release notes validation failed: ${message}`,
        cause === undefined ? undefined : { cause },
    );
}

function fail(message, cause) {
    throw failure(message, cause);
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
    if (
        manifest?.name !== "crafleet" ||
        typeof manifest.version !== "string" ||
        !VERSION_PATTERN.test(manifest.version)
    )
        fail(`${MANIFEST_PATH} must describe a stable crafleet release.`);
    return manifest.version;
}

async function readText(root, relativePath) {
    try {
        return await readFile(
            path.join(root, ...relativePath.split("/")),
            "utf8",
        );
    } catch (error) {
        fail(`${relativePath} could not be read.`, error);
    }
}

function normalizeText(text, relativePath) {
    const normalized = text.replaceAll("\r\n", "\n");
    if (normalized.includes("\r"))
        fail(`${relativePath} contains an unsupported carriage return.`);
    return normalized;
}

function changelogSection(changelog, version) {
    const lines = changelog.split("\n");
    const candidates = [];
    for (const [index, line] of lines.entries()) {
        if (line === `## ${version}` || line.startsWith(`## ${version} - `))
            candidates.push({ index, line });
    }
    if (candidates.length !== 1)
        fail(`${CHANGELOG_PATH} must contain exactly one ${version} section.`);

    const candidate = candidates[0];
    const date = candidate.line.slice(`## ${version} - `.length);
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    if (
        !candidate.line.startsWith(`## ${version} - `) ||
        !DATE_PATTERN.test(date) ||
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== date
    )
        fail(
            `${CHANGELOG_PATH} must use the heading "## ${version} - YYYY-MM-DD".`,
        );

    const end = lines.findIndex(
        (line, index) => index > candidate.index && line.startsWith("## "),
    );
    const section = lines
        .slice(candidate.index + 1, end === -1 ? undefined : end)
        .join("\n")
        .trim();
    if (!section) fail(`${CHANGELOG_PATH} has an empty ${version} section.`);
    return section;
}

function validateNotes(notes, version, relativePath) {
    const title = `# Crafleet ${version}`;
    const lines = notes.split("\n");
    if (lines[0] !== title) fail(`${relativePath} must start with "${title}".`);
    if (!lines.slice(1).join("\n").trim())
        fail(`${relativePath} contains no release details.`);
    return `${notes.trimEnd()}\n`;
}

export async function loadReleaseNotes(options = {}) {
    const root = path.resolve(options.root ?? process.cwd());
    const version = await readManifest(root);
    const expectedTag = `v${version}`;
    const tag = options.tag ?? expectedTag;
    if (tag !== expectedTag)
        fail(`tag ${tag} does not match package version ${version}.`);

    const changelog = normalizeText(
        await readText(root, CHANGELOG_PATH),
        CHANGELOG_PATH,
    );
    changelogSection(changelog, version);

    const relativePath = `docs/releases/${tag}.md`;
    const notes = normalizeText(
        await readText(root, relativePath),
        relativePath,
    );
    return {
        version,
        tag,
        relativePath,
        notes: validateNotes(notes, version, relativePath),
    };
}

export function parseReleaseNotesArguments(args) {
    let check = false;
    let tag;
    for (const argument of args) {
        if (argument === "--check" && !check) check = true;
        else if (tag === undefined && /^v\d+\.\d+\.\d+$/u.test(argument))
            tag = argument;
        else
            throw new Error(
                "Usage: node scripts/release-notes.mjs [--check] [v<version>]",
            );
    }
    return tag === undefined ? { check } : { check, tag };
}

async function main() {
    const command = parseReleaseNotesArguments(process.argv.slice(2));
    const result = await loadReleaseNotes(
        command.tag === undefined ? {} : { tag: command.tag },
    );
    if (!command.check) process.stdout.write(result.notes);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href)
    main().catch((error) => {
        process.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
    });
