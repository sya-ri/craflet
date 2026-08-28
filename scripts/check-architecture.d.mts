import type { TsdownPlugin } from "tsdown";

export interface ArchitectureReport {
    modules: number;
    projectModules: number;
    runtimeEdges: number;
    externals: string[];
    outputs: string[];
}

export function architecturePlugin(options?: {
    root?: string;
    standalone?: boolean;
    onChecked?: (report: ArchitectureReport) => void;
}): TsdownPlugin;

export function checkArchitecture(root?: string): Promise<ArchitectureReport>;
