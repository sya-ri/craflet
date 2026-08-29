---
name: craflet
description: Set up, inspect, operate, update, back up, restore, or troubleshoot Paper and Velocity servers managed by Craflet. Use for craflet.yaml and workspace declarations, server and plugin artifacts, pending deployment, configuration capture, secrets, restic backups, EULA consent, and recovery; do not use for unmanaged Docker, OS-service, SSH, or Forge/Fabric workflows.
license: MIT
---

# Craflet

Operate reproducible Paper and Velocity projects with the Craflet CLI on the server host. Keep declarations and reviewed configuration in Git while Craflet owns downloaded artifacts, pending deployment state, process control, and verified backups.

## Scope

Craflet does not establish SSH connections. Connect to the host through the user's existing remote-access method, then run Craflet there.
Do not replace Craflet with direct edits to its lock, `.craflet/` state, running JARs, or restic metadata.
Do not add Docker, systemd, Windows services, Java installation, Forge/Fabric management, or automatic Git operations unless the user separately requests them.

## Workflow

1. Establish the target before mutation:
   - locate `craflet.yaml` or `craflet-workspace.yaml`
   - identify the intended project or workspace filter
   - inspect `craflet status`, `craflet validate`, and relevant command help
2. Read [project-files.md](references/project-files.md) before creating or changing declarations, sources, configuration tracking, secrets, or backup selection.
3. Read [operations.md](references/operations.md) for the workflow being performed.
4. Read [safety-and-recovery.md](references/safety-and-recovery.md) before EULA consent, downtime, deployment, backup application, pruning, or recovery.
5. Prefer `--dry-run` for supported mutations and `--json` for machine-readable inspection. Treat a zero-project workspace selection as an error, not a no-op.
6. Execute only the operation the user authorized. Re-read status and report the resulting desired, pending, active, process, and backup state that matters to the request.

Use the installed CLI's `--help` as the source of truth when its version differs from these references.

## Essential model

- **Desired** is `craflet.yaml` plus `craflet-lock.yaml`.
- **Pending** is a fully acquired and verified installation prepared for a future apply.
- **Active** is the installation currently deployed in `runtime/`.
- `plugins` and `server` show declared, locked, pending, and active artifacts without a provider lookup. Add `--latest` for provider status; use `plugins check` or `server check` for a nonmutating update report.
- `plugins add`, `plugins remove`, `plugins update`, `server update`, and `install` prepare pending state; they do not replace a running JAR.
- `start`, `run`, and `restart` may apply pending only after the required checks, stop, and backup. `--active` launches the current active installation.
- `console` opens with recent logs. PageUp or the mouse wheel loads older history, End returns to live output, and Ctrl-C detaches without stopping the server.
- Configuration templates under `config/` mirror paths under `runtime/`. Capture uses a three-way comparison and refuses unresolved conflicts.
- Backups select operating data, not reproducible downloads. JARs, logs, crash reports, libraries, and caches are excluded by default.

## Authorization boundaries

Never infer Minecraft EULA acceptance. A fresh Paper consent may be recorded only after the user explicitly agrees in the interactive UI or explicitly authorizes `--yes` for `init`, `start`, `run`, or `restart`.
Do not use `--yes` as a general safety bypass; it never removes preflight checks.
A direct user request for a specific downtime, deploy, restore, prune, or repository change is sufficient authorization for that operation. If the request does not clearly cover the consequential action, ask before executing it; do not broaden authorization from an adjacent task.

## Output expectations

State which host directory and projects were selected, whether the action was inspection or mutation, and whether pending or active changed.
For failures, preserve Craflet's error code and recovery hint, do not expose secret values, and do not claim success from a submitted command alone.
