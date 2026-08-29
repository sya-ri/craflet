import { describe, expect, it } from "vitest";
import { renderHumanResult } from "./human.js";

function render(command: string, result: unknown, dryRun = false): string {
    return renderHumanResult(result, {
        command,
        dryRun,
    });
}

function deploymentPlan(overrides: Record<string, unknown> = {}) {
    return {
        status: { status: "stopped", clean: true },
        active: "active-1",
        pending: "pending-2",
        plugins: ["Example"],
        configuration: ["server.properties"],
        recoveryRequired: false,
        ...overrides,
    };
}

describe("human CLI result presentation", () => {
    it("summarizes project creation without serializing the result", () => {
        const output = render("init", {
            directory: "/srv/minecraft/survival",
            name: "survival",
            server: { type: "paper", version: "26.2", build: "120" },
            next: "Review craflet.yaml, then run craflet install.",
        });

        expect(output).toContain(
            'Created Paper server "survival" at /srv/minecraft/survival.',
        );
        expect(output).toContain("Server version: 26.2 (build 120)");
        expect(output).not.toContain('"directory"');
        expect(output).not.toContain("{");
    });

    it("explains pending plugin changes and running-JAR safety", () => {
        const output = render(
            "plugins update",
            [
                {
                    project: "survival",
                    changed: true,
                    pendingId: "pending-id",
                    plugins: ["LuckPerms", "spark"],
                    warnings: [],
                    unresolved: [],
                },
            ],
            false,
        );

        expect(output).toContain(
            "Resolved updates and prepared 1 pending installation.",
        );
        expect(output).toContain(
            "survival: pending ready; declared plugins: LuckPerms, spark",
        );
        expect(output).toContain("Running JARs were not replaced.");
        expect(output).toContain("craflet restart");
        expect(output).not.toContain("pending-id");
    });

    it("reports server updates and plugin removal safety", () => {
        const unchanged = [
            {
                project: "survival",
                changed: false,
                plugins: ["LuckPerms"],
            },
        ];

        expect(render("server update", unchanged, true)).toContain(
            "0 of 1 selected project would receive a pending installation.",
        );
        expect(render("plugins remove", unchanged, true)).toContain(
            "Plugin data under runtime was left unchanged.",
        );
    });

    it("shows requested sources and versions while redacting local paths", () => {
        const output = render("plugins", [
            {
                project: "survival",
                plugins: [
                    {
                        name: "LuckPerms",
                        requested: "modrinth:luckperms@opaque-id",
                        requestedVersion: "v5.5.71-bukkit",
                        locked: "5.5.71",
                        active: "5.5.53",
                        pending: "5.5.71",
                    },
                    {
                        name: "LocalTools",
                        requested:
                            "file:C:/Users/alice/private-build/LocalTools.jar",
                        locked: "2.0",
                        active: null,
                        pending: "2.0",
                    },
                ],
            },
        ]);

        expect(output).toContain(
            "LuckPerms: requested modrinth@v5.5.71-bukkit | active 5.5.53 | pending 5.5.71 | locked 5.5.71",
        );
        expect(output).toContain(
            "LocalTools: requested local file | active - | pending 2.0 | locked 2.0",
        );
        expect(output).not.toContain("C:/Users/alice/private-build");
        expect(output).not.toContain("LocalTools.jar");
        expect(output).not.toContain("opaque-id");
    });

    it("uses provider display versions for update checks", () => {
        const output = render("plugins check", [
            {
                project: "survival",
                updates: [
                    {
                        kind: "provider",
                        name: "LuckPerms",
                        lockedVersion: "v5.5.53-bukkit",
                        latestSource: "modrinth:Vebnzrzj@b0mk8uS6",
                        latestVersion: "v5.5.71-bukkit",
                        updateAvailable: true,
                    },
                ],
            },
        ]);

        expect(output).toContain("1 update available.");
        expect(output).toContain(
            "LuckPerms: locked v5.5.53-bukkit -> latest v5.5.71-bukkit",
        );
        expect(output).not.toContain("b0mk8uS6");
    });

    it("renders latest plugin and server versions with scoped update hints", () => {
        expect(
            render("plugins", [
                {
                    project: "survival",
                    plugins: [
                        {
                            name: "LuckPerms",
                            requested: "modrinth:luckperms",
                            latest: "5.5.71",
                            status: "update-available",
                        },
                    ],
                },
            ]),
        ).toContain("latest 5.5.71 (update available)");
        expect(
            render("server", [
                {
                    project: "survival",
                    server: {
                        declared: { type: "paper", version: "1.21.11" },
                        requested: {
                            provider: "paper",
                            project: "paper",
                            version: "1.21.11",
                            build: "121",
                        },
                        locked: "120",
                        active: "120",
                        pending: null,
                        latest: "121",
                        status: "update-available",
                    },
                },
            ]),
        ).toContain(
            "requested paper 1.21.11 build 121 | locked 120 | active 120 | pending - | latest 121 (update available)",
        );
        const custom = render("server", [
            {
                project: "proxy",
                server: {
                    requested: {
                        provider: "github",
                        version: "v4",
                    },
                },
            },
            {
                project: "private",
                server: {
                    requested: {
                        provider: "file",
                        path: "C:/private/server.jar",
                    },
                },
            },
        ]);
        expect(custom).toContain("Server: requested github@v4");
        expect(custom).toContain("Server: requested local file");
        expect(custom).not.toContain("C:/private");
        expect(custom).not.toContain("server.jar");
        const local = render("server check", [
            {
                project: "survival",
                updates: [
                    {
                        kind: "local",
                        name: "server",
                        lockedVersion: "1.0",
                    },
                ],
            },
        ]);
        expect(local).toContain("craflet server update");
        expect(local).not.toContain("--server");
    });

    it("reports stop failures with their safe message", () => {
        const output = render("stop", [
            { project: "alpha", result: { status: "stopped" } },
            {
                project: "beta",
                ok: false,
                code: "STOP_TIMEOUT",
                message: "The server did not stop before the timeout.",
            },
        ]);

        expect(output).toContain("alpha: stopped");
        expect(output).toContain(
            "beta: failed [STOP_TIMEOUT]. The server did not stop before the timeout.",
        );
        expect(output).toContain("completed for 1 server; 1 failed");
        expect(output).not.toContain("Stopped 2 servers");
    });

    it("summarizes configuration differences without their contents", () => {
        const output = render("config diff", [
            {
                relative: "plugins/Example/config.yml",
                baseChanged: true,
                runtimeChanged: true,
                conflicts: ["/password"],
                base: "password: private-base",
                runtime: "password: private-runtime",
            },
        ]);

        expect(output).toContain("base changed, runtime changed, 1 conflict");
        expect(output).not.toContain("private-base");
        expect(output).not.toContain("private-runtime");
    });

    it("labels previews and does not claim a mutation", () => {
        const output = render(
            "install",
            [
                {
                    project: "survival",
                    changed: true,
                    plugins: ["Example"],
                    warnings: [],
                    unresolved: [],
                },
            ],
            true,
        );

        expect(output).toContain("would receive a pending installation");
        expect(output).toContain("changes planned");
        expect(output).not.toContain("pending ready");
    });

    it("sanitizes terminal controls and never dumps unknown fallback values", () => {
        expect(
            render("workspace list", [
                {
                    name: "safe\u001b[31m\u061c",
                    directory: "/srv/safe\u202evalue\u200f",
                },
            ]),
        ).toContain("safe?[31m?");
        expect(
            render("future command", { secret: "do-not-print-this-secret" }),
        ).toBe("Operation completed successfully.");
    });

    it("renders initialization and inspection variants", () => {
        expect(render("init", undefined, true)).toContain(
            "Project creation preview",
        );
        expect(
            render(
                "init",
                {
                    directory: "C:/servers/proxy",
                    name: "proxy",
                    server: { type: "velocity", version: "4.1.1" },
                },
                true,
            ),
        ).toContain('Would create Velocity server "proxy"');
        expect(render("plugins inspect", undefined)).toBe(
            "JAR inspection completed.",
        );
        expect(
            render("plugins inspect", {
                id: "ProxyPlugin",
                version: "2",
                format: "velocity",
                dependencies: ["required"],
            }),
        ).toContain("Required plugins: required");
        expect(
            render("plugins inspect", {
                id: "PaperPlugin",
                version: "3",
                format: "paper",
                dependencies: [],
            }),
        ).toContain("Descriptor: Paper");
    });

    it("renders install previews, unchanged projects, warnings, and removal safety", () => {
        const addPreview = render(
            "plugins add",
            {
                action: "add",
                projects: [],
                sources: ["file:C:/private-build/SecretPlugin.jar"],
            },
            true,
        );
        expect(addPreview).toContain("to the selected project");
        expect(addPreview).not.toContain("C:/private-build");
        expect(addPreview).not.toContain("SecretPlugin.jar");
        expect(render("install", [], true)).toContain(
            "No installation changes are planned",
        );
        expect(render("install", [])).toContain(
            "No installation changes were needed",
        );
        const unchanged = render("install", [
            {
                project: "alpha",
                changed: false,
                plugins: [],
                warnings: ["Review this warning"],
                unresolved: ["DeferredPlugin"],
            },
        ]);
        expect(unchanged).toContain("already up to date");
        expect(unchanged).toContain("Warning: Review this warning");
        expect(unchanged).toContain("Unresolved during preview");
        expect(
            render("plugins remove", [
                {
                    project: "alpha",
                    changed: true,
                    plugins: [],
                },
            ]),
        ).toContain("Plugin data under runtime was left unchanged");
    });

    it("renders empty and multi-project plugin states", () => {
        expect(render("plugins", [])).toBe("No projects were selected.");
        expect(
            render("plugins", [
                { project: "alpha", plugins: [] },
                {
                    project: "beta",
                    plugins: [],
                },
            ]),
        ).toContain("Plugins: none declared.");

        expect(render("plugins check", [])).toContain(
            "No plugins are declared",
        );
        const checked = render("plugins check", [
            {
                project: "alpha",
                updates: [
                    {
                        kind: "provider",
                        name: "A",
                        lockedVersion: "1",
                        latestVersion: "1",
                        latestSource: "github:o/r@v1#A.jar",
                        updateAvailable: false,
                    },
                    {
                        kind: "provider",
                        name: "B",
                        lockedVersion: "1",
                        latestVersion: "v2",
                        latestSource: "github:o/r@v2#B.jar",
                        updateAvailable: true,
                    },
                    {
                        kind: "local",
                        name: "--local-plugin",
                        lockedVersion: "3",
                    },
                ],
            },
        ]);
        expect(checked).toContain("A: locked 1 is the latest version");
        expect(checked).toContain("B: locked 1 -> latest v2");
        expect(checked).toContain("craflet plugins update -- --local-plugin");
    });

    it("renders scalar, recursive, empty, and real lifecycle plan states", () => {
        expect(render("status", undefined)).toContain("status is unavailable");
        expect(
            render("status", {
                status: "running",
                activeId: "active",
                pid: 10,
                clean: false,
            }),
        ).toContain("runner 10");
        expect(
            render("status", {
                status: "running",
                javaPid: 20,
                clean: true,
            }),
        ).toContain("runner unknown, Java 20");
        expect(
            render("stop", [
                { project: "alpha", ok: true, result: { status: "stopped" } },
                { project: "beta", ok: false, code: "STOP_TIMEOUT" },
                null,
            ]),
        ).toContain("beta: failed [STOP_TIMEOUT]");
        expect(render("start", [], true)).toContain(
            "No start operation is planned",
        );
        expect(render("start", [])).toContain("No server was started");
        expect(
            render("start", [
                {
                    project: "alpha",
                    result: { status: "running", javaPid: 3 },
                },
            ]),
        ).toContain("Started 1 server");
        const restartPreview = render(
            "restart",
            [
                {
                    project: "alpha",
                    result: deploymentPlan({
                        status: { status: "running", javaPid: 42 },
                        recoveryRequired: true,
                    }),
                },
            ],
            true,
        );
        expect(restartPreview).toContain(
            "Restart preview completed for 1 server. No lifecycle action was performed.",
        );
        expect(restartPreview).toContain("alpha: deployment preview");
        expect(restartPreview).toContain("Runtime: running");
        expect(restartPreview).toContain("Pending installation: pending-2");
        expect(restartPreview).toContain("Pending plugins (1): Example");
        expect(restartPreview).toContain(
            "Configuration (1): server.properties",
        );
        expect(restartPreview).toContain("Recovery required: yes");
        expect(render("restart", [{ project: "alpha", result: {} }])).toContain(
            "operation completed",
        );
    });

    it("flattens grouped lifecycle members into individual server rows", () => {
        const output = render(
            "start",
            [
                {
                    group: "network",
                    result: [
                        deploymentPlan(),
                        deploymentPlan({
                            active: "proxy-active",
                            pending: null,
                            plugins: [],
                            configuration: [],
                        }),
                    ],
                },
            ],
            true,
        );

        expect(output).toContain(
            "Start preview completed for 2 servers. No lifecycle action was performed.",
        );
        expect(output).toContain("network member 1: deployment preview");
        expect(output).toContain("network member 2: deployment preview");
        expect(output).toContain("Active installation: proxy-active");
        expect(output).not.toContain("Start preview for 1 server");
    });

    it("renders workspace, validation, and doctor outcomes", () => {
        expect(render("workspace list", [])).toContain("No workspace projects");
        expect(
            render("workspace list", [
                { name: "alpha", directory: "/srv/alpha" },
                { name: "beta", directory: "/srv/beta" },
            ]),
        ).toContain("2 workspace projects");
        expect(render("validate", [])).toContain("No projects were validated");
        expect(
            render("validate", [
                {
                    project: "alpha",
                    valid: false,
                    locked: false,
                    active: null,
                    pending: "pending",
                },
            ]),
        ).toContain("[FAIL] alpha: lock missing, active none, pending present");
        expect(render("doctor", [])).toContain("without diagnostics");
        expect(
            render("doctor", [
                [
                    {
                        status: "fail",
                        required: true,
                        message: "Java is missing",
                        hint: "Install Java",
                    },
                    { status: "warn", message: "Backup not configured" },
                ],
            ]),
        ).toContain(
            "1 failing check, 1 warning, and 0 optional unknown checks",
        );
        expect(
            render("doctor", [
                [{ status: "warn", message: "Optional warning" }],
            ]),
        ).toContain("completed with 1 warning and 0 optional unknown checks");
        expect(
            render("doctor", [[{ status: "pass", message: "Ready" }]]),
        ).toContain("passed 1 check");
    });

    it("renders configuration lists, captures, conflicts, and explicit choices", () => {
        expect(render("config list", [])).toContain(
            "No managed configuration files",
        );
        expect(
            render("config list", [
                { relative: "server.properties" },
                { relative: "ops.json" },
            ]),
        ).toContain("2 configuration files");
        expect(
            render(
                "config track",
                { action: "track", paths: ["server.properties"] },
                true,
            ),
        ).toContain("Would track 1 configuration file");
        expect(render("config track", [], true)).toContain(
            "No configuration files would be tracked",
        );
        expect(render("config track", [])).toContain(
            "No configuration files were added",
        );
        expect(render("config diff", [])).toContain(
            "No tracked configuration files",
        );
        expect(
            render("config diff", [
                {
                    relative: "ops.json",
                    baseChanged: false,
                    runtimeChanged: false,
                    conflicts: [],
                },
            ]),
        ).toContain("ops.json: unchanged");
        expect(
            render("config capture", {
                captured: [],
                unchanged: [],
                conflicts: [{ relative: "ops.json", paths: ["/0/name"] }],
            }),
        ).toContain("Capture stopped with 1 conflict");
        expect(
            render(
                "config capture",
                {
                    captured: ["server.properties"],
                    unchanged: ["ops.json"],
                    conflicts: [],
                },
                true,
            ),
        ).toContain("Would capture 1 configuration file; 1 unchanged");
        expect(
            render("config untrack", { untracked: ["ops.json"] }, true),
        ).toContain("Would stop tracking");
        expect(
            render(
                "config resolve",
                { path: "ops.json", resolution: "runtime" },
                true,
            ),
        ).toContain("Would resolve ops.json using the runtime version");
    });

    it("renders detailed backup selection, staging, databases, and warnings", () => {
        const output = render("backup plan", {
            roots: [
                {
                    id: "project",
                    path: "/srv/survival",
                    kind: "directory",
                    external: false,
                },
                {
                    id: "shared",
                    path: "/mnt/shared-data",
                    kind: "directory",
                    external: true,
                },
            ],
            files: [
                {
                    destination: "runtime/world/level.dat",
                    source: "/srv/survival/runtime/world/level.dat",
                    size: 1536,
                },
                {
                    destination: "shared-data/players.db",
                    source: "/mnt/shared-data/players.db",
                    size: 1024,
                },
            ],
            bytes: 2560,
            stagingBytes: 4096,
            databaseIds: ["main"],
            warnings: ["The shared root is external."],
        });

        expect(output).toContain("Backup plan: 2 files, 2.50 KiB, 1 database.");
        expect(output).toContain("Staging estimate: 4.00 KiB");
        expect(output).toContain(
            "shared: /mnt/shared-data (directory, external)",
        );
        expect(output).toContain(
            "runtime/world/level.dat <- /srv/survival/runtime/world/level.dat (1.50 KiB)",
        );
        expect(output).toContain("Databases: main");
        expect(output).toContain("Warning: The shared root is external.");
    });

    it("renders backup repositories, snapshots, checks, and restores", () => {
        expect(
            render("backup setup", {
                alias: "main",
                path: "/backup",
                id: "repository-id",
            }),
        ).toContain('Configured backup repository "main" at /backup.');
        expect(
            render("backup setup", { alias: "main", path: "/backup" }, true),
        ).toContain("Would configure");
        expect(render("backup list", [])).toContain("No snapshots were found");
        expect(
            render("backup list", [
                { id: "abcdef012345", time: "2026-08-29T00:00:00Z" },
            ]),
        ).toContain("abcdef012345");
        expect(
            render("backup show", {
                createdAt: "2026-08-29",
                projectId: "project",
                files: [{}],
                databases: [{}],
                active: { secret: "not-rendered" },
            }),
        ).not.toContain("not-rendered");
        expect(render("backup diff", [])).toContain("no reported differences");
        expect(
            render("backup diff", [{ message_type: "statistics" }]),
        ).toContain("no reported differences");
        expect(
            render("backup diff", [
                {
                    message_type: "change",
                    modifier: "M",
                    path: "runtime/world/level.dat",
                },
                { message_type: "statistics" },
            ]),
        ).toContain("1 backup difference");
        expect(render("backup check", { checked: true })).toContain("passed");
        expect(
            render("backup restore", {
                snapshotId: "abcdef01",
                target: "/restore",
            }),
        ).toContain("Restored snapshot");
        expect(
            render(
                "backup restore",
                {
                    snapshotId: "abcdef01",
                    target: "/restore",
                    requiredBytes: 1024 * 1024,
                },
                true,
            ),
        ).toContain("1.00 MiB required");
    });

    it("renders structured retention removals and their reasons", () => {
        const plan = [
            {
                remove: [
                    {
                        short_id: "abcdef012345",
                        time: "2026-08-01T00:00:00Z",
                        reasons: ["daily", "weekly"],
                    },
                    {
                        id: "1234567890abcdef",
                        time: "2026-07-01T00:00:00Z",
                        reasons: ["monthly"],
                    },
                ],
            },
        ];
        const preview = render("backup prune", { applied: false, plan });
        const applied = render("backup prune", { applied: true, plan });

        expect(preview).toContain(
            "Retention preview: 2 snapshots would be removed.",
        );
        expect(preview).toContain(
            "abcdef012345  2026-08-01T00:00:00Z (daily, weekly)",
        );
        expect(preview).toContain("craflet backup prune --apply");
        expect(applied).toContain(
            "Applied retention and pruned repository data; 2 snapshots removed.",
        );
    });

    it("renders completed and multi-recovery-unit backup creation", () => {
        expect(
            render("backup create", {
                resumed: true,
                backup: {
                    snapshotId: "abcdef0123456789",
                    fileCount: 1,
                    bytes: 0,
                },
            }),
        ).toContain("previously running server was resumed");
        expect(
            render("backup create", [
                {
                    project: "alpha",
                    result: {
                        resumed: false,
                        backup: {
                            snapshotId: "1234567890abcdef",
                            fileCount: 2,
                            bytes: 2048,
                        },
                    },
                },
            ]),
        ).toContain("2 files (2.00 KiB)");
        expect(render("backup create", {})).toContain(
            "Cold backup operation completed",
        );
    });

    it("renders project and group backup-create dry-run plans", () => {
        const output = render(
            "backup create",
            [
                {
                    project: "alpha",
                    result: {
                        roots: [
                            {
                                id: "project",
                                path: "/srv/alpha",
                                kind: "directory",
                                external: false,
                            },
                        ],
                        files: [
                            {
                                destination: "runtime/world/level.dat",
                                source: "/srv/alpha/runtime/world/level.dat",
                                size: 128,
                            },
                        ],
                        bytes: 128,
                        stagingBytes: 128,
                        databaseIds: [],
                        warnings: [],
                    },
                },
                {
                    group: "network",
                    result: {
                        roots: [
                            {
                                id: "shared",
                                path: "/srv/shared",
                                kind: "directory",
                                external: true,
                            },
                        ],
                        files: [
                            {
                                destination: "shared/players.db",
                                source: "/srv/shared/players.db",
                                size: 512,
                            },
                        ],
                        bytes: 512,
                        stagingBytes: 1024,
                        databaseIds: ["players"],
                        warnings: ["Shared database clients must be stopped."],
                    },
                },
            ],
            true,
        );

        expect(output).toContain("Backup plan for alpha: 1 file, 128 B");
        expect(output).toContain("Backup plan for network: 1 file, 512 B");
        expect(output).toContain("Databases: players");
        expect(output).toContain(
            "Warning: Shared database clients must be stopped.",
        );
        expect(output).not.toContain("server was stopped");
    });

    it("renders backup-apply unresolved checks and cleanup requirements", () => {
        const preview = render(
            "backup apply",
            {
                project: "alpha",
                files: ["runtime/world/level.dat"],
                databases: ["main"],
                changes: [
                    {
                        kind: "file",
                        target: "runtime/world/level.dat",
                        before: null,
                        after: "restored-hash",
                    },
                    {
                        kind: "database",
                        target: "main",
                        before: "old-dump",
                        after: "new-dump",
                    },
                ],
                unresolved: [
                    "Exact JAR cache availability is checked during apply.",
                ],
            },
            true,
        );
        const applied = render("backup apply", {
            group: "network",
            applied: true,
            preRestoreSnapshot: "abcdef0123456789",
            pendingDiscarded: true,
            cleanupRequired: "/srv/network/.craflet/restore-staging",
        });
        const groupPreview = render(
            "backup apply",
            {
                group: "network",
                databases: [],
                changes: [
                    {
                        kind: "file",
                        target: "proxy/runtime/config.toml",
                        before: "old-hash",
                        after: "new-hash",
                    },
                ],
            },
            true,
        );

        expect(preview).toContain(
            "Restore application preview for alpha: 1 file, 1 database, 2 planned changes.",
        );
        expect(preview).toContain("file create: runtime/world/level.dat");
        expect(groupPreview).toContain("group file changes are listed below");
        expect(groupPreview).not.toContain("0 files");
        expect(preview).toContain("database replace: main");
        expect(preview).toContain(
            "Still checked during apply: Exact JAR cache availability is checked during apply.",
        );
        expect(preview).toContain("No live data was changed.");
        expect(applied).toContain(
            "Applied verified restored data for network. The server remains stopped.",
        );
        expect(applied).toContain("Pre-restore snapshot: abcdef012345");
        expect(applied).toContain(
            "The previous pending installation was discarded.",
        );
        expect(applied).toContain(
            "Warning: temporary restore data still requires cleanup at /srv/network/.craflet/restore-staging.",
        );
    });

    it("renders cache verification, ignored entries, pruning, and warnings", () => {
        expect(
            render("cache info", {
                directory: "/cache",
                bytes: 0,
                entries: [],
            }),
        ).toContain("Cache contains 0 artifacts (0 B)");
        expect(
            render("cache verify", {
                directory: "/cache",
                bytes: 12 * 1024 * 1024,
                entries: [{ valid: false }],
                ignored: ["README.txt", "partial/download.tmp"],
            }),
        ).toContain("1 failed verification");
        const verified = render("cache verify", {
            directory: "/cache",
            bytes: 12 * 1024 * 1024,
            entries: [{ valid: false }],
            ignored: ["README.txt", "partial/download.tmp"],
        });
        expect(verified).toContain(
            "Ignored 2 unrecognized entries: README.txt, partial/download.tmp",
        );
        expect(
            render("cache prune", {
                applied: false,
                candidates: [{}],
                retained: 2,
                warnings: ["One cache entry is still in use."],
            }),
        ).toContain("1 unreferenced entry; 2 retained");
        expect(
            render("cache prune", {
                applied: false,
                candidates: [{}],
                retained: 2,
                warnings: ["One cache entry is still in use."],
            }),
        ).toContain("Warning: One cache entry is still in use.");
        expect(
            render("cache prune", {
                applied: true,
                candidates: [{}, {}],
                retained: 1,
            }),
        ).toContain("Removed 2 unreferenced cache entries");
    });

    it("renders import, workspace, command, discard, and tool outcomes", () => {
        expect(
            render(
                "import",
                {
                    source: "/old",
                    target: "/new",
                    files: 3,
                    plugins: ["Example"],
                },
                true,
            ),
        ).toContain("Selected 3 files and 1 plugin");
        expect(
            render("import", {
                source: "/old",
                target: "/new",
                next: "Configure a backup.",
            }),
        ).toContain("Next: Configure a backup");
        expect(
            render(
                "workspace init",
                { directory: "/srv", projects: ["servers/*"] },
                true,
            ),
        ).toContain("Would create workspace");
        expect(render("command", { sent: true })).toBe("Console command sent.");
        expect(render("command", { sent: false }, true)).toContain(
            "was not sent",
        );
        expect(
            render("deploy discard", { discarded: ["alpha", "beta"] }, true),
        ).toContain("Would discard pending installations for 2 projects");
        expect(render("tools prepare", { home: "/home" }, true)).toContain(
            "Would prepare restic",
        );
        expect(
            render("tools prepare", { path: "/restic", version: "0.19" }),
        ).toContain("Prepared restic 0.19");
        expect(render("console", {})).toContain("server was not stopped");
        expect(render("run", {})).toContain("session ended");
        expect(render("future command", {}, true)).toContain(
            "no changes were made",
        );
    });

    it("renders deployment plans and single or grouped apply results", () => {
        const plan = deploymentPlan({
            status: { status: "stopped", clean: true },
            recoveryRequired: true,
        });
        const planned = render("deploy plan", [{ project: "alpha", ...plan }]);
        const applyPreview = render(
            "deploy apply",
            [{ project: "alpha", result: plan }],
            true,
        );
        const groupApplied = render("deploy apply", [
            {
                group: "network",
                result: [
                    plan,
                    deploymentPlan({
                        active: "proxy-active",
                        pending: null,
                        plugins: [],
                        configuration: [],
                    }),
                ],
            },
        ]);

        expect(planned).toContain("Deployment preview for 1 project:");
        expect(planned).toContain("alpha: deployment preview");
        expect(planned).toContain("Runtime: stopped");
        expect(planned).toContain("Active installation: active-1");
        expect(planned).toContain("Pending installation: pending-2");
        expect(planned).toContain("Pending plugins (1): Example");
        expect(planned).toContain("Configuration (1): server.properties");
        expect(planned).toContain("Recovery required: yes");
        expect(applyPreview).toContain(
            "Deployment application preview for 1 recovery unit; runtime files were not changed.",
        );
        expect(applyPreview).toContain("alpha: deployment preview");
        expect(groupApplied).toContain(
            "Deployment application completed for 1 recovery unit. No server was started.",
        );
        expect(groupApplied).toContain("network member 1: deployment state");
        expect(groupApplied).toContain("network member 2: deployment state");
    });

    it("renders recovery dry-run rows and their planned work", () => {
        const output = render(
            "recover",
            [
                {
                    project: "alpha",
                    declarations: true,
                    restore: false,
                    recovered: true,
                },
                {
                    group: "network",
                    restore: true,
                    recovered: false,
                },
                {
                    project: "beta",
                    declarations: false,
                    restore: false,
                    recovered: false,
                },
            ],
            true,
        );

        expect(output).toContain(
            "Recovery preview produced 3 project/group reports; 2 would require work.",
        );
        expect(output).toContain(
            "alpha: would recover declarations, deployment.",
        );
        expect(output).toContain("network: would recover restore.");
        expect(output).toContain("beta: no recovery needed.");
        expect(output).not.toContain("recovery unit");
        expect(output).not.toContain("Recovered interrupted state");
        expect(render("recover", [])).toBe(
            "No interrupted operation required recovery.",
        );
    });

    it("keeps successful batch results visible beside later failures", () => {
        const deployResults = [
            { project: "alpha", result: deploymentPlan() },
            {
                project: "beta",
                ok: false,
                code: "DEPLOY_FAILED",
                message: "Apply failed safely.",
            },
        ];
        const deploy = render("deploy apply", deployResults);
        const deployPreview = render("deploy apply", deployResults, true);
        expect(deploy).toContain("alpha: deployment state");
        expect(deploy).toContain(
            "Deployment application completed for 1 recovery unit; 1 failed. No server was started.",
        );
        expect(deployPreview).toContain(
            "Deployment application preview: 1 recovery unit could be applied; 1 failed. Runtime files were not changed.",
        );
        expect(deployPreview).toContain("alpha: deployment preview");
        expect(deploy).toContain(
            "beta: failed [DEPLOY_FAILED]. Apply failed safely.",
        );

        const discarded = render("deploy discard", [
            { discarded: ["alpha"] },
            {
                group: "network",
                ok: false,
                code: "DISCARD_FAILED",
                message: "Recovery is required.",
            },
        ]);
        expect(discarded).toContain("Completed: alpha");
        expect(discarded).toContain("network: failed [DISCARD_FAILED]");

        const recovered = render("recover", [
            { project: "alpha", declarations: true, recovered: false },
            {
                group: "network",
                ok: false,
                code: "RECOVERY_FAILED",
                message: "Inspect the journal.",
            },
        ]);
        expect(recovered).toContain(
            "Recovery produced 1 successful project/group report",
        );
        expect(recovered).toContain("network: failed [RECOVERY_FAILED]");

        const backup = render("backup create", [
            {
                project: "alpha",
                result: {
                    backup: {
                        snapshotId: "abcdef0123456789",
                        fileCount: 2,
                        bytes: 1024,
                    },
                    resumed: false,
                },
            },
            {
                group: "network",
                ok: false,
                code: "BACKUP_FAILED",
                message: "Repository unavailable.",
            },
        ]);
        expect(backup).toContain("alpha: Created cold backup abcdef012345");
        expect(backup).toContain("network: failed [BACKUP_FAILED]");
    });

    it("renders run and console dry-runs without claiming a start or attachment", () => {
        const consolePreview = render(
            "console",
            { status: "running", javaPid: 42, activeId: "active-1" },
            true,
        );
        const runPreview = render(
            "run",
            deploymentPlan({ status: { status: "stopped", clean: true } }),
            true,
        );

        expect(consolePreview).toContain(
            "Console preview; no terminal was attached.",
        );
        expect(consolePreview).toContain("Server: running");
        expect(consolePreview).toContain("Java 42");
        expect(runPreview).toContain(
            "Run preview; the server was not started.",
        );
        expect(runPreview).toContain("Server: deployment preview");
        expect(runPreview).toContain("Pending installation: pending-2");
        expect(runPreview).not.toContain("The foreground server session ended");
    });
});
