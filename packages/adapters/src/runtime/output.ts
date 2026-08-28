import type { Readable } from "node:stream";

/** Bound retained log lines before any server-controlled text reaches storage. */
export function consumeLogLines(
    stream: Readable,
    onLine: (line: string) => void,
    limit = 65536,
): void {
    let pending = "";
    let discarded = false;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        let start = 0;
        do {
            const end = chunk.indexOf("\n", start);
            const fragment = chunk.slice(start, end < 0 ? undefined : end);
            if (!discarded) {
                if (pending.length + fragment.length > limit) {
                    pending = "";
                    discarded = true;
                } else pending += fragment;
            }
            if (end < 0) break;
            onLine(
                discarded
                    ? "[craflet] Oversized server log line omitted."
                    : pending.replace(/\r$/, ""),
            );
            pending = "";
            discarded = false;
            start = end + 1;
        } while (start < chunk.length);
    });
    stream.once("end", () => {
        if (discarded) onLine("[craflet] Oversized server log line omitted.");
        else if (pending) onLine(pending.replace(/\r$/, ""));
    });
}
