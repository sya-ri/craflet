// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Secret tokens are deliberately literal fixture data, not JavaScript interpolation.
import { describe, expect, it } from "vitest";
import { parseConfigDocument } from "../formats/config.js";
import { ConfigSecrets, loadConfigSecrets } from "./secrets.js";

const password = 'fixture:p@ss\\word"\nnext';

describe("configuration secret handling", () => {
    it.each([
        ["settings.json", '{"password":"${secret:AUTH}","public":"ok"}\n'],
        ["settings.yml", 'password: "${secret:AUTH}" # keep\npublic: ok\n'],
        ["settings.toml", 'password = "${secret:AUTH}"\npublic = "ok"\n'],
        ["server.properties", "password=${secret:AUTH}\npublic=ok\n"],
    ])(
        "round-trips secrets through format-aware escaping in %s",
        (relative, template) => {
            const secrets = new ConfigSecrets(new Map([["AUTH", password]]));
            const injected = secrets.inject(relative, template);
            expect(parseConfigDocument(relative, injected).value).toMatchObject(
                { password, public: "ok" },
            );
            const tokenized = secrets.tokenize(relative, injected, [template]);
            expect(
                parseConfigDocument(relative, tokenized).value,
            ).toMatchObject({ password: "${secret:AUTH}", public: "ok" });
            expect(tokenized).not.toContain(password);
            expect(() =>
                secrets.assertTemplate(relative, tokenized),
            ).not.toThrow();
        },
    );

    it("blocks moved secrets and changed values at protected fields", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        const template = '{"database":{"password":"${secret:AUTH}"}}';
        expect(() =>
            secrets.tokenize("a.json", '{"elsewhere":"fixture-password"}', [
                template,
            ]),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.tokenize(
                "a.json",
                '{"database":{"password":"an-unknown-value"}}',
                [template],
            ),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.tokenize("a.json", '{"database":{"password":false}}', [
                template,
            ]),
        ).toThrow("unrecognized location");
        expect(secrets.tokenize("a.json", "{}", [template])).toBe("{}");
        expect(
            secrets.tokenize("a.json", '{"elsewhere":"fixture-password"}', [
                template,
                '{"elsewhere":"${secret:AUTH}"}',
            ]),
        ).toContain("${secret:AUTH}");
    });

    it("allows initial capture of known values and protects inline references", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        const captured = secrets.tokenize(
            "a.json",
            '{"url":"prefix:fixture-password:suffix"}',
        );
        expect(captured).toContain("prefix:${secret:AUTH}:suffix");
        expect(secrets.inject("a.json", captured)).toContain(
            "prefix:fixture-password:suffix",
        );
        expect(() =>
            secrets.tokenize("a.json", '{"url":"fixture-password"}', []),
        ).toThrow();
    });

    it("refuses cleartext in authored templates, keys, and comments", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        expect(() =>
            secrets.assertTemplate("a.json", '{"password":"fixture-password"}'),
        ).toThrow("resolved secret");
        expect(() =>
            secrets.assertTemplate(
                "a.json",
                '{"password":"fixture-\\u0070assword"}',
            ),
        ).toThrow("resolved secret");
        expect(() =>
            secrets.tokenize("a.json", '{"fixture-password":"public"}'),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.tokenize("a.yml", "# fixture-password\npublic: ok\n"),
        ).toThrow("unrecognized location");
        expect(() =>
            secrets.assertTemplate("a.yml", "# ${secret:AUTH}\npublic: ok\n"),
        ).toThrow("outside a supported string value");
    });

    it("blocks known server secrets even when no secret reference was declared", () => {
        const empty = new ConfigSecrets(new Map());
        for (const key of [
            "rcon.password",
            "management-server-secret",
            "management-server-tls-keystore-password",
        ]) {
            expect(() =>
                empty.tokenize(
                    "server.properties",
                    `${key}=unregistered-credential\n`,
                ),
            ).toThrow("resolved secret");
            expect(empty.tokenize("server.properties", `${key}=\n`)).toBe(
                `${key}=\n`,
            );
        }
        expect(() =>
            empty.tokenize(
                "config/paper-global.yml",
                "proxies:\n  velocity:\n    secret: unregistered-credential\n",
            ),
        ).toThrow("resolved secret");
        expect(() =>
            empty.tokenize("forwarding.secret", "unregistered-credential"),
        ).toThrow("resolved secret");
        expect(() =>
            empty.tokenize(
                "custom.txt",
                "-----BEGIN RSA PRIVATE KEY-----\nexample",
            ),
        ).toThrow("resolved secret");
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "registered-credential"]]),
        );
        expect(
            secrets.tokenize(
                "server.properties",
                "rcon.password=registered-credential\n",
            ),
        ).toContain("${secret:AUTH}");
        expect(secrets.inject("forwarding.secret", "${secret:AUTH}\n")).toBe(
            "registered-credential\n",
        );
    });

    it("fails closed for unfamiliar text when a secret moves to another line", () => {
        const secrets = new ConfigSecrets(
            new Map([["AUTH", "fixture-password"]]),
        );
        const template = "key=${secret:AUTH}\nother=public\n";
        expect(secrets.inject("a.conf", template)).toBe(
            "key=fixture-password\nother=public\n",
        );
        expect(
            secrets.tokenize(
                "a.conf",
                "key=fixture-password\nother=changed\n",
                [template],
            ),
        ).toBe("key=${secret:AUTH}\nother=changed\n");
        expect(() =>
            secrets.tokenize("a.conf", "other=public\nkey=fixture-password\n", [
                template,
            ]),
        ).toThrow();
    });

    it("rejects unresolved or malformed tokens without printing the input", () => {
        const secrets = new ConfigSecrets(new Map());
        for (const text of [
            '{"password":"${secret:MISSING}"}',
            '{"password":"${secret:bad name}"}',
        ]) {
            expect(() => secrets.assertTemplate("a.json", text)).toThrow(
                "placeholder",
            );
        }
        expect(secrets.redact("ordinary text")).toBe("ordinary text");
        expect(secrets.tokenize("a.txt", "ordinary text")).toBe(
            "ordinary text",
        );
        expect(
            new ConfigSecrets(new Map([["AUTH", "fixture-password"]])).redact(
                "error fixture-password",
            ),
        ).toBe("error [redacted]");
    });

    it("replaces overlapping values once without interpreting regex metacharacters", () => {
        const secrets = new ConfigSecrets(
            new Map([
                ["LONG", "fixture[a]+long"],
                ["SHORT", "fixture[a]+"],
            ]),
        );
        expect(secrets.tokenize("a.conf", "fixture[a]+long fixture[a]+")).toBe(
            "${secret:LONG} ${secret:SHORT}",
        );
    });

    it("rejects ambiguous and invalid secret definitions", () => {
        expect(
            () =>
                new ConfigSecrets(
                    new Map([
                        ["A", ""],
                        ["B", "x"],
                    ]),
                ),
        ).toThrow("nonempty");
        expect(
            () =>
                new ConfigSecrets(
                    new Map([
                        ["A", "same"],
                        ["B", "same"],
                    ]),
                ),
        ).toThrow("distinguishable");
        expect(
            () => new ConfigSecrets(new Map([["A", "${secret:B}"]])),
        ).toThrow();
        expect(
            () =>
                new ConfigSecrets(new Map([["bad name", "fixture-password"]])),
        ).toThrow();
        expect(
            () => new ConfigSecrets(new Map([["A", "x".repeat(65_537)]])),
        ).toThrow();
    });

    it("redacts multiline and escaped log fragments without treating partial lines as tokens", () => {
        const value = 'header[a]+\\key\r\n\r\n  secret-body"  \nfooter';
        const secrets = new ConfigSecrets(new Map([["KEY", value]]));
        for (const fragment of [
            "header[a]+\\key",
            'secret-body"',
            "footer",
            JSON.stringify(value).slice(1, -1),
        ]) {
            expect(secrets.redact(`log: ${fragment}`)).toBe("log: [redacted]");
        }
        expect(secrets.redact("public\n\ntext")).toBe("public\n\ntext");
        expect(secrets.tokenize("config.txt", "footer\n")).toBe("footer\n");
        const template = '{"key":"${secret:KEY}"}';
        expect(
            parseConfigDocument(
                "config.json",
                secrets.tokenize(
                    "config.json",
                    secrets.inject("config.json", template),
                    [template],
                ),
            ).value,
        ).toEqual({ key: "${secret:KEY}" });
    });

    it("loads explicit environment references and rejects missing or invalid ones", async () => {
        const secrets = await loadConfigSecrets(
            "unused",
            { AUTH: { env: "CRAFLET_TEST" } },
            { CRAFLET_TEST: "fixture-password" },
        );
        expect(secrets.inject("a.txt", "${secret:AUTH}")).toBe(
            "fixture-password",
        );
        await expect(
            loadConfigSecrets("unused", { AUTH: { env: "MISSING" } }, {}),
        ).rejects.toThrow("unavailable");
        await expect(
            loadConfigSecrets("unused", { AUTH: {} }, {}),
        ).rejects.toThrow("exactly one");
        await expect(
            loadConfigSecrets(
                "unused",
                { AUTH: { env: "VALUE", file: "file" } },
                {},
            ),
        ).rejects.toThrow("exactly one");
        await expect(
            loadConfigSecrets("unused", { AUTH: { env: "bad name" } }, {}),
        ).rejects.toThrow("exactly one");
    });
});
