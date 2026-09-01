# Crafleet

Manage Paper and Velocity server JARs, plugins, configuration, and backups. Keep your intended setup in Git, capture changes made by the server, and apply updates during a managed start or restart.

Crafleet runs on the server host and targets Linux, Windows, and macOS. Automatic restic setup supports Linux x64/arm64, macOS x64/arm64, and Windows x64; restic-backed backup operations are unavailable on other architectures in this release. For remote servers, install Crafleet on that host and connect with your usual SSH client.

## See setup, console control, and plugin updates in action

![Crafleet terminal demo showing Paper initialization, server and plugin installation, recent console logs and history, backup setup, a pending plugin update, and restart-time deployment](https://raw.githubusercontent.com/sya-ri/crafleet/master/docs/assets/crafleet-demo.gif)

The demo follows a first install, opens the interactive console with recent logs, loads older history, runs `list`, and detaches while Paper keeps running. It then stages and applies a LuckPerms update during restart.

## Installation

You need **Node.js 24, 25, or 26** and the Java version required by your server. Use the latest patch release available for your selected Node.js major. Make Java available on `PATH`, or set an absolute `java.command` in `crafleet.yaml`. Crafleet does not install Java, establish SSH connections, or register OS services.

Install the CLI globally:

```sh
npm install --global crafleet
crafleet --help
```

Or use `npx crafleet --help` without a global installation. The examples below use `crafleet`; you can use `npx crafleet` instead.

## Set up your first server

Create a Paper project, resolve its server JAR, add a plugin, and start the managed server:

```sh
crafleet init my-server --name survival --type paper --version 26.2 --yes
cd my-server
crafleet install
crafleet plugins add modrinth:luckperms
crafleet server
crafleet plugins
crafleet doctor
crafleet start
crafleet status
```

`init` creates the project without starting Java. When the destination is inside a Git worktree, it creates or extends `.gitignore` for `runtime/`, `shared-data/`, `.crafleet/`, `imports/`, `.env`, and `.env.*`; outside Git it leaves `.gitignore` untouched. `install` resolves the declared server and plugin artifacts into `crafleet-lock.yaml` and the shared cache. `plugins add` downloads the plugin, reads its identity from the JAR descriptor, records the source, and prepares a pending installation. `server` and `plugins` show declared, locked, pending, and active artifact state without querying providers. `start` copies the complete pending installation into the runtime before it launches Java. Commands print concise, human-readable summaries by default; add `--json` when a script needs structured output.

Paper requires acceptance of the [Minecraft EULA](https://www.minecraft.net/eula); after reading it, pass `--yes` to `init`, `start`, `run`, or `restart` to record consent. In a plain interactive terminal outside CI, omit `--yes` and avoid `--json` and `--dry-run` to see the proposed `eula.txt` and agreement link, then choose Agree or Decline; CI, non-interactive, and JSON runs require `--yes`, while `--dry-run` never records consent. Consent is remembered for the current OS user and Crafleet home; Velocity does not use this flow.

A pristine standalone server does not need a backup repository for its first start. Applying pending changes to an existing installation or runtime data requires a configured, usable [backup repository](#backups).

Already have a server? Stop it first. `crafleet import --help` explains how to copy it into a new project while leaving the original files unchanged.

## Update a plugin safely

After [setting up backups](#backups), check for a new plugin release and prepare it while the current JAR keeps running:

```sh
crafleet plugins check LuckPerms
crafleet plugins update LuckPerms
crafleet plugins
crafleet deploy plan
crafleet restart
crafleet plugins
```

`plugins check` only reports upstream releases. `plugins update` changes the declaration and lock, downloads and verifies the new JAR, and records it as pending. It does not replace the JAR under `runtime/plugins` or change the version currently loaded by the server. `plugins` shows the requested source alongside locked, pending, and active versions so you can review the transition.

Artifact inventory and provider lookup are separate so a normal status view does not require network access:

| Command | Purpose |
| --- | --- |
| `crafleet plugins` | Show declared, locked, pending, and active plugin versions. |
| `crafleet plugins --latest` | Add each provider's latest eligible version and update status to the plugin inventory. |
| `crafleet plugins check [names...]` | Report provider updates for named plugins, or all declared plugins when no names are given. |
| `crafleet plugins update [names...]` | Select and prepare updates for named plugins, or all declared plugins when no names are given; `--to` requires one name. |
| `crafleet server` | Show the declared, locked, pending, and active server artifact. |
| `crafleet server --latest` | Add the provider's latest eligible version and update status to the server inventory. |
| `crafleet server check` | Report the latest server artifact without changing declarations or runtime files. |
| `crafleet server update` | Select and prepare the latest server artifact; use `--to` for an explicit provider version or Paper build. |

On `restart`, Crafleet verifies prerequisites, gracefully stops the server, takes a cold backup, applies the pending installation, and starts the new active version. Run `plugins update` and `server update` separately when you want both kinds of update, or use `restart --active` to restart without applying pending changes.

### Everyday commands

| Command | Purpose |
| --- | --- |
| `crafleet status` | Check the managed process. |
| `crafleet logs --follow` | Follow its logs. |
| `crafleet console` | Open a full-screen interactive console with recent log history and command input. |
| `crafleet stop` | Request shutdown and verify that Java exits. |
| `crafleet restart` | Restart, applying prepared changes when present. |
| `crafleet run` | Start and stay attached to the logs. |

Ctrl-C in `run` requests a graceful shutdown. `console` starts at the latest output, with recent logs already visible; PageUp or the mouse wheel scrolls back and lazily loads older history, and End returns to live output. Ctrl-C detaches from `console` without stopping the server. Interrupting `logs --follow` also leaves it running. Timeouts do not automatically force termination; an unidentifiable process is reported as `unknown`.

## Project files

| Path | What it contains |
| --- | --- |
| `crafleet.yaml` | Server, plugin, Java, secret-reference, and backup settings. |
| `crafleet-lock.yaml` | Resolved versions, sources, sizes, and SHA-256 hashes. |
| `config/` | Base configuration to review and keep in Git. |
| `runtime/` | Working server files, worlds, and plugin data. |
| `.crafleet/` | Local installation state, pending changes, and recovery journals. |

Keep the declarations, lock, and reviewed base configuration in Git. Keep runtime data, local state, and actual secrets out of Git. Crafleet does not automatically commit or push.

## Choose plugin sources

`plugins add` reads the plugin's name from `plugin.yml` or `paper-plugin.yml`, or its ID from `velocity-plugin.json`. It does not execute the JAR. Use `crafleet plugins inspect ../build/MyPlugin.jar` to inspect a local JAR first; `crafleet plugins` shows the names to use in later commands.

Run `crafleet plugins add` without a source to open the interactive Modrinth browser for one selected project. It starts with popular compatible plugins and searches as you type. Use Tab or the arrow keys to move through results, Space to select the latest compatible release, and Right Arrow to choose an exact version; press `a` in the version list to include beta and alpha releases. Enter opens the review screen and Enter again confirms the exact versions, while Esc goes back and Ctrl-C cancels without changing the project.

The browser needs an online interactive terminal outside CI and is unavailable with `--json`, `--yes`, `--offline`, or a multi-project selection. Scripts and workspace-wide operations should continue to pass one or more explicit sources. `crafleet plugins add --dry-run` may search and select versions online, but it does not download JARs or change the cache, declaration, lock, pending installation, or running server. After a normal confirmation, Crafleet still downloads each selected JAR and verifies its real descriptor identity and platform compatibility before recording anything.

Supported source forms:

```text
modrinth:<project>@<version>
spigotmc:<resource-id>@<version>
hangar:<project>@<version>
github:<owner>/<repo>@<tag>#<asset-name>
file:../build/MyPlugin.jar
file:../build/MyPlugin-*.jar
```

Omit `@<version>` for a provider when you want its latest eligible release, as in `modrinth:luckperms`. The lock always records the exact resolved source and hash. Plugin version labels are treated as opaque provider values rather than assumed to be SemVer.

A local glob must match exactly one file. Relative paths are based on the directory containing `crafleet.yaml`. Structured YAML such as `{ provider: file, path: ../build/MyPlugin.jar }` is also supported. If a provider requires unsupported authentication, an external download, or restricted distribution, Crafleet explains the limitation and directs you to `file:`.

`install` reproduces existing server and plugin lock entries; `install --frozen-lockfile` refuses missing or outdated entries. `plugins update` selects new plugin versions and also imports changed local JARs. `server update` selects a new server provider version or Paper build. Routine server updates do not change the declared Minecraft version. A plugin identity change is rejected rather than silently renamed.

### Pending and active installations

**Active** is the deployed installation. **Pending** is the prepared set of JARs and configuration for a later deployment. `plugins add`, `plugins remove`, `plugins update`, `server update`, and `install` prepare pending changes without replacing running JARs.

`start`, `run`, and `restart` apply pending changes by copying files after confirming shutdown, rechecking configuration, and taking the required backup. `--active` uses the current active installation without applying pending changes. `deploy apply` requires a stopped server and leaves it stopped; `deploy discard` discards pending changes. Removing a plugin does not delete its stored data.

## Configuration and secrets

`config/` mirrors paths under `runtime/`; per-file mappings in `crafleet.yaml` are unnecessary:

```text
config/server.properties             -> runtime/server.properties
config/config/paper-global.yml       -> runtime/config/paper-global.yml
config/plugins/MyPlugin/config.yml   -> runtime/plugins/MyPlugin/config.yml
```

**Register secrets before capturing files that contain them.** Paper can generate `management-server-secret` in `runtime/server.properties` even when its management server is disabled. Before the initial capture, securely copy that exact value into a private file outside Git and register its path, for example:

```yaml
secrets:
    PAPER_MANAGEMENT_SECRET:
        file: /private/paper-management-secret
```

Use a private path appropriate for your host; the file should contain only the secret value. An `env: ENVIRONMENT_VARIABLE_NAME` reference is also supported, provided the variable is available whenever Crafleet needs it. **Crafleet does not automatically load `.env` files.**

Captured values become `${secret:NAME}` references. Pending state, diffs, and observation baselines also use references. Known server secret fields with unregistered plaintext values are rejected, but Crafleet cannot discover every plugin's secret fields. Review files before committing. The runtime and restored data can contain real secrets and must remain protected.

After registering the necessary secrets, capture configuration deliberately:

```sh
crafleet config list --candidates
crafleet config capture --initial
crafleet config track plugins/MyPlugin/config.yml
crafleet config diff
crafleet config capture
crafleet install
```

Initial capture considers existing standard server files, operator lists, and whitelists. Ban lists require `--include-bans`. Arbitrary plugin YAML is not automatically tracked; configuration commands operate on one project at a time.

Capture compares the base configuration, its previous observation, and the current runtime. Conflicting files are left unchanged. Review a conflict before choosing `config resolve <path> --use base` or `--use runtime`. After editing or capturing the base, run `install` to prepare it for deployment. If runtime files change after preparation, applying the pending installation is refused until you review and prepare again.

Unchanged files retain their original text. Managed configuration is not run through a source formatter. Comments in modified TOML files are not currently preserved.

## Backups

Backups use encrypted restic repositories in an explicitly registered local directory or mounted NAS location. Choose an absolute destination outside the runtime and staging directories, with an existing parent. For a new repository, the destination must be empty or absent.

Crafleet downloads and verifies a pinned official restic build on Linux x64/arm64, macOS x64/arm64, and Windows x64. Other architectures can preview file selection with `crafleet backup plan`, but operations that create, inspect, prune, or restore restic snapshots are unavailable. Artifact and configuration commands, plus lifecycle operations that do not require a safety backup, remain available when the Node.js and Java requirements are met.

Set `CRAFLEET_BACKUP_PASSWORD` securely in your environment before these commands, or use `--password-file` with a private file. Only the reference is saved, so it must remain available in later sessions. Replace the example paths with paths on your host, such as `C:\Backups\survival` on Windows.

```sh
crafleet backup setup main --path /mnt/backups/survival --password-env CRAFLEET_BACKUP_PASSWORD --init
crafleet backup plan
crafleet backup create
crafleet backup list
crafleet backup check --read-data
```

Omit `--init` when registering an existing repository. Crafleet checks the registered path and repository ID; a missing destination does not silently redirect backups or initialize an empty NAS mount point. It prepares and verifies restic before stopping the server.

A cold backup stops the server, saves the selected data, then resumes only servers that were previously running, using the same active installation. It never applies pending updates. Use `backup create --leave-stopped` to keep the server stopped. Failed checks before shutdown leave it running; a failed backup after shutdown leaves it stopped.

Edit the generated `backup.files` list to select data. Patterns are relative to `crafleet.yaml`: normal patterns include, `!` patterns exclude, and the last match wins. Use a later normal pattern to re-include files; `!!` and `.gitignore` are not used. Defaults include runtime and shared data while excluding all JARs, including custom JARs, plus logs and downloaded caches. Symlinks are not followed; external data needs explicit inclusion.

SQLite can be declared under `backup.databases` with `id`, `kind: sqlite`, and `path`. MySQL and MariaDB also need connection settings, a password reference, and matching dump/client commands. They support InnoDB tables only and require `sslCa` for connections outside loopback. You must stop any database writers that Crafleet does not manage.

### Restore safely

First extract a snapshot into a separate empty directory. Inspect it before applying it to the server:

```sh
crafleet backup restore <snapshot-id> --to /restore/survival
crafleet backup apply /restore/survival --dry-run
crafleet backup apply /restore/survival
```

`apply` verifies the files and targets, stops the server, and takes a backup before replacing data. It restores the snapshot's active installation, leaves the server stopped, and clears pending. Current YAML declarations and the shared lock remain unchanged, so the requested and restored active versions may differ. Inspect the result and use `crafleet start --active` to launch the restored installation. Additional data roots require `--map root-id=absolute-path`; database restores require `--database id`.

JARs are recovered from the cache or source with the exact hash recorded for the snapshot. **Keep older custom JARs retrievable.** If an old cached JAR was deleted and its `file:` source was replaced, restoration is rejected before shutdown rather than substituting newer bytes.

`backup prune` and `cache prune` preview deletions by default; deletion requires `--apply`. Cache pruning protects registered locks, active and pending installations, and operations in progress. The shared JAR cache lives under `~/.crafleet/cache/artifacts/sha256/`; set `CRAFLEET_HOME` to use another home directory.

## Multiple servers

Group independent projects in `crafleet-workspace.yaml`:

```yaml
schemaVersion: 1
projects:
    - servers/*
```

Each server has its own `crafleet.yaml` and versions, with one shared workspace lock. Use `workspace list`, `-r` to select all projects, or `--filter <name-or-path-pattern>` to select a subset. An empty selection is an error.

```sh
crafleet workspace list
crafleet -r status
crafleet --filter survival plugins check
```

If servers share a database, assign the same `backup.group` to every writer in the workspace. Matching database, repository, and retention settings are required. The group stops all members before taking one snapshot; shared data and databases are restored only once.

Select every group member for `start`, `restart`, `deploy apply`, `backup create`, and `backup apply`, and configure the group's backup repository before its first start. `install`, `plugins update`, and `server update` may prepare only a subset. Restoring into a separate directory does not alter the live servers. Partial runtime failures are reported per server rather than hidden.

## Troubleshooting and recovery

`validate` checks declarations and managed metadata. `doctor` diagnoses Java, configuration, runtime state, and backup prerequisites without starting the server or changing files. It cannot fully validate every plugin's configuration.

If deployment or restoration is interrupted:

```sh
crafleet doctor
crafleet recover --dry-run
crafleet recover
```

Inspect the proposed recovery before applying it. `recover --unlock` removes only locks belonging to operations that have ended; it does not kill Java based solely on a PID. If an SQL restore fails partway through, Crafleet refuses automatic replay, records the earlier snapshot as `backupId` in the operation journal, and requires manual database recovery.

Use `--json` for structured automation output, `--dry-run` to preview changes, and `--offline` for artifact retrieval without network access. `--yes` confirms an explicitly requested operation but never bypasses safety checks. Run `crafleet --help` or a command's `--help` for its complete options.

## Agent skill

This repository includes a distributable Crafleet agent skill at `skills/crafleet`. It teaches compatible AI tools the project model, CLI workflows, update boundaries, backup rules, and recovery invariants.

Preview it with `gh skill`:

```sh
gh skill preview sya-ri/crafleet skills/crafleet
```

Or install only this skill with `npx skills`:

```sh
npx skills add sya-ri/crafleet --skill crafleet
```

Restart the agent tool after installation so it reloads available skills.

For release history, see [CHANGELOG.md](https://github.com/sya-ri/crafleet/blob/master/CHANGELOG.md). For contribution instructions, see [CONTRIBUTING.md](https://github.com/sya-ri/crafleet/blob/master/CONTRIBUTING.md).
