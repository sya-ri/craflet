export type DiagnosticStatus = "pass" | "warn" | "fail" | "unknown" | "skip";
export interface Diagnostic {
    id: string;
    status: DiagnosticStatus;
    message: string;
    required?: boolean;
    hint?: string;
}

export function parseJavaVersion(output: string): number | undefined {
    const match = /(?:openjdk|java)\s+(?:version\s+)?"?(\d+)(?:\.(\d+))?/i.exec(
        output,
    );
    if (!match?.[1]) return undefined;
    const major = Number(match[1]);
    return major === 1 ? Number(match[2]) || undefined : major;
}

export function javaRequirement(
    kind: "paper" | "velocity",
    version: string,
): { minimum?: number; recommended?: number } {
    if (kind === "velocity") {
        if (/^4\./.test(version)) return { minimum: 25, recommended: 25 };
        return {};
    }
    if (/^26\.[12](\.|$)/.test(version))
        return { minimum: 25, recommended: 25 };
    // Paper's historical table specifies recommendations, not minimums.
    if (/^1\.2[01](?:\.|$)/.test(version)) return { recommended: 21 };
    return {};
}

export function diagnosticsFailed(items: readonly Diagnostic[]): boolean {
    return items.some(
        (item) =>
            item.status === "fail" ||
            (item.status === "unknown" && item.required),
    );
}
