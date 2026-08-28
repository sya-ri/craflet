import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

function execute(args, stdio = ["ignore", "ignore", "inherit"]) {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", args, { stdio, windowsHide: true });
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
    });
}
export async function containerClient(mode) {
    const id = process.env.CRAFLET_TEST_DATABASE_CONTAINER;
    const kind = process.env.CRAFLET_TEST_DATABASE_KIND;
    assert(
        process.env.CI === "true",
        "Container client wrappers are only for isolated CI services.",
    );
    assert(
        /^[a-f0-9]{12,64}$/.test(id ?? ""),
        "A dedicated CI database container ID is required.",
    );
    assert(["mysql", "mariadb"].includes(kind));
    assert(
        /^craflet_test_[a-z0-9_]+$/.test(
            process.env.CRAFLET_TEST_DATABASE_NAME ?? "",
        ),
    );
    const command =
        mode === "dump"
            ? kind === "mysql"
                ? "mysqldump"
                : "mariadb-dump"
            : kind === "mysql"
              ? "mysql"
              : "mariadb";
    const token = randomUUID();
    const credentials = `/tmp/craflet-ci-${token}.cnf`;
    const result = `/tmp/craflet-ci-${token}.sql`;
    let localResult;
    let copiedCredentials = false;
    const args = [];
    try {
        for (const arg of process.argv.slice(2)) {
            if (arg.startsWith("--defaults-file=")) {
                copiedCredentials = true;
                assert.equal(
                    await execute([
                        "cp",
                        arg.slice("--defaults-file=".length),
                        `${id}:${credentials}`,
                    ]),
                    0,
                );
                assert.equal(
                    await execute(["exec", id, "chmod", "600", credentials]),
                    0,
                );
                args.push(`--defaults-file=${credentials}`);
            } else if (arg.startsWith("--result-file=")) {
                localResult = arg.slice("--result-file=".length);
                args.push(`--result-file=${result}`);
            } else args.push(arg);
        }
        // The production adapter still uses actual matching database clients.
        // Only the CI transport enters the dedicated service container.
        const code = await execute(
            ["exec", "-i", id, command, ...args],
            ["inherit", "inherit", "inherit"],
        );
        if (code === 0 && localResult)
            assert.equal(
                await execute(["cp", `${id}:${result}`, localResult]),
                0,
            );
        process.exitCode = code;
    } finally {
        const files = [
            ...(copiedCredentials ? [credentials] : []),
            ...(localResult ? [result] : []),
        ];
        if (files.length)
            await execute(
                ["exec", id, "rm", "-f", "--", ...files],
                ["ignore", "ignore", "ignore"],
            );
    }
}
