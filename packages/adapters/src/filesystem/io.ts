import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
    access,
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CrafletError } from "@craflet/core";

export async function exists(file: string): Promise<boolean> {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export async function atomicWrite(
    file: string,
    content: string | Uint8Array,
    mode = 0o600,
): Promise<void> {
    await assertNoSymlinks(path.dirname(file), path.basename(file));
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", mode);
    try {
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await renameWithSharingRetry(temporary, file);
    } finally {
        await rm(temporary, { force: true });
    }
}

/** Windows readers may transiently deny replacement; never unlink the destination. */
export async function renameWithSharingRetry(
    source: string,
    destination: string,
    options: {
        platform?: NodeJS.Platform;
        rename?: (source: string, destination: string) => Promise<void>;
    } = {},
): Promise<void> {
    const platform = options.platform ?? process.platform;
    const perform = options.rename ?? rename;
    for (let attempt = 0; ; attempt++) {
        await assertNoSymlinks(source);
        await assertNoSymlinks(destination);
        try {
            await perform(source, destination);
            return;
        } catch (error) {
            if (
                platform !== "win32" ||
                attempt >= 5 ||
                !["EPERM", "EACCES", "EBUSY"].includes(
                    (error as NodeJS.ErrnoException).code ?? "",
                )
            )
                throw error;
            await delay(Math.min(10 * 2 ** attempt, 80));
        }
    }
}

export async function readJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
    await atomicWrite(file, `${JSON.stringify(value, null, 4)}\n`);
}

export function containedPath(root: string, relative: string): string {
    const target = path.resolve(root, relative);
    const difference = path.relative(path.resolve(root), target);
    if (
        difference === ".." ||
        difference.startsWith(`..${path.sep}`) ||
        path.isAbsolute(difference)
    ) {
        throw new CrafletError(
            "PATH_ESCAPE",
            `Path leaves its managed directory: ${relative}`,
            3,
        );
    }
    return target;
}

export async function assertNoSymlinks(
    root: string,
    relative = "",
): Promise<string> {
    const target = containedPath(root, relative);
    const resolvedRoot = path.resolve(root);
    // Check root and every existing ancestor; never write through a runtime/config link.
    let current = path.parse(resolvedRoot).root;
    for (const segment of path
        .relative(current, target)
        .split(path.sep)
        .filter(Boolean)) {
        current = path.join(current, segment);
        if (!(await exists(current))) continue;
        if ((await lstat(current)).isSymbolicLink()) {
            throw new CrafletError(
                "SYMLINK_UNSAFE",
                `Refusing managed path through a symbolic link: ${current}`,
                3,
            );
        }
    }
    return target;
}

export async function listFiles(root: string): Promise<string[]> {
    await assertNoSymlinks(root);
    if (!(await exists(root))) return [];
    const files: string[] = [];
    async function walk(directory: string, prefix: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink())
                throw new CrafletError(
                    "SYMLINK_UNSAFE",
                    `Symbolic link in managed files: ${relative}`,
                    3,
                );
            if (entry.isDirectory())
                await walk(path.join(directory, entry.name), relative);
            else if (entry.isFile()) files.push(relative);
        }
    }
    await walk(root, "");
    return files.sort();
}

export async function readable(file: string): Promise<boolean> {
    try {
        await access(file, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

export async function canonicalPath(file: string): Promise<string> {
    return realpath(file);
}

export async function withMutex<T>(
    directory: string,
    action: () => Promise<T>,
): Promise<T> {
    await assertNoSymlinks(path.dirname(directory), path.basename(directory));
    await mkdir(path.dirname(directory), { recursive: true });
    try {
        await mkdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new CrafletError(
                "BUSY",
                "Another operation is active, or an interrupted operation needs recovery.",
                4,
                "Run craflet recover after verifying no operation is active.",
            );
        }
        throw error;
    }
    try {
        await writeJson(path.join(directory, "owner.json"), {
            pid: process.pid,
            started: new Date().toISOString(),
        });
        return await action();
    } finally {
        await assertNoSymlinks(
            path.dirname(directory),
            path.basename(directory),
        );
        await rm(directory, { recursive: true, force: true });
    }
}
