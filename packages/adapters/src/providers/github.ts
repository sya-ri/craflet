import {
    type ArtifactContext,
    CrafletError,
    type SourceSpec,
} from "@craflet/core";
import { type } from "arktype";
import {
    type DownloadSpec,
    noVersion,
    type ProviderHttp,
    validated,
} from "./http.js";

const releaseSchema = type({
    id: "number.integer",
    tag_name: "string > 0",
    draft: "boolean",
    prerelease: "boolean",
    assets: type({
        id: "number.integer",
        name: "string",
        size: "number.integer >= 0",
        browser_download_url: "string",
        "digest?": "string | null",
        "state?": "string",
    }).array(),
});

export async function resolveGithub(
    http: ProviderHttp,
    source: Extract<SourceSpec, { provider: "github" }>,
    context: ArtifactContext,
): Promise<DownloadSpec> {
    const release = validated(
        releaseSchema,
        await http.json(
            `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/releases/${source.version === "latest" ? "latest" : `tags/${encodeURIComponent(source.version)}`}`,
            context,
        ),
    );
    if (release.draft || (source.version === "latest" && release.prerelease))
        return noVersion();
    const assets = release.assets.filter(
        (asset) =>
            asset.name === source.asset &&
            (!asset.state || asset.state === "uploaded"),
    );
    if (assets.length !== 1 || !/\.jar$/iu.test(source.asset))
        throw new CrafletError(
            "AMBIGUOUS_ARTIFACT",
            "The GitHub release must contain exactly one uploaded JAR with the requested asset name.",
            3,
        );
    const asset = assets[0];
    if (!asset) return noVersion();
    const hashes: DownloadSpec["hashes"] = {};
    if (asset.digest) {
        if (!/^sha256:[a-f\d]{64}$/iu.test(asset.digest))
            throw new CrafletError(
                "PROVIDER_METADATA_INVALID",
                "The GitHub asset checksum format is unsupported.",
                3,
            );
        hashes.sha256 = asset.digest.slice(7).toLowerCase();
    }
    return {
        source: { ...source, version: release.tag_name },
        version: release.tag_name,
        upstreamId: `${release.id}:${asset.id}`,
        url: asset.browser_download_url,
        size: asset.size,
        hashes,
    };
}
