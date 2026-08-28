import { crc32, deflateRawSync } from "node:zlib";

export interface ArtifactZipEntry {
    name: string;
    content: string | Buffer;
    compress?: boolean;
    crc?: number;
    size?: number;
    encrypted?: boolean;
}

/** Small real ZIP fixtures, including deliberately malformed headers; no Java is executed. */
export function artifactZip(entries: ArtifactZipEntry[]): Buffer<ArrayBuffer> {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name);
        const body = Buffer.from(entry.content);
        const compressed = entry.compress ? deflateRawSync(body) : body;
        const crc = entry.crc ?? crc32(body);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
        header.writeUInt16LE(entry.compress ? 8 : 0, 8);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressed.length, 18);
        header.writeUInt32LE(entry.size ?? body.length, 22);
        header.writeUInt16LE(name.length, 26);
        locals.push(header, name, compressed);
        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50, 0);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(entry.encrypted ? 1 : 0, 8);
        directory.writeUInt16LE(entry.compress ? 8 : 0, 10);
        directory.writeUInt32LE(crc, 16);
        directory.writeUInt32LE(compressed.length, 20);
        directory.writeUInt32LE(entry.size ?? body.length, 24);
        directory.writeUInt16LE(name.length, 28);
        directory.writeUInt32LE(offset, 42);
        central.push(directory, name);
        offset += header.length + name.length + compressed.length;
    }
    const centralBody = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBody.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBody, end]);
}

export const artifactBukkit =
    "name: Example\nversion: '1.0'\nmain: example.Main\napi-version: '1.21'\n";

export function artifactJar(
    name = "Example",
    version = "1.0",
): Buffer<ArrayBuffer> {
    return artifactZip([
        {
            name: "plugin.yml",
            content: `name: ${name}\nversion: '${version}'\nmain: example.Main\n`,
        },
    ]);
}
