import type { ArtifactContext, SourceSpec } from "@craflet/core";
import { type } from "arktype";
import {
    type DownloadSpec,
    noVersion,
    type ProviderHttp,
    validated,
} from "./http.js";

const projectSchema = type({ versions: { "[string]": "string[]" } });
const buildSchema = type({
    id: "number.integer",
    channel: "string",
    downloads: {
        "server:default": {
            url: "string",
            size: "number.integer >= 0",
            checksums: { sha256: "string" },
        },
    },
});

export async function resolvePaper(
    http: ProviderHttp,
    source: Extract<SourceSpec, { provider: "paper" }>,
    context: ArtifactContext,
): Promise<DownloadSpec> {
    const base = `https://fill.papermc.io/v3/projects/${source.project}`;
    let version = source.version;
    if (version === "latest") {
        if (source.project === "paper" && context.minecraftVersion)
            version = context.minecraftVersion;
        else {
            const project = validated(
                projectSchema,
                await http.json(base, context),
            );
            const latest = Object.values(project.versions)
                .flat()
                .find((item) => !/-/u.test(item));
            if (!latest) return noVersion();
            version = latest;
        }
    }
    const builds = validated(
        buildSchema.array(),
        await http.json(
            `${base}/versions/${encodeURIComponent(version)}/builds`,
            context,
        ),
    );
    const build =
        source.build === "latest"
            ? builds
                  .filter((item) => item.channel === "STABLE")
                  .sort((a, b) => b.id - a.id)[0]
            : builds.find((item) => String(item.id) === source.build);
    if (!build) return noVersion();
    const download = build.downloads["server:default"];
    return {
        source: { ...source, version, build: String(build.id) },
        version,
        upstreamId: `${source.project}:${version}:${build.id}`,
        url: download.url,
        size: download.size,
        hashes: download.checksums,
    };
}
