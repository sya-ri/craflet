import { defineConfig } from "vitest/config";
import { crafleetVersionDefine } from "./scripts/version.mjs";

export default defineConfig({
    define: crafleetVersionDefine,
    test: {
        server: {
            deps: {
                inline: [/^@crafleet\//u],
            },
        },
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: [
                        "packages/**/*.test.ts",
                        "tests/unit/**/*.test.ts",
                    ],
                    testTimeout: 10000,
                },
            },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["tests/integration/**/*.test.ts"],
                    testTimeout: 30000,
                    hookTimeout: 60000,
                },
            },
            {
                extends: true,
                test: {
                    name: "e2e",
                    include: ["tests/e2e/**/*.test.ts"],
                    testTimeout: 300000,
                    hookTimeout: 300000,
                    fileParallelism: false,
                },
            },
        ],
        coverage: {
            provider: "v8",
            include: ["packages/*/src/**/*.ts"],
            exclude: ["**/*.test.ts", "**/*.d.ts"],
            reporter: ["text", "json-summary", "html"],
            thresholds: {
                lines: 90,
                branches: 85,
                "packages/core/src/**": { lines: 95, branches: 90 },
            },
        },
    },
});
