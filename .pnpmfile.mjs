// The published CLI is self-contained; development manifests remain unchanged.
export const hooks = {
    beforePacking(pkg) {
        if (pkg.name !== "craflet") return pkg;
        const bundled = new Set([
            "@craflet/core",
            "@craflet/adapters",
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
