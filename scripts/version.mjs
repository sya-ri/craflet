import { readFileSync } from "node:fs";

const manifest = JSON.parse(
    readFileSync(
        new URL("../packages/cli/package.json", import.meta.url),
        "utf8",
    ),
);

if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new TypeError("packages/cli/package.json must declare a version.");
}

export const crafletVersion = manifest.version;
export const crafletVersionDefine = {
    __CRAFLET_VERSION__: JSON.stringify(crafletVersion),
};
