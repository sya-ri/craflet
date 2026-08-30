import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LockSchema, ProjectSchema, WorkspaceSchema } from "@crafleet/core";

const directory = path.resolve("packages/cli/dist/schemas");
await mkdir(directory, { recursive: true });
for (const [name, schema] of [
    ["crafleet", ProjectSchema],
    ["crafleet-workspace", WorkspaceSchema],
    ["crafleet-lock", LockSchema],
] as const) {
    await writeFile(
        path.join(directory, `${name}.schema.json`),
        `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: name, ...schema.toJsonSchema() }, null, 4)}\n`,
    );
}
