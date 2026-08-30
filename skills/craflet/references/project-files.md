# Project files and declarations

Read this reference before creating or editing a Craflet project, workspace, artifact source, configuration template, secret reference, or backup selection.

## Layout and ownership

A standalone server has one `craflet.yaml`. A workspace has `craflet-workspace.yaml` at its root and one `craflet.yaml` per server.

`craflet init` creates or extends `.gitignore` only when the destination is already inside a Git worktree. The generated rules cover `runtime/`, `shared-data/`, `.craflet/`, `imports/`, `.env`, and `.env.*`. It does not initialize Git, commit files, or touch `.gitignore` outside Git.

| Path | Ownership |
| --- | --- |
| `craflet.yaml` | User-reviewed desired server, plugin, Java, secret-reference, and backup settings. |
| `craflet-lock.yaml` | Craflet-resolved artifact versions, locations, sizes, and SHA-256 hashes. Commit it; do not edit it by hand. |
| `config/` | Git-managed base configuration whose relative paths mirror `runtime/`. |
| `runtime/` | Live server files, worlds, plugin data, databases, and deployed JAR copies. |
| `.craflet/` | Local active, pending, observations, locks, and recovery journals. Do not commit or edit it manually. |
| `~/.craflet/` | Default shared home for the content-addressed artifact cache, tools, repository registry, runner, and EULA receipt. Override only with `CRAFLET_HOME`. |

Relative source, secret-file, database, and backup patterns are resolved from the directory containing the relevant `craflet.yaml`, unless a command requires an absolute path.

## Minimal declaration

Let `craflet init` create the initial file when possible. A representative declaration is:

```yaml
schemaVersion: 1
name: survival
server:
    type: paper
    version: "26.2"
    build: latest
java:
    command: java
    args:
        - -Xms2G
        - -Xmx4G
plugins: {}
backup:
    files:
        - runtime/**
        - shared-data/**
        - "!**/*.[jJ][aA][rR]"
        - "!runtime/logs/**"
        - "!runtime/crash-reports/**"
        - "!runtime/libraries/**"
        - "!runtime/cache/**"
        - "!runtime/versions/**"
```

Project names contain only letters, digits, dot, underscore, and dash. Server type is `paper` or `velocity`. Use the Minecraft version for Paper and the proxy version for Velocity. Routine `server update` does not silently change this declared version.

`java.command` may be an executable on `PATH` or an absolute path. Craflet diagnoses Java but does not install it.

## Artifact sources

Compact source syntax:

```text
modrinth:<project>@<version>
spigotmc:<resource-id>@<version>
hangar:<project>@<version>
github:<owner>/<repo>@<tag>#<asset-name>
file:../build/MyPlugin.jar
file:../build/MyPlugin-*.jar
```

A local glob must match exactly one JAR. `plugins update` imports changed local bytes. External providers may use non-SemVer identifiers; do not compare every version as SemVer.

Structured forms are available when compact syntax is ambiguous:

```yaml
plugins:
    ViaVersion:
        provider: modrinth
        project: viaversion
        version: latest
    MyPlugin:
        provider: file
        path: ../build/MyPlugin.jar
```

Other structured providers use:

```yaml
# SpigotMC
provider: spigotmc
resource: "19254"
version: latest

# Hangar
provider: hangar
project: ViaVersion
version: latest

# GitHub release asset
provider: github
owner: example
repo: plugin
version: v1.2.3
asset: plugin.jar
```

Plugin map keys are identities read from the JAR, not arbitrary labels:

- Bukkit/Spigot: `name` from `plugin.yml`
- Paper: `name` from `paper-plugin.yml`
- Velocity: `id` from `velocity-plugin.json`

Use `craflet plugins inspect <jar>` or `craflet plugins add <source>` to discover the identity. Craflet rejects duplicate or incompatible identities, missing required dependencies, and silent identity changes. It inspects descriptors without executing JAR code.

## Configuration and secrets

Every tracked base file mirrors its runtime-relative path:

```text
config/server.properties             -> runtime/server.properties
config/config/paper-global.yml       -> runtime/config/paper-global.yml
config/plugins/MyPlugin/config.yml   -> runtime/plugins/MyPlugin/config.yml
```

Do not add arbitrary plugin YAML automatically. Use `config list --candidates`, then explicitly capture or track intended files. Craflet preserves source text where possible and does not run Biome or another source formatter over server configuration.

Declare a secret reference before capturing plaintext that must not enter Git:

```yaml
secrets:
    DATABASE_PASSWORD:
        env: MINECRAFT_DB_PASSWORD
    PAPER_MANAGEMENT_SECRET:
        file: /private/paper-management-secret
```

Use `${secret:NAME}` only in tracked base files. Craflet resolves it at deployment, restores the reference during capture, and omits values from diffs and errors. It does not load `.env` files. Runtime files and restored data may still contain real secrets.

## Backup selection

`backup.files` is one ordered list. A normal pattern includes, `!` excludes, and the last matching rule wins. A later normal pattern re-includes. `.gitignore` is unrelated, and `!!` has no special meaning.

The defaults select runtime and shared operating data while excluding every JAR, logs, crash reports, downloaded libraries, and caches. Add or exclude project-specific data deliberately. Symlink targets are not followed; external roots need explicit configuration and mapping.

SQLite declaration:

```yaml
backup:
    repository: main
    files:
        - runtime/**
        - "!**/*.[jJ][aA][rR]"
    databases:
        - id: permissions
          kind: sqlite
          path: runtime/plugins/Permissions/data.db
```

MySQL and MariaDB require `host`, optional `port`, `database`, `user`, a secret `password` reference, and optionally dump/restore command paths and `sslCa`. Only InnoDB tables are supported. Craflet cannot stop writers outside its managed server group.

Retention supports `keepLast`, `keepDaily`, `keepWeekly`, and `keepMonthly`, each at least one. `backup prune` previews by default.

## Workspace declaration

```yaml
schemaVersion: 1
projects:
    - servers/*
```

Workspace globs select project directories. The lock is shared, while each server keeps an independent desired, pending, and active installation.
Use `-r` to select every workspace member or repeat `--filter <name-or-relative-path-pattern>` for a subset. Zero matches are an error.
Servers sharing a database must use the same `backup.group` and compatible repository, database, and retention settings. Production operations on such a group require selecting every member.
