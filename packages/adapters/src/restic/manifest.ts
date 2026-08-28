export const RESTIC_VERSION = "0.19.1";

export interface ResticAsset {
    name: string;
    size: number;
    sha256: string;
    compression: "zip" | "bz2";
}

// GitHub's official restic v0.19.1 release asset metadata, checked 2026-08-29.
// Pins are updated deliberately with the supported restic release, never at runtime.
export const RESTIC_ASSETS: Readonly<Record<string, ResticAsset>> = {
    "darwin-x64": {
        name: "restic_0.19.1_darwin_amd64.bz2",
        size: 10518038,
        sha256: "c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35",
        compression: "bz2",
    },
    "darwin-arm64": {
        name: "restic_0.19.1_darwin_arm64.bz2",
        size: 9733199,
        sha256: "7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143",
        compression: "bz2",
    },
    "linux-x64": {
        name: "restic_0.19.1_linux_amd64.bz2",
        size: 10107515,
        sha256: "f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c",
        compression: "bz2",
    },
    "linux-arm64": {
        name: "restic_0.19.1_linux_arm64.bz2",
        size: 9044264,
        sha256: "a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465",
        compression: "bz2",
    },
    "win32-x64": {
        name: "restic_0.19.1_windows_amd64.zip",
        size: 11237567,
        sha256: "da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d",
        compression: "zip",
    },
};

export const MAX_RESTIC_BINARY_BYTES = 64 * 1024 * 1024;
