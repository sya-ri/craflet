export interface ReleaseNotesOptions {
    root?: string;
    tag?: string;
}

export interface ReleaseNotes {
    version: string;
    tag: string;
    relativePath: string;
    notes: string;
}

export interface ReleaseNotesCommand {
    check: boolean;
    tag?: string;
}

export function loadReleaseNotes(
    options?: ReleaseNotesOptions,
): Promise<ReleaseNotes>;
export function parseReleaseNotesArguments(
    args: readonly string[],
): ReleaseNotesCommand;
