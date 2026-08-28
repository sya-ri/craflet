import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    inspectOptionalPluginJar,
    inspectPluginJar,
} from "../../packages/adapters/src/formats/jar.js";
import {
    type ArtifactZipEntry,
    artifactBukkit,
    artifactZip,
} from "./artifacts-fixture.js";

describe("bounded plugin JAR inspection", () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(
            path.join(os.tmpdir(), "craflet-artifacts-jar-"),
        );
    });
    afterEach(async () => {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    async function fixture(entries: ArtifactZipEntry[]): Promise<string> {
        const file = path.join(directory, "plugin.jar");
        await writeFile(file, artifactZip(entries));
        return file;
    }

    it("reads Bukkit identity, aliases, and dependencies without inflating unrelated entries", async () => {
        const file = await fixture([
            {
                name: "large.class",
                content: Buffer.alloc(2_000_000),
                compress: true,
            },
            {
                name: "plugin.yml",
                content: `${artifactBukkit}depend: [Vault, Vault]\nsoftdepend: [Vault, LuckPerms]\nprovides: [Alias]\n`,
                compress: true,
            },
        ]);
        expect(
            await inspectPluginJar(file, { maxDescriptorBytes: 1024 }),
        ).toEqual({
            id: "Example",
            version: "1.0",
            format: "bukkit",
            apiVersion: "1.21",
            dependencies: ["Vault"],
            optionalDependencies: ["LuckPerms"],
            provides: ["Alias"],
        });
    });

    it("prefers Paper metadata and treats omitted required as true in both phases", async () => {
        const file = await fixture([
            { name: "plugin.yml", content: "invalid: [" },
            {
                name: "paper-plugin.yml",
                content: `${artifactBukkit}dependencies:\n  bootstrap:\n    Bootstrap: {}\n  server:\n    Vault:\n      required: true\n    Optional:\n      required: false\n`,
            },
        ]);
        expect(await inspectPluginJar(file)).toMatchObject({
            format: "paper",
            dependencies: ["Bootstrap", "Vault"],
            optionalDependencies: ["Optional"],
        });
    });

    it("does not fall back to valid Bukkit metadata after malformed Paper metadata", async () => {
        const file = await fixture([
            { name: "paper-plugin.yml", content: "name: broken\n" },
            { name: "plugin.yml", content: artifactBukkit },
        ]);
        await expect(inspectPluginJar(file)).rejects.toMatchObject({
            code: "INVALID_PLUGIN_DESCRIPTOR",
        });
    });

    it("recognizes Velocity and selects it for universal JARs on Velocity", async () => {
        const velocity = {
            id: "example",
            main: "example.Main",
            version: "2",
            dependencies: [
                { id: "required" },
                { id: "optional", optional: true },
            ],
        };
        let file = await fixture([
            { name: "velocity-plugin.json", content: JSON.stringify(velocity) },
        ]);
        expect(await inspectPluginJar(file)).toEqual({
            id: "example",
            version: "2",
            format: "velocity",
            dependencies: ["required"],
            optionalDependencies: ["optional"],
        });
        file = await fixture([
            { name: "plugin.yml", content: artifactBukkit },
            { name: "velocity-plugin.json", content: JSON.stringify(velocity) },
        ]);
        expect((await inspectPluginJar(file)).format).toBe("bukkit");
        expect(
            (await inspectPluginJar(file, { serverKind: "velocity" })).format,
        ).toBe("velocity");
    });

    it("allows unspecified Velocity versions and ordinary server JARs", async () => {
        let file = await fixture([
            {
                name: "velocity-plugin.json",
                content: JSON.stringify({ id: "example", main: "Main" }),
            },
        ]);
        expect(await inspectPluginJar(file)).toMatchObject({
            version: "unspecified",
            dependencies: [],
        });
        file = await fixture([
            { name: "nested/plugin.yml", content: artifactBukkit },
        ]);
        expect(await inspectOptionalPluginJar(file)).toBeUndefined();
        await expect(inspectPluginJar(file)).rejects.toMatchObject({
            code: "PLUGIN_DESCRIPTOR_MISSING",
        });
    });

    it.each([
        [
            [
                { name: "plugin.yml", content: artifactBukkit },
                { name: "plugin.yml", content: artifactBukkit },
            ],
            "DUPLICATE_PLUGIN_DESCRIPTOR",
        ],
        [
            [
                {
                    name: "plugin.yml",
                    content: `${artifactBukkit}name: Duplicate\n`,
                },
            ],
            "INVALID_PLUGIN_DESCRIPTOR",
        ],
        [
            [
                {
                    name: "plugin.yml",
                    content: "name: &x Example\nversion: *x\nmain: Main\n",
                },
            ],
            "INVALID_PLUGIN_DESCRIPTOR",
        ],
        [
            [
                {
                    name: "plugin.yml",
                    content: "name: ../escape\nversion: '1'\nmain: Main\n",
                },
            ],
            "INVALID_PLUGIN_DESCRIPTOR",
        ],
        [
            [{ name: "plugin.yml", content: "!!custom invalid\n" }],
            "INVALID_PLUGIN_DESCRIPTOR",
        ],
        [
            [{ name: "velocity-plugin.json", content: "{" }],
            "INVALID_PLUGIN_DESCRIPTOR",
        ],
        [
            [{ name: "velocity-plugin.json", content: "{}" }],
            "INVALID_PLUGIN_DESCRIPTOR",
        ],
        [
            [{ name: "plugin.yml", content: artifactBukkit, crc: 0 }],
            "INVALID_JAR",
        ],
        [
            [
                {
                    name: "plugin.yml",
                    content: artifactBukkit,
                    compress: true,
                    size: 1,
                },
            ],
            "INVALID_JAR",
        ],
        [
            [
                {
                    name: "plugin.yml",
                    content: artifactBukkit,
                    encrypted: true,
                    compress: true,
                },
            ],
            "JAR_DESCRIPTOR_LIMIT",
        ],
        [
            [{ name: "plugin.yml", content: Buffer.from([255, 255]) }],
            "INVALID_JAR",
        ],
        [[{ name: "../plugin.yml", content: artifactBukkit }], "INVALID_JAR"],
    ] as Array<[ArtifactZipEntry[], string]>)(
        "rejects unsafe or malformed metadata (%s)",
        async (entries, code) => {
            await expect(
                inspectPluginJar(await fixture(entries)),
            ).rejects.toMatchObject({ code });
        },
    );

    it("enforces descriptor and entry count limits", async () => {
        const file = await fixture([
            { name: "plugin.yml", content: artifactBukkit },
        ]);
        await expect(
            inspectPluginJar(file, { maxDescriptorBytes: 10 }),
        ).rejects.toMatchObject({ code: "JAR_DESCRIPTOR_LIMIT" });
        await expect(
            inspectPluginJar(file, { maxEntries: 0 }),
        ).rejects.toMatchObject({ code: "JAR_ENTRY_LIMIT" });
    });

    it("rejects an HTML download posing as a JAR", async () => {
        const file = path.join(directory, "html.jar");
        await writeFile(file, "<html>Cloudflare challenge</html>");
        await expect(inspectPluginJar(file)).rejects.toMatchObject({
            code: "INVALID_JAR",
        });
    });
});
