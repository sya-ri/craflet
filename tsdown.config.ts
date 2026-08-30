import { defineConfig } from "tsdown";
import { architecturePlugin } from "./scripts/check-architecture.mjs";
import { crafletVersionDefine } from "./scripts/version.mjs";

export default defineConfig([
    {
        entry: { cli: "packages/cli/src/cli.ts" },
        outDir: "packages/cli/dist",
        format: "esm",
        platform: "node",
        target: "node24",
        clean: true,
        dts: false,
        define: crafletVersionDefine,
        deps: { alwaysBundle: [/.*/], onlyBundle: false, onlyImport: [] },
        plugins: [architecturePlugin({ standalone: true })],
        outputOptions: { codeSplitting: false, entryFileNames: "[name].mjs" },
    },
    {
        entry: { runner: "packages/cli/src/runner.ts" },
        outDir: "packages/cli/dist",
        format: "esm",
        platform: "node",
        target: "node24",
        clean: false,
        dts: false,
        define: crafletVersionDefine,
        deps: { alwaysBundle: [/.*/], onlyBundle: false, onlyImport: [] },
        plugins: [architecturePlugin({ standalone: true })],
        outputOptions: { codeSplitting: false, entryFileNames: "[name].mjs" },
    },
    {
        entry: { "generate-schema": "scripts/generate-schema.ts" },
        outDir: "artifacts/schema-builder",
        format: "esm",
        platform: "node",
        target: "node24",
        clean: true,
        dts: false,
        define: crafletVersionDefine,
        deps: { alwaysBundle: [/.*/], onlyBundle: false, onlyImport: [] },
        plugins: [architecturePlugin({ standalone: true })],
        outputOptions: { codeSplitting: false, entryFileNames: "[name].mjs" },
    },
]);
