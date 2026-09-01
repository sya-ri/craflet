import {
    CrafleetError,
    type PluginCatalog,
    type PluginCatalogContext,
    type PluginCatalogVersion,
    type PluginSearchPage,
    type PluginSearchRequest,
} from "@crafleet/core";
import { type } from "arktype";
import { ProviderHttp, type ProviderOptions, validated } from "./http.js";
import { isModrinthVersionCompatible, modrinthLoaders } from "./modrinth.js";

const searchSchema = type({
    hits: type({
        project_id: "string > 0",
        title: "string > 0",
        author: "string > 0",
        description: "string",
        downloads: "number.integer >= 0 & number <= 9007199254740991",
    }).array(),
    offset: "number.integer >= 0",
    limit: "number.integer >= 0",
    total_hits: "number.integer >= 0",
});

const catalogVersionSchema = type({
    id: "string > 0",
    name: "string > 0",
    version_number: "string > 0",
    version_type: "'release' | 'beta' | 'alpha'",
    date_published: "string > 0",
    loaders: "string[]",
    game_versions: "string[]",
});

export interface PluginCatalogOptions extends ProviderOptions {}

function validateRequest(request: PluginSearchRequest): void {
    if (
        typeof request.query !== "string" ||
        !Number.isSafeInteger(request.offset) ||
        request.offset < 0 ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 100
    )
        throw new CrafleetError(
            "INVALID_INPUT",
            "Plugin search needs a non-negative offset and a limit from 1 to 100.",
            2,
        );
}

function facets(context: PluginCatalogContext): string[][] {
    const result = [
        ["project_type:plugin"],
        modrinthLoaders(context.serverKind).map(
            (loader) => `categories:${loader}`,
        ),
    ];
    if (context.serverKind === "paper" && context.minecraftVersion)
        result.push([`versions:${context.minecraftVersion}`]);
    return result;
}

function compatibilityContext(context: PluginCatalogContext): {
    serverKind: PluginCatalogContext["serverKind"];
    minecraftVersion?: string;
} {
    return {
        serverKind: context.serverKind,
        ...(context.serverKind === "paper" && context.minecraftVersion
            ? { minecraftVersion: context.minecraftVersion }
            : {}),
    };
}

function validateDates(versions: (typeof catalogVersionSchema.infer)[]): void {
    if (
        versions.some(
            (version) => !Number.isFinite(Date.parse(version.date_published)),
        )
    )
        throw new CrafleetError(
            "PROVIDER_METADATA_INVALID",
            "The provider returned an unexpected metadata format.",
            3,
        );
}

export class NodePluginCatalog implements PluginCatalog {
    private readonly http: ProviderHttp;

    constructor(options: PluginCatalogOptions = {}) {
        this.http = new ProviderHttp(options);
    }

    async search(
        request: PluginSearchRequest,
        context: PluginCatalogContext,
    ): Promise<PluginSearchPage> {
        validateRequest(request);
        context.signal?.throwIfAborted();
        const queryText = request.query.trim();
        const query = new URLSearchParams({
            query: queryText,
            facets: JSON.stringify(facets(context)),
            index: queryText.length === 0 ? "downloads" : "relevance",
            offset: String(request.offset),
            limit: String(request.limit),
        });
        const page = validated(
            searchSchema,
            await this.http.json(
                `https://api.modrinth.com/v2/search?${query}`,
                context,
            ),
        );
        return {
            projects: page.hits.map((project) => ({
                projectId: project.project_id,
                title: project.title,
                author: project.author,
                description: project.description,
                downloads: project.downloads,
            })),
            offset: page.offset,
            limit: page.limit,
            total: page.total_hits,
        };
    }

    async versions(
        projectId: string,
        context: PluginCatalogContext,
    ): Promise<PluginCatalogVersion[]> {
        if (typeof projectId !== "string" || projectId.trim().length === 0)
            throw new CrafleetError(
                "INVALID_INPUT",
                "A Modrinth project ID is required.",
                2,
            );
        context.signal?.throwIfAborted();
        const query = new URLSearchParams({
            loaders: JSON.stringify(modrinthLoaders(context.serverKind)),
            include_changelog: "false",
        });
        if (context.serverKind === "paper" && context.minecraftVersion)
            query.set(
                "game_versions",
                JSON.stringify([context.minecraftVersion]),
            );
        const versions = validated(
            catalogVersionSchema.array(),
            await this.http.json(
                `https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${query}`,
                context,
            ),
        );
        validateDates(versions);
        return versions
            .filter((version) =>
                isModrinthVersionCompatible(
                    version,
                    compatibilityContext(context),
                ),
            )
            .sort(
                (left, right) =>
                    Date.parse(right.date_published) -
                    Date.parse(left.date_published),
            )
            .map((version) => ({
                versionId: version.id,
                label: version.version_number || version.name,
                type: version.version_type,
                publishedAt: version.date_published,
            }));
    }
}
