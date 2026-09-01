import {
    type ArtifactContext,
    CrafleetError,
    type ServerKind,
    type SourceSpec,
} from "@crafleet/core";
import { type } from "arktype";
import {
    type DownloadSpec,
    noVersion,
    type ProviderHttp,
    validated,
} from "./http.js";

const versionSchema = type({
    id: "string > 0",
    project_id: "string > 0",
    version_number: "string > 0",
    version_type: "string",
    date_published: "string",
    loaders: "string[]",
    game_versions: "string[]",
    files: type({
        filename: "string",
        url: "string",
        primary: "boolean",
        size: "number.integer >= 0",
        hashes: { "sha512?": "string", "sha1?": "string" },
    }).array(),
});

export function modrinthLoaders(serverKind: ServerKind): string[] {
    return serverKind === "paper"
        ? ["paper", "spigot", "bukkit"]
        : ["velocity"];
}

export function isModrinthVersionCompatible(
    version: { loaders: string[]; game_versions: string[] },
    context: { serverKind: ServerKind; minecraftVersion?: string },
): boolean {
    const loaders = modrinthLoaders(context.serverKind);
    return (
        version.loaders.some((loader) => loaders.includes(loader)) &&
        (!context.minecraftVersion ||
            version.game_versions.includes(context.minecraftVersion))
    );
}

export async function resolveModrinth(
    http: ProviderHttp,
    source: Extract<SourceSpec, { provider: "modrinth" | "hangar" }>,
    context: ArtifactContext,
): Promise<DownloadSpec> {
    const base = `https://api.modrinth.com/v2/project/${encodeURIComponent(source.project)}/version`;
    const loaders = modrinthLoaders(context.serverKind);
    let version: typeof versionSchema.infer;
    if (source.version === "latest") {
        const query = new URLSearchParams({ loaders: JSON.stringify(loaders) });
        if (context.minecraftVersion)
            query.set(
                "game_versions",
                JSON.stringify([context.minecraftVersion]),
            );
        const versions = validated(
            versionSchema.array(),
            await http.json(`${base}?${query}`, context),
        );
        const selected = versions
            .filter(
                (item) =>
                    item.version_type === "release" &&
                    isModrinthVersionCompatible(item, context),
            )
            .sort((a, b) =>
                b.date_published.localeCompare(a.date_published),
            )[0];
        if (!selected) return noVersion();
        version = selected;
    } else {
        version = validated(
            versionSchema,
            await http.json(
                `${base}/${encodeURIComponent(source.version)}`,
                context,
            ),
        );
    }
    if (!isModrinthVersionCompatible(version, context)) return noVersion();
    const jars = version.files.filter((file) => /\.jar$/iu.test(file.filename));
    const primary = jars.filter((file) => file.primary);
    const selected =
        primary.length === 1
            ? primary[0]
            : jars.length === 1
              ? jars[0]
              : undefined;
    if (!selected)
        throw new CrafleetError(
            "AMBIGUOUS_ARTIFACT",
            "The Modrinth release does not identify a unique primary JAR.",
            3,
        );
    if (!selected.hashes.sha512 && !selected.hashes.sha1)
        throw new CrafleetError(
            "PROVIDER_METADATA_INVALID",
            "The Modrinth file has no published checksum.",
            3,
        );
    return {
        source: {
            provider: "modrinth",
            project: version.project_id,
            version: version.id,
        },
        version: version.version_number,
        upstreamId: version.id,
        url: selected.url,
        size: selected.size,
        hashes: selected.hashes,
    };
}
