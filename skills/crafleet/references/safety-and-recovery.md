# Safety, consent, and recovery

Read this reference before accepting the Minecraft EULA, stopping a server, applying pending changes, creating or applying a backup, pruning data, or recovering interrupted state.

## Authorization checklist

Before a mutation, identify:

1. the exact project directory or workspace members
2. current process state and whether downtime will occur
3. current active and pending installation
4. whether a verified backup repository is configured and reachable
5. which external data roots or databases are in the recovery unit
6. the specific user authorization for consent, deletion, downtime, or restoration

`--yes` only confirms an operation the user already authorized. It does not remove safety checks and must not be added merely to make an automation pass. A direct request for the exact downtime, deploy, restore, prune, or repository mutation is already authorization; ask only when the consequential action is not clearly covered.

## Minecraft EULA

Crafleet never treats a general request to set up a server as legal consent.

For Paper:

- On fresh `init`, an interactive terminal shows an `eula.txt` preview and agreement URL, then defaults to Decline.
- The same UI can appear at `start`, `run`, or `restart` if acceptance is still required.
- `--yes` on one of those commands records consent only when the user explicitly authorized acceptance after reading `https://www.minecraft.net/eula`.
- There is no separate launch-confirmation flag: `--yes` on `start`, `run`, or `restart` can also become fresh EULA consent. Do not add it merely to prevent an unknown prompt.
- CI, JSON output, and non-interactive sessions fail fresh consent unless that explicit `--yes` is supplied.
- `--dry-run` never records consent or writes `runtime/eula.txt`.
- `install` and `deploy apply` do not accept the EULA.
- Velocity does not use this flow.
- A valid per-user receipt is stored at `CRAFLEET_HOME/eula.json`, under `~/.crafleet` by default. Do not forge or edit it.
- At launch, Crafleet writes `runtime/eula.txt` only after the server is stopped. It never rewrites the file while Java is running.

If consent is declined or uncertain, stop. Do not retry with `--yes`.

## Running files and deployment

Never overwrite or unlink a JAR used by a running server. Crafleet downloads to its shared content-addressed cache, prepares pending, stops the server cleanly, backs up when required, and copies the verified installation into runtime.

The safe order is:

```text
preflight
-> graceful stop
-> verified process exit
-> runtime configuration recheck
-> cold backup
-> artifact/config placement
-> launch
-> startup confirmation
```

A stop timeout is not permission to force-kill. If process identity is ambiguous, preserve `unknown` and investigate. Do not remove a process lock based only on a PID.

After a new installation has launched once, do not automatically put only the old JAR back. Data migrations may already have occurred. Use an explicit snapshot recovery plan.

## Configuration and secrets

Do not overwrite runtime changes that have not been captured. Use `config diff`; capture or resolve conflicts before install/deploy.

Never print, commit, or copy secret values into pending metadata, conflict artifacts, command logs, or an answer. Register an `env` or private `file` reference and keep `${secret:NAME}` in Git-managed templates. Treat runtime and restored files as secret-bearing.

Do not broadly track `plugins/**/*.yml`; plugin directories contain data and credentials as well as configuration. Select intended files.

## Backup repository and selection

A backup destination must be the explicitly registered path. Verify its canonical path, repository ID, permissions, capacity, and that it is outside the source/staging tree. If a NAS or mount is absent, do not create a new repository at the now-empty mount point or redirect elsewhere.

The default selection excludes reproducible JARs, including custom JARs. Keep old custom artifacts retrievable through their original `file:` source or shared cache if restoration may need them. Do not add all downloads to backups as a workaround.

Symlink targets are not followed. External data needs explicit roots and restore mappings. Shared databases require all writers in one stopped recovery group; Crafleet cannot guarantee consistency for writers it does not manage.

If backup fails after shutdown, leave the server stopped. A successful cold backup resumes only previously running members with the same active installation, even if pending exists.

## Restore and deletion

`backup restore` must target an empty separate directory. Inspect the extracted metadata and files before `backup apply`.

`backup apply` is destructive: it stops the selected recovery unit, creates a pre-restore snapshot, applies only verified mapped data and the snapshot's active installation, clears pending, and does not auto-start. It leaves current desired YAML and the shared lock unchanged, so desired and restored active may intentionally differ. Confirm exact snapshot, project/group identity, external-root maps, database IDs, and destination before proceeding. Inspect the result, then use `start --active` when the user wants the restored installation started.

`backup prune` and `cache prune` are previews unless `--apply` is explicitly authorized. Never infer retention deletion from a request to inspect space.

## Interrupted operations

When Crafleet reports `RECOVERY_REQUIRED` or `BUSY`:

1. stop issuing unrelated start/apply commands
2. inspect `crafleet doctor`
3. confirm the selected Java processes and server state
4. run `crafleet recover --dry-run`
5. explain the proposed recovery and obtain authorization
6. run `crafleet recover`
7. re-run `validate`, `doctor`, and `status`

Do not manually delete `.crafleet` journals, locks, or partially applied files. Do not claim that a failed SQL restore was rolled back automatically; Crafleet records the pre-restore snapshot and requires deliberate database recovery.

## Reporting

A trustworthy completion report includes:

- selected project(s) and operation
- whether Java was stopped, started, or left unchanged
- active and pending outcome
- snapshot ID when a backup was created
- any server left stopped or in `unknown`
- recovery action still required

Never report completion from a dry run, queued plan, spawned process, or successful intermediate command.
