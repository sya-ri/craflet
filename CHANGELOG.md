# Changelog

All notable changes to Crafleet are documented in this file.

## Unreleased

### Fixed

- The published CLI now supports every Node.js 24 release by separating its runtime requirement from the newer Node.js version required by the development toolchain.

### Compatibility

- The published CLI supports Node.js 24, 25, and 26. Building Crafleet requires Node.js 24.11.1 or later because of its build dependencies and a config-loading bug in Node.js 24.11.0.

## 0.1.0 - 2026-08-30

### Added

- Declarative Paper and Velocity projects backed by `crafleet.yaml`, a SHA-256-pinned lock file, and optional multi-project workspaces.
- Server and plugin artifact resolution from Paper, Modrinth, Hangar, SpigotMC, GitHub Releases, and local JARs, with plugin identity read from Bukkit, Paper, and Velocity descriptors without executing the JAR.
- Separate pending and active installations so server and plugin updates can be prepared while a server is running, reviewed, and applied after the required safety backup during a managed start or restart.
- Cross-platform process control with graceful start, stop, restart, status, log following, and a scrollback console that detaches without stopping the server.
- Three-way configuration capture and conflict resolution, explicit secret references, tracked configuration inventories, and safe regeneration of pending installations.
- Encrypted restic backups and staged restores for files, SQLite databases, and InnoDB-only MySQL and MariaDB databases, including coordinated backup and recovery for groups of servers that share data.
- Existing-server import, deployment planning, diagnostics, interruption recovery, cache pruning, and offline artifact reuse.
- Human-readable command output alongside stable JSON output, dry-run previews, explicit confirmation, and per-project results for workspace operations.
- Remembered Minecraft EULA consent for Paper and automatic `.gitignore` entries when a project is created inside a Git worktree.
- A distributable `crafleet` agent skill covering project files, routine operations, safety boundaries, backups, and recovery.

### Fixed

- EULA consent files receive private permissions even when Crafleet runs from an elevated Windows account.
- Partial failures in multi-project commands retain and report the successful project results alongside the failures.

### Compatibility

- The CLI requires Node.js 24.20.0 or later and earlier than Node.js 27, and runs on Linux, Windows, and macOS with the Java version required by the selected server.
- Automatic restic setup supports Linux x64 and arm64, macOS x64 and arm64, and Windows x64. Other architectures can use artifact and configuration management but cannot run restic-backed backup operations in this release.

### Known limitations

- Crafleet does not install Java, establish SSH connections, or register operating-system services. It must be installed on each remote server host that it manages.
- Crafleet rejects known unregistered server secrets, but plugin-specific secret fields still require operator review before captured configuration is committed.
