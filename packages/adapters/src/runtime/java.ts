import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
    CrafletError,
    type Diagnostic,
    javaRequirement,
    type ProjectManifest,
    parseJavaVersion,
} from "@craflet/core";

export async function javaExecutable(command = "java"): Promise<string> {
    if (path.isAbsolute(command)) {
        await access(command);
        return command;
    }
    if (command.includes("/") || command.includes("\\"))
        throw new CrafletError(
            "JAVA_PATH",
            "An explicit Java path must be absolute.",
            2,
        );
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
        for (const extension of process.platform === "win32"
            ? [".exe", ""]
            : [""]) {
            const candidate = path.resolve(
                directory,
                command.toLowerCase().endsWith(".exe")
                    ? command
                    : `${command}${extension}`,
            );
            try {
                await access(candidate);
                return candidate;
            } catch {
                /* Try the next PATH entry. */
            }
        }
    }
    throw new CrafletError(
        "JAVA_MISSING",
        "Java was not found. Install a compatible JDK or set java.command to its absolute path.",
        3,
    );
}

export async function inspectJava(
    manifest: ProjectManifest,
): Promise<{ executable?: string; major?: number; diagnostics: Diagnostic[] }> {
    const diagnostics: Diagnostic[] = [];
    try {
        const executable = await javaExecutable(manifest.java?.command);
        const env = { ...process.env };
        const injected = [
            "JAVA_TOOL_OPTIONS",
            "_JAVA_OPTIONS",
            "JDK_JAVA_OPTIONS",
        ];
        if (injected.some((name) => env[name]))
            diagnostics.push({
                id: "java.environment",
                status: "warn",
                message:
                    "Java option environment variables are present; values are hidden and excluded from the version probe.",
            });
        for (const name of injected) delete env[name];
        const { stdout, stderr } = await promisify(execFile)(
            executable,
            ["-version"],
            { env, timeout: 5000, maxBuffer: 65536, windowsHide: true },
        );
        const major = parseJavaVersion(`${stdout}\n${stderr}`);
        if (!major)
            return {
                executable,
                diagnostics: [
                    ...diagnostics,
                    {
                        id: "java.version",
                        status: "unknown",
                        required: true,
                        message: "Could not parse the Java version.",
                    },
                ],
            };
        diagnostics.push({
            id: "java.version",
            status: "pass",
            required: true,
            message: `Java ${major}: ${executable}`,
        });
        const requirement = javaRequirement(
            manifest.server.type,
            manifest.server.version,
        );
        if (requirement.minimum)
            diagnostics.push({
                id: "java.compatibility",
                status: major < requirement.minimum ? "fail" : "pass",
                required: true,
                message: `${manifest.server.type} ${manifest.server.version} requires Java ${requirement.minimum}+; selected ${major}.`,
            });
        else
            diagnostics.push({
                id: "java.compatibility",
                status: "unknown",
                message: requirement.recommended
                    ? `Java ${requirement.recommended} is recommended; the exact minimum for this build is not verified.`
                    : "No verified Java requirement is available for this server version.",
            });
        return { executable, major, diagnostics };
    } catch {
        return {
            diagnostics: [
                ...diagnostics,
                {
                    id: "java.probe",
                    status: "fail",
                    required: true,
                    message:
                        "Java is missing, inaccessible, or its bounded version probe failed.",
                    hint: "Set java.command to the absolute path of a compatible Java executable.",
                },
            ],
        };
    }
}
