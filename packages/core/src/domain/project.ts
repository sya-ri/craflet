import { type } from "arktype";
import { CrafleetError } from "./errors.js";

const Nonempty = type("string > 0");
const ProjectName = type(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const SecretSchema = type({ "+": "reject", env: Nonempty }).or({
    "+": "reject",
    file: Nonempty,
});
export const SourceSchema = type("string > 0")
    .or({ "+": "reject", provider: "'file'", path: Nonempty })
    .or({
        "+": "reject",
        provider: "'modrinth' | 'hangar'",
        project: Nonempty,
        version: Nonempty,
    })
    .or({
        "+": "reject",
        provider: "'spigotmc'",
        resource: Nonempty,
        version: Nonempty,
    })
    .or({
        "+": "reject",
        provider: "'github'",
        owner: Nonempty,
        repo: Nonempty,
        version: Nonempty,
        asset: Nonempty,
    })
    .or({
        "+": "reject",
        provider: "'paper'",
        project: "'paper' | 'velocity'",
        version: Nonempty,
        build: Nonempty,
    });
export const DatabaseSchema = type({
    "+": "reject",
    id: Nonempty,
    kind: "'sqlite'",
    path: Nonempty,
}).or({
    "+": "reject",
    id: Nonempty,
    kind: "'mysql' | 'mariadb'",
    host: Nonempty,
    "port?": "number.integer > 0 & number <= 65535",
    database: Nonempty,
    user: Nonempty,
    password: SecretSchema,
    "command?": Nonempty,
    "restoreCommand?": Nonempty,
    "sslCa?": Nonempty,
});
export const ProjectSchema = type({
    "+": "reject",
    schemaVersion: "1",
    "id?": "string.uuid",
    name: ProjectName,
    server: {
        "+": "reject",
        type: "'paper' | 'velocity'",
        version: Nonempty,
        "build?": Nonempty,
        "source?": SourceSchema,
    },
    "java?": {
        "+": "reject",
        "command?": Nonempty,
        "args?": "string[]",
        "startupTimeout?": "number.integer > 0",
        "stopTimeout?": "number.integer > 0",
    },
    plugins: { "[string]": SourceSchema },
    "secrets?": { "[string]": SecretSchema },
    "backup?": {
        "+": "reject",
        "repository?": Nonempty,
        files: "string[]",
        "group?": Nonempty,
        "databases?": DatabaseSchema.array(),
        "retention?": {
            "+": "reject",
            "keepLast?": "number.integer >= 1",
            "keepDaily?": "number.integer >= 1",
            "keepWeekly?": "number.integer >= 1",
            "keepMonthly?": "number.integer >= 1",
        },
    },
});
export type ProjectManifest = typeof ProjectSchema.infer;
export type ProjectSecretReference = typeof SecretSchema.infer;
export const WorkspaceSchema = type({
    "+": "reject",
    schemaVersion: "1",
    projects: "string[]",
});
export type WorkspaceManifest = typeof WorkspaceSchema.infer;

export const PluginIdentitySchema = type({
    "+": "reject",
    id: Nonempty,
    version: "string",
    format: "'paper' | 'bukkit' | 'velocity'",
    dependencies: "string[]",
    optionalDependencies: "string[]",
    "provides?": "string[]",
    "apiVersion?": "string",
});
export const ArtifactSchema = type({
    "+": "reject",
    source: SourceSchema.exclude("string"),
    version: Nonempty,
    sha256: /^[a-f0-9]{64}$/,
    size: "number.integer >= 0 & number <= 9007199254740991",
    "url?": Nonempty,
    "upstreamId?": Nonempty,
    "identity?": PluginIdentitySchema,
});
export const ProjectLockSchema = type({
    "+": "reject",
    name: Nonempty,
    requests: {
        "+": "reject",
        server: Nonempty,
        plugins: { "[string]": Nonempty },
    },
    server: ArtifactSchema,
    plugins: { "[string]": ArtifactSchema },
});
export type ProjectLock = typeof ProjectLockSchema.infer;
export const LockSchema = type({
    "+": "reject",
    lockVersion: "1",
    projects: { "[string]": ProjectLockSchema },
});
export type LockFile = typeof LockSchema.infer;

function validateProjectLockMappings(project: ProjectLock): ProjectLock {
    if (
        Array.isArray(project.plugins) ||
        Array.isArray(project.requests.plugins)
    )
        throw new CrafleetError(
            "INVALID_INPUT",
            "crafleet-lock.yaml: plugin resolutions and requests must be objects, not arrays.",
            2,
        );
    return project;
}

export function validateProject(input: unknown): ProjectManifest {
    const result = ProjectSchema(input);
    if (result instanceof type.errors) {
        const name =
            input !== null && typeof input === "object" && "name" in input
                ? input.name
                : undefined;
        if (
            typeof name === "string" &&
            name.length > 0 &&
            ProjectName(name) instanceof type.errors
        )
            throw new CrafleetError(
                "PROJECT_NAME",
                "Project name must contain only letters, digits, dot, underscore or dash.",
                2,
            );
        throw validationError("crafleet.yaml", result);
    }
    // ArkType index signatures include arrays, whereas JSON Schema's object
    // type excludes them. Keep persisted/user-facing maps object-shaped.
    if (
        [
            result.plugins,
            result.secrets,
            result.java,
            result.backup?.retention,
        ].some(Array.isArray)
    )
        throw new CrafleetError(
            "INVALID_INPUT",
            "crafleet.yaml: plugin, secret, Java and retention mappings must be objects, not arrays.",
            2,
        );
    return result;
}

export function validateProjectLock(input: unknown): ProjectLock {
    const result = ProjectLockSchema(input);
    if (result instanceof type.errors)
        throw validationError("crafleet-lock.yaml", result);
    return validateProjectLockMappings(result);
}

export function validateLock(input: unknown): LockFile {
    const result = LockSchema(input);
    if (result instanceof type.errors)
        throw validationError("crafleet-lock.yaml", result);
    if (Array.isArray(result.projects))
        throw new CrafleetError(
            "INVALID_INPUT",
            "crafleet-lock.yaml: projects must be an object, not an array.",
            2,
        );
    const projects: Record<string, ProjectLock> = Object.create(null);
    for (const [key, project] of Object.entries(result.projects))
        projects[key] = validateProjectLockMappings(project);
    return { ...result, projects };
}

export function validationError(
    file: string,
    errors: InstanceType<typeof type.errors>,
): CrafleetError {
    // Do not serialize ArkErrors: they contain the original input, including secrets.
    const fields = [
        ...new Set(
            errors.map((error) => error.path.map(String).join(".") || "(root)"),
        ),
    ];
    return new CrafleetError(
        "INVALID_INPUT",
        `${file}: invalid or missing fields: ${fields.join(", ")}`,
        2,
        "Check the schema and the field names; input values are omitted for safety.",
    );
}

export const DEFAULT_BACKUP_FILES = [
    "runtime/**",
    "shared-data/**",
    "!**/*.[jJ][aA][rR]",
    "!runtime/logs/**",
    "!runtime/crash-reports/**",
    "!runtime/libraries/**",
    "!runtime/cache/**",
    "!runtime/versions/**",
];

export function newProject(
    name: string,
    kind: "paper" | "velocity",
    version: string,
): ProjectManifest {
    return validateProject({
        schemaVersion: 1,
        name,
        server: { type: kind, version, build: "latest" },
        plugins: {},
        backup: { files: [...DEFAULT_BACKUP_FILES] },
    });
}

export function stableStringify(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b, "en"))
            .map(
                ([key, item]) =>
                    `${JSON.stringify(key)}:${stableStringify(item)}`,
            )
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
}
