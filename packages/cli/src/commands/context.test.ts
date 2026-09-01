import { pathToFileURL } from "node:url";
import { CrafleetError } from "@crafleet/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as presentationOutput from "../presentation/output.js";
import { printError, printResult } from "../presentation/output.js";
import { CommandContext } from "./context.js";

const prompts = vi.hoisted(() => ({ confirm: vi.fn(), text: vi.fn() }));
vi.mock("@clack/prompts", () => ({
    ...prompts,
    isCancel: (value: unknown) => typeof value === "symbol",
}));
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalErrorTty = Object.getOwnPropertyDescriptor(
    process.stderr,
    "isTTY",
);
const originalCi = process.env.CI;
const originalExit = process.exitCode;
let context: CommandContext;
let command: Command;
beforeEach(() => {
    context = new CommandContext(
        pathToFileURL(`${process.cwd()}/packages/cli/dist/cli.mjs`).href,
    );
    command = new Command().option("--yes").option("--json");
    Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: true,
    });
    Reflect.deleteProperty(process.env, "CI");
    prompts.confirm.mockReset();
    prompts.text.mockReset();
});
afterEach(() => {
    if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (originalErrorTty)
        Object.defineProperty(process.stderr, "isTTY", originalErrorTty);
    else Reflect.deleteProperty(process.stderr, "isTTY");
    if (originalCi === undefined) Reflect.deleteProperty(process.env, "CI");
    else process.env.CI = originalCi;
    vi.restoreAllMocks();
    process.exitCode = originalExit;
});
describe("interactive CLI boundaries", () => {
    it.each([false, Symbol("cancel")])(
        "propagates cancellation to the shared signal without exiting the process",
        async (answer) => {
            prompts.confirm.mockResolvedValue(answer);
            await expect(
                context.ask(command, "Proceed?"),
            ).rejects.toMatchObject({ code: "CANCELLED", exitCode: 130 });
            expect(context.abort.signal.aborted).toBe(true);
        },
    );
    it("accepts confirmation, including explicit --yes without starting an interaction", async () => {
        prompts.confirm.mockResolvedValue(true);
        await context.ask(command, "Proceed?");
        expect(prompts.confirm).toHaveBeenCalledWith({
            message: "Proceed?",
            output: process.stderr,
        });
        command.setOptionValue("yes", true);
        await context.ask(command, "Proceed?");
        expect(prompts.confirm).toHaveBeenCalledTimes(1);
    });
    it("never prompts when JSON output was requested", async () => {
        command.setOptionValue("json", true);
        await expect(context.ask(command, "Proceed?")).rejects.toMatchObject({
            code: "CONFIRMATION_REQUIRED",
        });
        await expect(
            context.input(command, undefined, "Required"),
        ).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
        expect(prompts.confirm).not.toHaveBeenCalled();
        expect(prompts.text).not.toHaveBeenCalled();
    });
    it("accepts entered text and rejects whitespace without silently inventing a value", async () => {
        expect(await context.input(command, "provided", "Required")).toBe(
            "provided",
        );
        prompts.text.mockResolvedValue("entered");
        expect(await context.input(command, undefined, "Required")).toBe(
            "entered",
        );
        prompts.text.mockResolvedValue("  ");
        await expect(
            context.input(command, undefined, "Required"),
        ).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
        prompts.text.mockResolvedValue(Symbol("cancel"));
        await expect(
            context.input(command, undefined, "Required"),
        ).rejects.toMatchObject({ code: "CANCELLED" });
        expect(context.abort.signal.aborted).toBe(true);
    });
    it("accepts only an interactive terminal without JSON or --yes", () => {
        expect(() =>
            context.requireInteractiveInput(command, "Required"),
        ).not.toThrow();

        command.setOptionValue("json", true);
        expect(() =>
            context.requireInteractiveInput(command, "Required"),
        ).toThrowError(expect.objectContaining({ code: "INPUT_REQUIRED" }));
        command.setOptionValue("json", false);
        command.setOptionValue("yes", true);
        expect(() =>
            context.requireInteractiveInput(command, "Required"),
        ).toThrowError(expect.objectContaining({ code: "INPUT_REQUIRED" }));
        command.setOptionValue("yes", false);

        Object.defineProperty(process.stderr, "isTTY", {
            configurable: true,
            value: false,
        });
        expect(() =>
            context.requireInteractiveInput(command, "Required"),
        ).toThrowError(expect.objectContaining({ code: "INPUT_REQUIRED" }));
    });
    it.each(["1", "true", "yes", "on"])(
        "rejects CI environment value %s while treating CI=false as local",
        (value) => {
            process.env.CI = value;
            expect(() =>
                context.requireInteractiveInput(command, "Required"),
            ).toThrowError(expect.objectContaining({ code: "INPUT_REQUIRED" }));
            process.env.CI = "false";
            expect(() =>
                context.requireInteractiveInput(command, "Required"),
            ).not.toThrow();
        },
    );
    it("retains parent flags while combining repeatable filters", () => {
        const parent = new Command()
            .option("--cwd <path>")
            .option(
                "--filter <value>",
                "filter",
                (value: string, previous: string[]) => [...previous, value],
                [],
            );
        const child = parent
            .command("child")
            .option(
                "--filter <value>",
                "filter",
                (value: string, previous: string[]) => [...previous, value],
                [],
            );
        parent.setOptionValue("cwd", "parent");
        parent.setOptionValue("filter", ["a"]);
        child.setOptionValue("filter", ["b"]);
        expect(context.globals(child)).toEqual({
            cwd: "parent",
            filter: ["a", "b"],
        });
    });
});

describe("safe structured presentation", () => {
    it("passes only the nested command path and dry-run state to presentation", async () => {
        const program = new Command().name("crafleet").exitOverride();
        const child = program
            .command("plugins")
            .command("update [plugins...]")
            .option("--to <version>");
        context.action(child, async () => ({ completed: true }));
        const result = vi
            .spyOn(presentationOutput, "printResult")
            .mockImplementation(() => undefined);

        await program.parseAsync(
            ["plugins", "update", "LuckPerms", "--to", "private-version-value"],
            { from: "user" },
        );

        const presented = result.mock.calls.at(-1)?.[2];
        expect(presented).toEqual({
            command: "plugins update",
            dryRun: false,
        });
        expect(JSON.stringify(presented)).not.toContain("LuckPerms");
        expect(JSON.stringify(presented)).not.toContain(
            "private-version-value",
        );
    });

    it.each([true, false])(
        "omits untrusted raw exceptions and preserves known recovery hints (json=%s)",
        (json) => {
            let stdout = "";
            let stderr = "";
            vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
                stdout += String(chunk);
                return true;
            });
            vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
                stderr += String(chunk);
                return true;
            });
            const context = { command: "status", dryRun: false };
            printResult(undefined, json, context);
            expect(stdout).toBe("");
            printResult("ready", json, context);
            expect(stdout).toContain("ready");
            const unsafeText = "line\tvalue\n\u001b]52;c;payload\u0007\r";
            const beforeUnsafeText = stdout.length;
            printResult(unsafeText, json, context);
            expect(stdout.slice(beforeUnsafeText)).toBe(
                json
                    ? `${JSON.stringify({ ok: true, result: unsafeText })}\n`
                    : "line\tvalue\n?]52;c;payload??\n",
            );
            if (!json) {
                const unreadable = new Proxy(
                    {},
                    {
                        get() {
                            throw new Error("do-not-print-renderer-secret");
                        },
                    },
                );
                expect(() =>
                    printResult(unreadable, false, context),
                ).not.toThrow();
                expect(stdout).toContain(
                    "The operation may have completed in whole or in part, but its result could not be displayed safely.",
                );
                expect(stdout).not.toContain("do-not-print-renderer-secret");
            }
            printError(new Error("do-not-print-secret"), json);
            expect(stdout + stderr).not.toContain("do-not-print-secret");
            expect(process.exitCode).toBe(1);
            printError(
                new CrafleetError(
                    "RECOVERY_REQUIRED",
                    "Recover first.",
                    4,
                    "Run crafleet recover.",
                ),
                json,
            );
            expect(stdout + stderr).toContain("Run crafleet recover.");
            expect(process.exitCode).toBe(4);
            printError(
                new CrafleetError(
                    "INVALID_INPUT",
                    "unsafe\u001b]52;c;payload\u0007\u202e",
                    2,
                ),
                json,
            );
            if (!json) {
                expect(stdout + stderr).not.toContain("\u001b");
                expect(stdout + stderr).not.toContain("\u0007");
                expect(stdout + stderr).not.toContain("\u202e");
            }
            printError(new DOMException("input-hidden", "AbortError"), json);
            expect(process.exitCode).toBe(130);
            expect(stdout + stderr).toContain("CANCELLED");
            expect(stdout + stderr).not.toContain("input-hidden");
        },
    );
});
