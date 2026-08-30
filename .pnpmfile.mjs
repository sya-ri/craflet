// The published CLI is self-contained; development manifests remain unchanged.
export const hooks = {
    beforePacking(pkg) {
        if (pkg.name !== "crafleet") return pkg;
        const bundled = new Set([
            "@crafleet/core",
            "@crafleet/adapters",
            "@clack/prompts",
            "@earendil-works/pi-tui",
            "commander",
        ]);
        const dependencies = Object.fromEntries(
            Object.entries(pkg.dependencies ?? {}).filter(
                ([name]) => !bundled.has(name),
            ),
        );
        return { ...pkg, dependencies };
    },
};
