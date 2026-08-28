import type { ArtifactContext, SourceSpec } from "@craflet/core";
import { type } from "arktype";
import {
    type DownloadSpec,
    manualDownload,
    noVersion,
    type ProviderHttp,
    validated,
} from "./http.js";

const versionSchema = type({
    id: "number.integer",
    projectId: "number.integer",
    name: "string > 0",
    createdAt: "string",
    channel: { name: "string" },
    downloads: {
        "[string]": {
            "downloadUrl?": "string | null",
            "externalUrl?": "string | null",
            "fileInfo?": type({
                name: "string",
                sizeBytes: "number.integer >= 0",
                sha256Hash: "string",
            }).or("null"),
        },
    },
    platformDependencies: { "[string]": "string[]" },
});

export async function resolveHangar(
    http: ProviderHttp,
    source: Extract<SourceSpec, { provider: "modrinth" | "hangar" }>,
    context: ArtifactContext,
): Promise<DownloadSpec> {
    let project = source.project;
    if (project.includes("/")) {
        const [owner, slug, ...rest] = project.split("/");
        if (!owner || !slug || rest.length) return noVersion();
        const projectInfo = validated(
            type({ id: "number.integer", namespace: { owner: "string" } }),
            await http.json(
                `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(slug)}`,
                context,
            ),
        );
        if (projectInfo.namespace.owner.toLowerCase() !== owner.toLowerCase())
            return noVersion();
        project = String(projectInfo.id);
    }
    const base = `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(project)}/versions`;
    const platform = context.serverKind === "paper" ? "PAPER" : "VELOCITY";
    let version: typeof versionSchema.infer;
    if (source.version === "latest") {
        const query = new URLSearchParams({
            platform,
            channel: "Release",
            includeHiddenChannels: "false",
            limit: "25",
            offset: "0",
        });
        if (context.serverKind === "paper" && context.minecraftVersion)
            query.set("platformVersion", context.minecraftVersion);
        const response = validated(
            type({ result: versionSchema.array() }),
            await http.json(`${base}?${query}`, context),
        );
        const selected = response.result
            .filter(
                (item) =>
                    item.channel.name.toLowerCase() === "release" &&
                    item.downloads[platform] &&
                    (context.serverKind !== "paper" ||
                        !context.minecraftVersion ||
                        item.platformDependencies[platform]?.includes(
                            context.minecraftVersion,
                        )),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!selected) return noVersion();
        version = selected;
    } else
        version = validated(
            versionSchema,
            await http.json(
                `${base}/${encodeURIComponent(source.version)}`,
                context,
            ),
        );
    if (
        context.serverKind === "paper" &&
        context.minecraftVersion &&
        !version.platformDependencies[platform]?.includes(
            context.minecraftVersion,
        )
    )
        return noVersion();
    const download = version.downloads[platform];
    if (!download) return noVersion();
    if (download.externalUrl || !download.downloadUrl || !download.fileInfo)
        return manualDownload(
            "This Hangar version requires an external/manual download.",
        );
    if (!/\.jar$/iu.test(download.fileInfo.name))
        return manualDownload("This Hangar download is not a JAR.");
    return {
        source: {
            provider: "hangar",
            project: String(version.projectId),
            version: String(version.id),
        },
        version: version.name,
        upstreamId: `${version.id}:${platform}`,
        url: download.downloadUrl,
        size: download.fileInfo.sizeBytes,
        hashes: { sha256: download.fileInfo.sha256Hash },
    };
}
