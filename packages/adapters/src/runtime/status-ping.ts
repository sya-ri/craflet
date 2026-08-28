import net from "node:net";

function varint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value >>> 0;
    do {
        const next = remaining & 127;
        remaining >>>= 7;
        bytes.push(next | (remaining ? 128 : 0));
    } while (remaining);
    return Buffer.from(bytes);
}
function readVarint(
    buffer: Buffer,
    offset: number,
): { value: number; next: number } | undefined {
    let value = 0;
    for (let index = 0; index < 5; index++) {
        const byte = buffer[offset + index];
        if (byte === undefined) return undefined;
        value |= (byte & 127) << (7 * index);
        if (!(byte & 128)) return { value, next: offset + index + 1 };
    }
    throw new Error("Invalid status packet length");
}

/** Request the Minecraft server-list status, rather than merely testing TCP. */
export async function pingServer(
    host: string,
    port: number,
    timeout = 2000,
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        let buffer: Buffer = Buffer.alloc(0);
        let finished = false;
        const finish = (error?: Error, value?: Record<string, unknown>) => {
            if (finished) return;
            finished = true;
            socket.destroy();
            if (error) reject(error);
            else resolve(value ?? {});
        };
        socket.setTimeout(timeout, () =>
            finish(new Error("Minecraft status timeout")),
        );
        socket.once("error", (error) => finish(error));
        socket.once("close", () => {
            if (!finished)
                finish(new Error("Server closed without a status response"));
        });
        socket.once("connect", () => {
            const address = Buffer.from(host);
            const portBytes = Buffer.alloc(2);
            portBytes.writeUInt16BE(port);
            const handshake = Buffer.concat([
                varint(0),
                varint(-1),
                varint(address.length),
                address,
                portBytes,
                varint(1),
            ]);
            socket.write(
                Buffer.concat([
                    varint(handshake.length),
                    handshake,
                    Buffer.from([1, 0]),
                ]),
            );
        });
        socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > 1024 * 1024)
                return finish(new Error("Status response exceeds limit"));
            try {
                const packet = readVarint(buffer, 0);
                if (!packet || buffer.length < packet.next + packet.value)
                    return;
                if (packet.value < 2) throw new Error("Invalid status packet");
                const id = readVarint(buffer, packet.next);
                if (id?.value !== 0)
                    throw new Error("Unexpected status packet");
                const length = readVarint(buffer, id.next);
                if (
                    !length ||
                    length.value < 0 ||
                    length.next + length.value > packet.next + packet.value
                )
                    throw new Error("Truncated status response");
                const result: unknown = JSON.parse(
                    buffer
                        .subarray(length.next, length.next + length.value)
                        .toString("utf8"),
                );
                if (
                    !result ||
                    typeof result !== "object" ||
                    !("version" in result)
                )
                    throw new Error("Not a Minecraft status response");
                finish(undefined, result as Record<string, unknown>);
            } catch (error) {
                finish(
                    error instanceof Error
                        ? error
                        : new Error("Invalid status"),
                );
            }
        });
    });
}
