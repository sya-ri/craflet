import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        projects: [
            {
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
                test: {
                    name: "integration",
                    include: ["tests/integration/**/*.test.ts"],
                    testTimeout: 30000,
                    hookTimeout: 60000,
                },
            },
            {
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
