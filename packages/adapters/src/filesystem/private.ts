import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CrafletError } from "@craflet/core";
import { assertNoSymlinks } from "./io.js";

const execFileAsync = promisify(execFile);

const privateDirectoryScript = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$existing = [System.IO.Directory]::GetAccessControl($env:CRAFLET_PRIVATE_DIRECTORY, [System.Security.AccessControl.AccessControlSections]::Owner)
$owner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier])
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
if ($owner.Value -ne $sid.Value) { $acl.SetOwner($sid) }
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($env:CRAFLET_PRIVATE_DIRECTORY, $acl)
`;

const ensurePrivateFileScript = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$existing = [System.IO.File]::GetAccessControl($env:CRAFLET_PRIVATE_FILE, [System.Security.AccessControl.AccessControlSections]::Owner)
$owner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier])
$acl = [System.Security.AccessControl.FileSecurity]::new()
if ($owner.Value -ne $sid.Value) { $acl.SetOwner($sid) }
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($env:CRAFLET_PRIVATE_FILE, $acl)
`;

const assertPrivateFileScript = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.IO.File]::GetAccessControl($env:CRAFLET_PRIVATE_FILE, [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value) { exit 7 }
if (-not $acl.AreAccessRulesProtected) { exit 11 }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$allowed = $false
foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid.Value) { exit 8 }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 9 }
    if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Read) -ne 0) { $allowed = $true }
}
if (-not $allowed) { exit 10 }
`;

function windowsPowerShell(): string {
    return path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    await assertNoSymlinks(absolute);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
        if (process.platform === "darwin") {
            try {
                await execFileAsync("/bin/chmod", ["-N", absolute], {
                    timeout: 15000,
                    maxBuffer: 4096,
                    env: { ...process.env, LC_ALL: "C" },
                });
            } catch {
                throw new CrafletError(
                    "PRIVATE_DIRECTORY",
                    "Could not remove extended access rules from the managed directory.",
                    3,
                );
            }
        }
        await chmod(absolute, 0o700);
        return;
    }
    try {
        await execFileAsync(
            windowsPowerShell(),
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(privateDirectoryScript, "utf16le").toString(
                    "base64",
                ),
            ],
            {
                windowsHide: true,
                timeout: 15000,
                maxBuffer: 4096,
                env: { ...process.env, CRAFLET_PRIVATE_DIRECTORY: absolute },
            },
        );
    } catch {
        throw new CrafletError(
            "PRIVATE_DIRECTORY",
            "Could not restrict the managed directory to the current user.",
            3,
        );
    }
}

async function privateFileStats(absolute: string): Promise<Stats> {
    await assertNoSymlinks(absolute);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new CrafletError(
            "PRIVATE_FILE",
            "The managed private file is not a singly linked regular file.",
            3,
        );
    return info;
}

function samePrivateFile(before: Stats, after: Stats): boolean {
    return (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.nlink === after.nlink
    );
}

async function assertPrivateFileIdentity(
    absolute: string,
    before: Stats,
): Promise<void> {
    if (!samePrivateFile(before, await privateFileStats(absolute)))
        throw new CrafletError(
            "PRIVATE_FILE",
            "The managed private file changed while its access was being inspected.",
            3,
        );
}

export async function ensurePrivateFile(file: string): Promise<void> {
    const absolute = path.resolve(file);
    const before = await privateFileStats(absolute);
    try {
        if (process.platform === "win32")
            await execFileAsync(
                windowsPowerShell(),
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-EncodedCommand",
                    Buffer.from(ensurePrivateFileScript, "utf16le").toString(
                        "base64",
                    ),
                ],
                {
                    windowsHide: true,
                    timeout: 15000,
                    maxBuffer: 4096,
                    env: { ...process.env, CRAFLET_PRIVATE_FILE: absolute },
                },
            );
        else {
            if (process.platform === "darwin")
                await execFileAsync("/bin/chmod", ["-N", absolute], {
                    timeout: 15000,
                    maxBuffer: 4096,
                    env: { ...process.env, LC_ALL: "C" },
                });
            await chmod(absolute, 0o600);
        }
    } catch {
        throw new CrafletError(
            "PRIVATE_FILE",
            "Could not restrict the managed file to the current user.",
            3,
        );
    }
    await assertPrivateFileIdentity(absolute, before);
    await assertPrivateFile(absolute);
}

export async function assertPrivateFile(file: string): Promise<void> {
    const absolute = path.resolve(file);
    const info = await privateFileStats(absolute);
    if (process.platform !== "win32") {
        const currentUser = process.getuid?.();
        if (
            (currentUser !== undefined && info.uid !== currentUser) ||
            (info.mode & 0o077) !== 0
        )
            throw new CrafletError(
                "PRIVATE_FILE",
                "The managed private file is not owned exclusively by the current user.",
                3,
            );
        if (process.platform === "darwin") {
            try {
                const { stdout } = await execFileAsync(
                    "/bin/ls",
                    ["-lde", absolute],
                    {
                        timeout: 15000,
                        maxBuffer: 64 * 1024,
                        env: { ...process.env, LC_ALL: "C" },
                    },
                );
                if (/^\s*\d+:/m.test(String(stdout)))
                    throw new Error("Extended ACL present");
            } catch {
                throw new CrafletError(
                    "PRIVATE_FILE",
                    "The managed private file has extended access rules or cannot be inspected safely.",
                    3,
                );
            }
        }
    } else
        try {
            await execFileAsync(
                windowsPowerShell(),
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-EncodedCommand",
                    Buffer.from(assertPrivateFileScript, "utf16le").toString(
                        "base64",
                    ),
                ],
                {
                    windowsHide: true,
                    timeout: 15000,
                    maxBuffer: 4096,
                    env: { ...process.env, CRAFLET_PRIVATE_FILE: absolute },
                },
            );
        } catch {
            throw new CrafletError(
                "PRIVATE_FILE",
                "The managed private file is not owned exclusively by the current user.",
                3,
            );
        }
    await assertPrivateFileIdentity(absolute, info);
}
