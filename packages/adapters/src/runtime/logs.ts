import { open, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { CrafletError } from "@craflet/core";
import { assertNoSymlinks, exists } from "../filesystem/io.js";

export async function readServerLogs(
    projectDir: string,
    lines = 100,
): Promise<string> {
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000)
        throw new CrafletError(
            "LOG_LINES",
            "Log lines must be an integer from 1 to 10000.",
            2,
        );
    const file = await assertNoSymlinks(projectDir, ".craflet/server.log");
    if (!(await exists(file))) return "";
    const handle = await open(file, "r");
    try {
        const size = (await handle.stat()).size;
        const start = Math.max(0, size - 4 * 1024 * 1024);
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            start,
        );
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        const complete = start
            ? text.slice(
                  text.indexOf("\n") < 0 ? text.length : text.indexOf("\n") + 1,
              )
            : text;
        return complete.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
    } finally {
        await handle.close();
    }
}

export async function* followServerLogs(
    projectDir: string,
    signal: AbortSignal,
): AsyncGenerator<string> {
    const file = path.join(projectDir, ".craflet/server.log");
    await assertNoSymlinks(projectDir, ".craflet/server.log");
    let position = (await exists(file)) ? (await stat(file)).size : 0;
    let decoder = new StringDecoder("utf8");
    while (!signal.aborted) {
        await assertNoSymlinks(projectDir, ".craflet/server.log");
        if (await exists(file)) {
            const handle = await open(file, "r");
            try {
                const size = (await handle.stat()).size;
                if (size < position) {
                    position = 0;
                    decoder = new StringDecoder("utf8");
                }
                if (size > position) {
                    const buffer = Buffer.alloc(
                        Math.min(size - position, 1024 * 1024),
                    );
                    const { bytesRead } = await handle.read(
                        buffer,
                        0,
                        buffer.length,
                        position,
                    );
                    position += bytesRead;
                    const text = decoder.write(buffer.subarray(0, bytesRead));
                    if (text) yield text;
                }
            } finally {
                await handle.close();
            }
        }
        try {
            await delay(150, undefined, { signal });
        } catch {
            if (!signal.aborted)
                throw new CrafletError(
                    "LOG_FOLLOW",
                    "Unable to follow the server log.",
                    3,
                );
        }
    }
}
