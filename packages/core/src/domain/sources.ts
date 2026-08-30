import { type } from "arktype";
import type { ServerKind, SourceInput, SourceSpec } from "./artifacts.js";
import { CrafleetError } from "./errors.js";

const sourceSchema = type({ provider: "'file'", path: "string > 0" })
    .or({
        provider: "'modrinth' | 'hangar'",
        project: "string > 0",
        version: "string > 0",
    })
    .or({
        provider: "'spigotmc'",
        resource: "string > 0",
        version: "string > 0",
    })
    .or({
        provider: "'github'",
        owner: "string > 0",
        repo: "string > 0",
        version: "string > 0",
        asset: "string > 0",
    })
    .or({
        provider: "'paper'",
        project: "'paper' | 'velocity'",
        version: "string > 0",
        build: "string > 0",
    });

function invalidSource(): never {
    throw new CrafleetError(
        "INVALID_SOURCE",
        "Invalid artifact source. Use a provider reference, file:path, or a structured source object.",
        2,
    );
}

function component(value: string): string {
    try {
        const decoded = decodeURIComponent(value);
        if (!decoded || /\p{Cc}/u.test(decoded)) return invalidSource();
        return decoded;
    } catch {
        return invalidSource();
    }
}

function versioned(value: string): [string, string] {
    const [name, version = "latest", ...rest] = value.split("@");
    if (!name || rest.length > 0) return invalidSource();
    return [component(name), component(version)];
}

function jarName(value: string): string {
    if (!/\.jar$/iu.test(value)) return invalidSource();
    return value;
}

/** Opaque upstream versions are never interpreted as SemVer ranges. */
export function parseSource(input: SourceInput): SourceSpec {
    if (typeof input !== "string") {
        const result = sourceSchema(input);
        if (result instanceof type.errors) return invalidSource();
        for (const value of Object.values(result)) {
            if (typeof value === "string" && /\p{Cc}/u.test(value))
                return invalidSource();
        }
        if (result.provider === "file")
            return { ...result, path: jarName(result.path) };
        if (result.provider === "github")
            return { ...result, asset: jarName(result.asset) };
        return { ...result };
    }
    if (!input || /\p{Cc}/u.test(input)) return invalidSource();
    if (
        /^[a-z]:[\\/]/iu.test(input) ||
        input.startsWith("\\\\") ||
        !input.includes(":")
    ) {
        return { provider: "file", path: jarName(input) };
    }
    const separator = input.indexOf(":");
    const provider = input.slice(0, separator);
    const reference = input.slice(separator + 1);
    if (provider === "file") {
        if (!reference) return invalidSource();
        return { provider, path: jarName(reference) };
    }
    if (provider === "github") {
        const [repositoryAndVersion, asset, ...rest] = reference.split("#");
        if (!repositoryAndVersion || !asset || rest.length)
            return invalidSource();
        const [repository, version] = versioned(repositoryAndVersion);
        const [owner, repo, ...extra] = repository.split("/");
        if (!owner || !repo || extra.length) return invalidSource();
        return {
            provider,
            owner,
            repo,
            version,
            asset: jarName(component(asset)),
        };
    }
    const [project, version] = versioned(reference);
    if (provider === "modrinth" || provider === "hangar")
        return { provider, project, version };
    if (provider === "spigotmc")
        return { provider, resource: project, version };
    if (provider === "paper" || provider === "velocity") {
        return {
            provider: "paper",
            project: provider,
            version: project,
            build: version,
        };
    }
    return invalidSource();
}

export function parsePluginSource(
    input: SourceInput,
): Exclude<SourceSpec, { provider: "paper" }> {
    const source = parseSource(input);
    if (source.provider === "paper")
        throw new CrafleetError(
            "NOT_PLUGIN",
            "A Paper or Velocity server source cannot be declared as a plugin.",
            2,
        );
    return source;
}

export function parseServerSource(
    input: SourceInput,
    serverKind: ServerKind,
): SourceSpec {
    const source = parseSource(input);
    if (source.provider === "paper" && source.project !== serverKind)
        throw new CrafleetError(
            "SERVER_PLATFORM",
            `The server source provides ${source.project}, not ${serverKind}.`,
            2,
        );
    return source;
}

/** Keep everyday manifests readable without inventing an escaping language. */
export function formatSource(input: SourceSpec): SourceInput {
    const source = parseSource(input);
    if (source.provider === "file") return `file:${source.path}`;
    if (
        !Object.values(source).every((value) => /^[a-z\d._+/-]+$/iu.test(value))
    )
        return source;
    switch (source.provider) {
        case "modrinth":
        case "hangar":
            return `${source.provider}:${source.project}@${source.version}`;
        case "spigotmc":
            return `spigotmc:${source.resource}@${source.version}`;
        case "github":
            if (source.owner.includes("/") || source.repo.includes("/"))
                return source;
            return `github:${source.owner}/${source.repo}@${source.version}#${source.asset}`;
        case "paper":
            return `${source.project}:${source.version}@${source.build}`;
    }
}
