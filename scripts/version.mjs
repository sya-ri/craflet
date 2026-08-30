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

export const crafleetVersion = manifest.version;
export const crafleetVersionDefine = {
    __CRAFLEET_VERSION__: JSON.stringify(crafleetVersion),
};
