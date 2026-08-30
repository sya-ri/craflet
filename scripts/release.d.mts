export interface ReleaseReceipt {
    head: string;
    version: string;
    sha256: string;
    size: number;
}

export interface CheckedRelease {
    root: string;
    receipt: ReleaseReceipt;
}

export interface PublishRequest {
    root: string;
    tarball: string;
    provenance: boolean;
}

export interface ReleasePreflightRequest {
    root: string;
    head: string;
}

export type ReleasePreflight = (
    request: ReleasePreflightRequest,
) => Promise<void>;

export type ReleaseMode = "prepare" | "check" | "publish";

export interface ReleaseCommand {
    mode: ReleaseMode;
}

export interface ReleaseOptions {
    root?: string;
    preflight?: ReleasePreflight;
}

export interface PublishOptions extends ReleaseOptions {
    publish?: (request: PublishRequest) => Promise<void>;
    remove?: (file: string) => Promise<void>;
}

export const RECEIPT_PATH: "artifacts/release-receipt.json";
export function prepareRelease(
    options?: ReleaseOptions,
): Promise<CheckedRelease>;
export function checkRelease(options?: ReleaseOptions): Promise<CheckedRelease>;
export function publishRelease(
    options?: PublishOptions,
): Promise<CheckedRelease>;
export function npmPublishArguments(request: PublishRequest): string[];
export function parseReleaseArguments(args: readonly string[]): ReleaseCommand;
