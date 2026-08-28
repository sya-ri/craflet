import type { ArtifactContext, SourceSpec } from "@craflet/core";
import { resolveGithub } from "./github.js";
import { resolveHangar } from "./hangar.js";
import type { DownloadSpec, ProviderHttp } from "./http.js";
import { resolveModrinth } from "./modrinth.js";
import { resolvePaper } from "./paper.js";
import { resolveSpigot } from "./spigotmc.js";

export function resolveRemote(
    http: ProviderHttp,
    source: Exclude<SourceSpec, { provider: "file" }>,
    context: ArtifactContext,
): Promise<DownloadSpec> {
    switch (source.provider) {
        case "modrinth":
            return resolveModrinth(http, source, context);
        case "hangar":
            return resolveHangar(http, source, context);
        case "spigotmc":
            return resolveSpigot(http, source, context);
        case "github":
            return resolveGithub(http, source, context);
        case "paper":
            return resolvePaper(http, source, context);
    }
}
