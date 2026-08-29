# Operational workflows

Use this reference to choose Craflet commands and preserve the desired, pending, and active model. Check the installed command's `--help` before relying on optional flags.

## Inspect before changing

From the project or workspace root:

```sh
craflet validate
craflet doctor
craflet status
craflet deploy plan
```

Use `--json` when the result will be parsed. Use `-C <directory>` instead of relying on an uncertain current directory. In a workspace, select explicitly with `-r` or `--filter`.

## Initialize or import

Create a new project:

```sh
craflet init survival --name survival --type paper --version 26.2
craflet -C survival install
craflet -C survival doctor
craflet -C survival start
```

For Paper, `init` may request Minecraft EULA consent. Read the authorization rules in [safety-and-recovery.md](safety-and-recovery.md) before interacting with that prompt or adding `--yes`.

Import copies a stopped server into a new project and leaves the source unchanged:

```sh
craflet import /srv/old-server /srv/craflet-server \
    --name survival \
    --type paper \
    --version 26.2 \
    --stopped
```

Inspect `craflet import --help`, confirm the source server is stopped, and keep the source until the imported project is verified.

## Resolve and stage artifacts

```sh
craflet plugins inspect ../build/MyPlugin.jar
craflet plugins add file:../build/MyPlugin.jar
craflet plugins
craflet server
craflet install
craflet plugins check
craflet server check
craflet plugins update MyPlugin
craflet deploy plan
```

- `plugins` and `server` show desired, locked, pending, and active artifact state without querying providers. Add `--latest` to either inventory when the latest provider version and update status are needed.
- `plugins add` and `plugins remove` update declarations and prepare pending. Removing a plugin leaves its data.
- `install` reproduces unchanged lock entries and resolves only changed declarations. `--frozen-lockfile` refuses missing or stale lock data.
- `plugins check [names...]` and `server check` only report provider updates.
- `plugins update [names...]` selects new plugin versions, updates declaration/lock state, and prepares pending; no names selects all declared plugins. `server update` does the same for the server artifact. Use `--to` only for an explicitly requested plugin version or server provider version/Paper build.
- None of these commands replaces a running JAR.

After reviewing pending, apply it with a managed start/restart or with stopped-only `deploy apply`:

```sh
craflet restart
# or, while stopped:
craflet deploy apply
```

`deploy apply` takes the required backup and does not start Java. `deploy discard` drops only pending; YAML and lock remain desired.

## Operate the server

| Command | Effect |
| --- | --- |
| `start` | Start a stopped server and apply verified pending when present. |
| `start --active` | Start the current active installation without applying pending. |
| `restart` | Gracefully stop, optionally apply pending after backup, then start. |
| `stop` | Gracefully stop and verify process exit; never apply pending. |
| `run` | Start and follow logs; Ctrl-C requests graceful stop. |
| `console` | Open with recent logs and command input; PageUp or the mouse wheel loads older history, End returns to live output, and Ctrl-C detaches without stopping the server. |
| `logs --follow` | Follow redacted logs; detaching does not stop the server. |
| `command <text>` | Send one command through the authenticated runner. |
| `status` | Report `running`, `stopped`, transitional state, or `unknown`. |

A timeout does not authorize force termination. Do not kill every Java process or trust a PID alone.

## Track configuration

Initial capture after the first server-generated files exist:

```sh
craflet config list --candidates
craflet config capture --initial
craflet config track plugins/MyPlugin/config.yml
craflet config diff
craflet config capture
craflet install
```

Register secret references before capture. Later capture compares base, prior observation, and runtime. If a conflict is reported, inspect it and resolve deliberately:

```sh
craflet config resolve plugins/MyPlugin/config.yml --use base
# or:
craflet config resolve plugins/MyPlugin/config.yml --use runtime
```

Pass exact runtime-relative paths to `config capture <paths...>` when the request concerns only particular plugin files. An existing selected runtime file is captured and becomes tracked; `config track <paths...>` is the explicit alternative when beginning tracking. Omitting paths captures all currently tracked files and may exceed a narrowly scoped request.

Run `install` after a base change or capture so the new configuration becomes pending. Deployment rechecks runtime immediately before applying and refuses to overwrite unreviewed changes.

## Configure and create backups

Use an absolute local or mounted path outside runtime and staging. The destination's parent must already exist. `--init` explicitly creates a new encrypted restic repository; omit it when registering an existing one.

```sh
craflet backup setup main \
  --path /mnt/backups/survival \
  --password-env CRAFLET_BACKUP_PASSWORD \
  --init
craflet backup plan
craflet backup create
craflet backup list
craflet backup check --read-data
```

Craflet verifies the repository and restic before stopping. A cold backup resumes only servers that were running, using the same active installation rather than pending. `--leave-stopped` prevents resume.

Inspect a snapshot before applying it:

```sh
craflet backup show <snapshot-id>
craflet backup restore <snapshot-id> --to /restore/survival
craflet backup apply /restore/survival --dry-run
craflet backup apply /restore/survival
```

`backup restore` requires one explicit snapshot ID of 8 to 64 lowercase hexadecimal characters. A phrase such as “yesterday” is not an ID and may match multiple snapshots or depend on timezone. Use `backup list --json` and `backup show <id> --json`, then have the operator or an explicit policy select one ID before extraction. `backup apply` takes the verified extraction directory produced by `backup restore`, not a snapshot ID.

`restore` extracts only into an empty separate directory. `apply` verifies it, stops the selected server group, takes a pre-restore backup, restores the snapshot's operating data and active installation, clears pending, and leaves Java stopped. The current desired YAML and shared lock remain unchanged. External roots and databases require explicit mappings/selections. After inspecting the restored state, use `craflet start --active` to launch that restored active installation; a later `install` may prepare the still-declared desired state again.

After an update or restore, collect `status`, `plugins`, `server`, relevant logs, `config diff`, and the application's actual health signal. “Looks bad” remains an operator decision unless the user supplies a concrete, observable rollback condition; do not invent one.

Pruning is preview-only unless explicitly applied:

```sh
craflet backup prune
craflet backup prune --apply
craflet cache prune
craflet cache prune --apply
```

## Workspace operations

```sh
craflet workspace list
craflet -r status
craflet --filter survival plugins check
```

Workspace operations have deterministic selection. Use all group members for shared backup/database production actions. Declaration preparation may target a subset, but a partial runtime result must be reported project by project.

## Diagnose and recover

```sh
craflet doctor
craflet recover --dry-run
craflet recover
```

Use recovery only when Craflet reports an interrupted journal or lock. Inspect the dry run and confirm the server state first. `recover --unlock` removes only locks belonging to ended operations; it does not terminate Java. Never delete journals manually to make an error disappear.

## Command groups

- Project: `init`, `import`, `workspace init/list`, `validate`, `doctor`
- Artifacts: `install`, `plugins [--latest]`, `plugins inspect/add/remove/check/update`, `server [--latest]`, `server check/update`
- Runtime: `start`, `restart`, `stop`, `status`, `command`, `logs`, `run`, `console`
- Deployment: `deploy plan/apply/discard`, `recover`
- Configuration: `config list/track/untrack/diff/capture/resolve`
- Backup: `backup setup/plan/create/list/show/diff/check/restore/apply/prune`
- Maintenance: `cache info/verify/prune`, `tools prepare restic`
