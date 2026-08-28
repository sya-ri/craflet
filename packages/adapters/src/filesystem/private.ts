import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CrafletError } from "@craflet/core";
import { assertNoSymlinks } from "./io.js";

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

export async function ensurePrivateDirectory(directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    await assertNoSymlinks(absolute);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
        await chmod(absolute, 0o700);
        return;
    }
    try {
        const powershell = path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
        );
        await promisify(execFile)(
            powershell,
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
