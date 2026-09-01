import type { ServerKind } from "../domain/artifacts.js";

export interface PluginCatalogContext {
    serverKind: ServerKind;
    minecraftVersion?: string;
    offline?: boolean;
    signal?: AbortSignal;
}

export interface PluginSearchRequest {
    query: string;
    offset: number;
    limit: number;
}

export interface PluginCatalogProject {
    projectId: string;
    title: string;
    author: string;
    description: string;
    downloads: number;
}

export interface PluginSearchPage {
    projects: PluginCatalogProject[];
    offset: number;
    limit: number;
    total: number;
}

export type PluginCatalogVersionType = "release" | "beta" | "alpha";

export interface PluginCatalogVersion {
    versionId: string;
    label: string;
    type: PluginCatalogVersionType;
    publishedAt: string;
}

export interface PluginCatalog {
    search(
        request: PluginSearchRequest,
        context: PluginCatalogContext,
    ): Promise<PluginSearchPage>;
    versions(
        projectId: string,
        context: PluginCatalogContext,
    ): Promise<PluginCatalogVersion[]>;
}
