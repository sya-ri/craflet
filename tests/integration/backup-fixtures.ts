import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import type {
    BackupProcessRequest,
    BackupProcessResult,
    BackupProcessRunner,
} from "../../packages/adapters/src/restic/process.js";

const parent = await realpath(os.tmpdir());
const roots = new Set<string>();

export async function backupTestDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(parent, "crafleet-backup-test-"));
    roots.add(directory);
    return directory;
}

export async function cleanupBackupTestDirectories(): Promise<void> {
    for (const directory of roots) {
        if (
            path.dirname(directory) !== parent ||
            !path.basename(directory).startsWith("crafleet-backup-test-")
        )
            throw new Error("Unsafe test cleanup");
        await rm(directory, { recursive: true, force: true });
        roots.delete(directory);
    }
}

export async function writeBackupTestFile(
    root: string,
    relative: string,
    content: string | Uint8Array,
): Promise<string> {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { mode: 0o600 });
    return destination;
}

export const TEST_REPOSITORY_ID = "f".repeat(64);
export const FOREIGN_BACKUP_TEST_SID = "S-1-5-21-1-2-3-1001";

async function runAclTestScript(script: string, file: string): Promise<string> {
    if (
        process.platform !== "win32" ||
        ![...roots].some((root) => {
            const relative = path.relative(root, path.resolve(file));
            return (
                relative &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative)
            );
        })
    )
        throw new Error(
            "ACL tests are restricted to disposable Windows fixture paths",
        );
    const executable = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
    const result = await promisify(execFile)(
        executable,
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
            env: { ...process.env, CRAFLEET_TEST_ACL_PATH: file },
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 8192,
        },
    );
    return result.stdout;
}

export async function addForeignBackupTestAcl(file: string): Promise<void> {
    await runAclTestScript(
        `
$ErrorActionPreference = 'Stop'
$acl = [System.IO.File]::GetAccessControl($env:CRAFLEET_TEST_ACL_PATH)
$foreign = [System.Security.Principal.SecurityIdentifier]::new('${FOREIGN_BACKUP_TEST_SID}')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($foreign, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($env:CRAFLEET_TEST_ACL_PATH, $acl)
`,
        file,
    );
}

export async function restrictBackupTestAclToModify(
    directory: string,
): Promise<void> {
    await runAclTestScript(
        `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# Elevated runners can create fixture directories owned by Administrators.
# Establish the intended owner before removing WRITE_OWNER from the DACL.
$existing = [System.IO.Directory]::GetAccessControl($env:CRAFLEET_TEST_ACL_PATH)
if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
    $existing.SetOwner($sid)
    [System.IO.Directory]::SetAccessControl($env:CRAFLEET_TEST_ACL_PATH, $existing)
}
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Modify, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($env:CRAFLEET_TEST_ACL_PATH, $acl)
`,
        directory,
    );
}

export async function readWindowsBackupTestAcl(file: string): Promise<{
    ownerSid: string;
    currentSid: string;
    allowSids: string[];
    denySids: string[];
    protected: boolean;
}> {
    const output = await runAclTestScript(
        `
$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ([System.IO.Directory]::Exists($env:CRAFLEET_TEST_ACL_PATH)) { $acl = [System.IO.Directory]::GetAccessControl($env:CRAFLEET_TEST_ACL_PATH) } else { $acl = [System.IO.File]::GetAccessControl($env:CRAFLEET_TEST_ACL_PATH) }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$allow = [System.Collections.Generic.List[string]]::new()
$deny = [System.Collections.Generic.List[string]]::new()
foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { $allow.Add($rule.IdentityReference.Value) } else { $deny.Add($rule.IdentityReference.Value) }
}
[Console]::WriteLine($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)
[Console]::WriteLine($current)
[Console]::WriteLine($acl.AreAccessRulesProtected.ToString())
[Console]::WriteLine([String]::Join(',', $allow))
[Console]::WriteLine([String]::Join(',', $deny))
`,
        file,
    );
    const [
        ownerSid = "",
        currentSid = "",
        protectedValue = "",
        allow = "",
        deny = "",
    ] = output.split(/\r?\n/u);
    return {
        ownerSid,
        currentSid,
        protected: protectedValue === "True",
        allowSids: allow ? allow.split(",") : [],
        denySids: deny ? deny.split(",") : [],
    };
}

export interface BackupZipFixtureEntry {
    name: string;
    bytes: Buffer;
    compression?: 0 | 8;
    mode?: number;
    declaredSize?: number;
    flags?: number;
}

export function backupZipFixture(entries: BackupZipFixtureEntry[]): Buffer {
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const compressed =
            entry.compression === 8 ? deflateRawSync(entry.bytes) : entry.bytes;
        const size = entry.declaredSize ?? entry.bytes.length;
        const flags = entry.flags ?? 0x800;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(flags, 6);
        header.writeUInt16LE(entry.compression ?? 0, 8);
        header.writeUInt32LE(crc32(entry.bytes), 14);
        header.writeUInt32LE(compressed.length, 18);
        header.writeUInt32LE(size, 22);
        header.writeUInt16LE(name.length, 26);
        local.push(header, name, compressed);
        const record = Buffer.alloc(46);
        record.writeUInt16LE(3 * 256 + 20, 4);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(flags, 8);
        record.writeUInt16LE(entry.compression ?? 0, 10);
        record.writeUInt32LE(crc32(entry.bytes), 16);
        record.writeUInt32LE(compressed.length, 20);
        record.writeUInt32LE(size, 24);
        record.writeUInt16LE(name.length, 28);
        const mode =
            entry.mode ?? (entry.name.endsWith("/") ? 0o40700 : 0o100600);
        record.writeUInt32LE(
            ((mode << 16) | (entry.name.endsWith("/") ? 0x10 : 0)) >>> 0,
            38,
        );
        record.writeUInt32LE(offset, 42);
        central.push(record, name);
        offset += header.length + name.length + compressed.length;
    }
    const index = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(index.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, index, end]);
}

export class FixtureRestic {
    initialized = true;
    repositoryId = TEST_REPOSITORY_ID;
    backupExit = 0;
    restoreExit = 0;
    calls: BackupProcessRequest[] = [];
    snapshots = new Map<
        string,
        { files: Map<string, Buffer>; tags: string[] }
    >();
    treeExtra: unknown[] = [];
    lastId = "";
    nextResult:
        | ((
              request: BackupProcessRequest,
          ) =>
              | BackupProcessResult
              | undefined
              | Promise<BackupProcessResult | undefined>)
        | undefined;
    archiveTransform:
        | ((entries: BackupZipFixtureEntry[]) => BackupZipFixtureEntry[])
        | undefined;

    runner: BackupProcessRunner = async (request) => {
        this.calls.push(request);
        const injected = await this.nextResult?.(request);
        if (injected) return injected;
        const ok = (value: unknown): BackupProcessResult => ({
            exitCode: 0,
            stdout: typeof value === "string" ? value : JSON.stringify(value),
            stderr: "",
        });
        if (request.args[0] === "version") return ok({ version: "0.19.1" });
        const args = request.args.slice(3);
        const command = args[0];
        const repository = request.args[1];
        if (command === "cat")
            return this.initialized
                ? ok({ id: this.repositoryId })
                : { exitCode: 10, stdout: "", stderr: "no repo" };
        if (command === "init") {
            this.initialized = true;
            if (repository)
                await writeBackupTestFile(
                    repository,
                    "config",
                    "test repository",
                );
            return ok({ id: this.repositoryId, message_type: "initialized" });
        }
        if (command === "backup") {
            const files = new Map<string, Buffer>();
            for (const relative of Buffer.from(request.input ?? [])
                .toString("utf8")
                .split("\0")
                .filter(Boolean))
                files.set(
                    relative,
                    await readFile(path.join(request.cwd ?? "", relative)),
                );
            const id = createHash("sha256")
                .update(String(this.snapshots.size))
                .digest("hex");
            const tags = args.flatMap((argument, index) =>
                argument === "--tag" && args[index + 1]
                    ? [args[index + 1] as string]
                    : [],
            );
            this.snapshots.set(id, { files, tags });
            this.lastId = id;
            return {
                exitCode: this.backupExit,
                stdout: JSON.stringify({
                    message_type: "summary",
                    snapshot_id: id,
                }),
                stderr: this.backupExit ? "credential-should-not-appear" : "",
            };
        }
        if (command === "snapshots") {
            const tag = args[args.indexOf("--tag") + 1];
            return ok(
                [...this.snapshots]
                    .filter(([, snapshot]) => snapshot.tags.includes(tag ?? ""))
                    .map(([id, snapshot]) => ({
                        id,
                        short_id: id.slice(0, 8),
                        time: "2026-08-29T00:00:00.000Z",
                        tags: snapshot.tags,
                        paths: ["payload"],
                        hostname: "fixture",
                    })),
            );
        }
        if (command === "dump") {
            if (args[2] === "/" && args.includes("--archive")) {
                const snapshot = this.snapshots.get(args[1] ?? "");
                if (!request.outputFile || !snapshot)
                    throw new Error(
                        "Missing fixture archive destination or snapshot",
                    );
                const entries = [...snapshot.files].map(([name, bytes]) => ({
                    name,
                    bytes,
                }));
                const archive = backupZipFixture(
                    this.archiveTransform?.(entries) ?? entries,
                );
                await writeBackupTestFile(
                    path.dirname(request.outputFile),
                    path.basename(request.outputFile),
                    archive,
                );
                return { exitCode: this.restoreExit, stdout: "", stderr: "" };
            }
            const bytes = this.snapshots
                .get(args[1] ?? "")
                ?.files.get((args[2] ?? "").replace(/^\//u, ""));
            return bytes
                ? ok(bytes.toString("utf8"))
                : { exitCode: 1, stdout: "", stderr: "not found" };
        }
        if (command === "ls") {
            const snapshot = this.snapshots.get(args[1] ?? "");
            return ok(
                [
                    { struct_type: "snapshot" },
                    ...[...(snapshot?.files ?? [])].map(([file, content]) => ({
                        struct_type: "node",
                        type: "file",
                        path: `/${file}`,
                        size: content.length,
                    })),
                    ...this.treeExtra,
                ]
                    .map((item) => JSON.stringify(item))
                    .join("\n"),
            );
        }
        if (command === "forget")
            return ok([{ keep: [...this.snapshots.keys()], remove: [] }]);
        if (command === "check")
            return ok({ message_type: "summary", num_errors: 0 });
        if (command === "diff")
            return ok({ message_type: "statistics", added: { files: 1 } });
        throw new Error(`Unexpected restic fixture operation: ${command}`);
    };
}
