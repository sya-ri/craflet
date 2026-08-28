import type { RuntimeStatus } from "../domain/deployment.js";

export interface ServerStatus {
    status: RuntimeStatus;
    pid?: number;
    javaPid?: number;
    activeId?: string;
    clean?: boolean;
    exitCode?: number | null;
}
export interface ServerController {
    status(): Promise<ServerStatus>;
    start(activeId: string): Promise<ServerStatus>;
    stop(force?: boolean): Promise<ServerStatus>;
    command(text: string): Promise<void>;
}
