import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
    type ArtifactStore,
    CrafletError,
    portablePluginJarName,
    type ServerKind,
    validatePluginSet,
} from "@craflet/core";
import { hashBackupFile } from "./backup-files.js";
import { installProjects } from "./installations.js";
import {
    assertNoSymlinks,
    containedPath,
    exists,
    listFiles,
    writeJson,
} from "./io.js";
import { initProject, loadProject, writeYaml } from "./projects.js";

export async function importProject(
    sourceDir: string,
    targetDir: string,
    home: string,
    options: {
        name: string;
        kind: ServerKind;
        version: string;
        serverJar: string;
        dryRun?: boolean;
    },
    store: ArtifactStore,
): Promise<unknown> {
    const source = path.resolve(sourceDir);
    const target = path.resolve(targetDir);
    const overlap = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
                relative !== ".." &&
                !path.isAbsolute(relative))
        );
    };
    if (overlap(source, target) || overlap(target, source))
        throw new CrafletError(
            "IMPORT_OVERLAP",
            "The source and destination must be separate directory trees.",
            3,
        );
    await assertNoSymlinks(source);
    await assertNoSymlinks(target);
    if ((await exists(target)) && (await readdir(target)).length)
        throw new CrafletError(
            "IMPORT_TARGET",
            "Import requires an empty destination directory.",
            3,
        );
    if (await exists(path.join(source, ".craflet")))
        throw new CrafletError(
            "IMPORT_MANAGED",
            "Do not import an already managed server; use its project or a verified backup restore.",
            3,
        );
    if (
        path.isAbsolute(options.serverJar) ||
        path.win32.isAbsolute(options.serverJar)
    )
        throw new CrafletError(
            "IMPORT_SERVER",
            "The selected server JAR must be relative to the source directory.",
            2,
        );
    const serverRelative = path
        .relative(source, containedPath(source, options.serverJar))
        .replaceAll(path.sep, "/");
    const serverJar = await assertNoSymlinks(source, serverRelative);
    if (
        !(await lstat(serverJar)).isFile() ||
        !serverJar.toLowerCase().endsWith(".jar")
    )
        throw new CrafletError(
            "IMPORT_SERVER",
            "The selected server JAR must be an existing regular .jar file.",
            2,
        );
    const files = await listFiles(source);
    if (files.some((file) => /^plugins\/update\/.*\.jar$/i.test(file)))
        throw new CrafletError(
            "IMPORT_UPDATE",
            "Resolve the source server's plugins/update JARs before import.",
            3,
        );
    const plugins = [];
    for (const file of files.filter((file) =>
        /^plugins\/[^/]+\.jar$/i.test(file),
    )) {
        const identity = await store.inspect(path.join(source, file));
        plugins.push({
            file,
            identity,
            jarName: portablePluginJarName(identity.id),
        });
    }
    validatePluginSet(
        plugins.map((item) => item.identity),
        options.kind,
    );
    const serverSource = "file:imports/server/server.jar";
    await initProject(target, {
        name: options.name,
        kind: options.kind,
        version: options.version,
        source: serverSource,
        dryRun: true,
    });
    const copiedArtifacts = new Set([
        serverRelative,
        ...plugins.map((item) => item.file),
    ]);
    const copies = [
        ...files
            .filter((file) => !copiedArtifacts.has(file))
            .map((file) => ({ source: file, target: `runtime/${file}` })),
        { source: serverRelative, target: "imports/server/server.jar" },
        { source: serverRelative, target: "runtime/server.jar" },
        ...plugins.flatMap((plugin) => [
            {
                source: plugin.file,
                target: `imports/plugins/${plugin.jarName}`,
            },
            {
                source: plugin.file,
                target: `runtime/plugins/${plugin.jarName}`,
            },
        ]),
    ];
    const targets = new Set<string>();
    for (const copy of copies) {
        await assertNoSymlinks(target, copy.target);
        const key = copy.target.normalize("NFC").toLowerCase();
        if (targets.has(key))
            throw new CrafletError(
                "IMPORT_COLLISION",
                "Imported data and renamed JARs target the same path.",
                3,
            );
        targets.add(key);
    }
    for (const file of targets) {
        const segments = file.split("/");
        for (let index = 1; index < segments.length; index++)
            if (targets.has(segments.slice(0, index).join("/")))
                throw new CrafletError(
                    "IMPORT_COLLISION",
                    "Imported files collide with a target directory.",
                    3,
                );
    }
    if (options.dryRun)
        return {
            source,
            target,
            files: files.length,
            plugins: plugins.map((item) => item.identity.id),
            originalUnchanged: true,
        };
    const integrity = new Map<string, { sha256: string; bytes: number }>();
    for (const file of files)
        integrity.set(
            file,
            await hashBackupFile(await assertNoSymlinks(source, file)),
        );
    const manifest = await initProject(target, {
        name: options.name,
        kind: options.kind,
        version: options.version,
        source: serverSource,
    });
    const marker = await assertNoSymlinks(
        target,
        ".craflet/import-incomplete.json",
    );
    await writeJson(marker, { schemaVersion: 1, source, phase: "copying" });
    try {
        for (const copy of copies) {
            const destination = await assertNoSymlinks(target, copy.target);
            await mkdir(path.dirname(destination), { recursive: true });
            await copyFile(
                await assertNoSymlinks(source, copy.source),
                destination,
                constants.COPYFILE_EXCL,
            );
            const expected = integrity.get(copy.source);
            const actual = await hashBackupFile(destination);
            if (
                !expected ||
                expected.sha256 !== actual.sha256 ||
                expected.bytes !== actual.bytes
            )
                throw new CrafletError(
                    "IMPORT_CHANGED",
                    "A source file changed during import; the incomplete destination was retained for inspection.",
                    3,
                );
        }
        if (JSON.stringify(await listFiles(source)) !== JSON.stringify(files))
            throw new CrafletError(
                "IMPORT_CHANGED",
                "The source file set changed during import.",
                3,
            );
        for (const file of files)
            if (
                (await hashBackupFile(await assertNoSymlinks(source, file)))
                    .sha256 !== integrity.get(file)?.sha256
            )
                throw new CrafletError(
                    "IMPORT_CHANGED",
                    "A source file changed during import.",
                    3,
                );
        for (const { identity, jarName } of plugins)
            manifest.plugins[identity.id] = `file:imports/plugins/${jarName}`;
        await writeYaml(path.join(target, "craflet.yaml"), manifest);
        const installation = await installProjects(
            [await loadProject(target, home)],
            store,
            { offline: true },
        );
        await rm(marker);
        return {
            source,
            target,
            originalUnchanged: true,
            installation,
            next: "Configure a backup destination before starting the imported server. Capture selected configuration explicitly.",
        };
    } catch (error) {
        if (error instanceof CrafletError) throw error;
        throw new CrafletError(
            "IMPORT_INCOMPLETE",
            "Import did not complete. The original source was not modified, and the destination is blocked from starting; inspect it before retrying into an empty directory.",
            4,
        );
    }
}
