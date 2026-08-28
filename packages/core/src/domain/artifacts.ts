export type ServerKind = "paper" | "velocity";
export type SourceSpec =
    | { provider: "file"; path: string }
    | { provider: "modrinth" | "hangar"; project: string; version: string }
    | { provider: "spigotmc"; resource: string; version: string }
    | {
          provider: "github";
          owner: string;
          repo: string;
          version: string;
          asset: string;
      }
    | {
          provider: "paper";
          project: ServerKind;
          version: string;
          build: string;
      };
export type SourceInput = string | SourceSpec;
export interface PluginIdentity {
    id: string;
    version: string;
    format: "bukkit" | "paper" | "velocity";
    dependencies: string[];
    optionalDependencies: string[];
    provides?: string[];
    apiVersion?: string;
}
export interface LockedArtifact {
    source: SourceSpec;
    version: string;
    sha256: string;
    size: number;
    url?: string;
    upstreamId?: string;
    identity?: PluginIdentity;
}
export interface ArtifactContext {
    projectDir: string;
    serverKind: ServerKind;
    minecraftVersion?: string;
    offline?: boolean;
    signal?: AbortSignal;
}
export interface ArtifactStore {
    resolve(
        source: SourceInput,
        context: ArtifactContext,
    ): Promise<LockedArtifact>;
    ensure(artifact: LockedArtifact, context: ArtifactContext): Promise<string>;
    inspect(path: string): Promise<PluginIdentity>;
    latest(source: SourceInput, context: ArtifactContext): Promise<SourceSpec>;
}
