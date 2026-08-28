import {
    type ArtifactContext,
    CrafletError,
    type SourceSpec,
} from "@craflet/core";
import { type } from "arktype";
import {
    type DownloadSpec,
    manualDownload,
    noVersion,
    type ProviderHttp,
    validated,
} from "./http.js";

const resourceSchema = type({
    id: "number.integer",
    "premium?": "boolean",
    "external?": "boolean",
    "testedVersions?": "string[]",
    "file?": { "external?": "boolean", "type?": "string" },
});
const versionSchema = type({
    name: "string > 0",
    "id?": "number.integer",
    "uuid?": "string",
    "releaseDate?": "number",
});

export async function resolveSpigot(
    http: ProviderHttp,
    source: Extract<SourceSpec, { provider: "spigotmc" }>,
    context: ArtifactContext,
): Promise<DownloadSpec> {
    const base = `https://api.spiget.org/v2/resources/${encodeURIComponent(source.resource)}`;
    const resource = validated(resourceSchema, await http.json(base, context));
    if (resource.premium || resource.external || resource.file?.external)
        return manualDownload(
            "Paid and external SpigotMC resources require an authorized manual download.",
        );
    if (
        resource.file?.type &&
        resource.file.type !== ".jar" &&
        resource.file.type !== "jar"
    )
        return manualDownload(
            "This SpigotMC resource is not distributed as a JAR.",
        );
    let version: typeof versionSchema.infer;
    if (source.version === "latest") {
        if (
            context.minecraftVersion &&
            !resource.testedVersions?.some(
                (item) =>
                    context.minecraftVersion === item ||
                    context.minecraftVersion?.startsWith(`${item}.`),
            )
        ) {
            throw new CrafletError(
                "COMPATIBILITY_UNVERIFIED",
                "SpigotMC does not declare compatibility with this Minecraft version. Its version labels are not SemVer ranges.",
                3,
                "Review the resource and select an explicit version ID.",
            );
        }
        version = validated(
            versionSchema,
            await http.json(`${base}/versions/latest`, context),
        );
    } else if (/^(\d+|[a-f\d]{8}(?:-[a-f\d]+){4})$/iu.test(source.version)) {
        version = validated(
            versionSchema,
            await http.json(
                `${base}/versions/${encodeURIComponent(source.version)}`,
                context,
            ),
        );
    } else {
        const matches: Array<typeof versionSchema.infer> = [];
        for (let page = 0; page < 10; page++) {
            const versions = validated(
                versionSchema.array(),
                await http.json(
                    `${base}/versions?size=100&page=${page}&sort=-releaseDate`,
                    context,
                ),
            );
            matches.push(
                ...versions.filter(
                    (item) =>
                        item.name === source.version ||
                        item.uuid === source.version,
                ),
            );
            if (versions.length < 100) break;
            if (page === 9)
                throw new CrafletError(
                    "VERSION_LOOKUP_LIMIT",
                    "SpigotMC version label lookup exceeded its limit. Use a version ID instead.",
                    3,
                );
        }
        if (matches.length !== 1)
            throw new CrafletError(
                "AMBIGUOUS_VERSION",
                "SpigotMC labels are opaque and may repeat. Select an exact version ID.",
                3,
            );
        const selected = matches[0];
        if (!selected) return noVersion();
        version = selected;
    }
    const id =
        version.uuid ||
        (version.id === undefined ? undefined : String(version.id));
    if (!id) return noVersion();
    return {
        source: {
            provider: "spigotmc",
            resource: String(resource.id),
            version: id,
        },
        version: version.name,
        upstreamId: id,
        url: `${base}/versions/${encodeURIComponent(id)}/download`,
    };
}
