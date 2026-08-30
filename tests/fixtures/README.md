# Real server fixtures

These files pin real Paper and Velocity server downloads and compile six small test
plugins. They do not launch a server or accept the Minecraft EULA.

```sh
node tests/fixtures/build.mjs --with-servers --verify-reproducible
```

Use the exact JDK from `mise.toml`. The builder checks both `java` and `javac` against
`servers.lock.json`; it finds the JDK using `CRAFLET_TEST_JAVA_HOME`, then `JAVA_HOME`,
then `mise where java`. This avoids a different Java installation on `PATH`.

All generated files are under the ignored `artifacts/fixtures/` directory. The
builder prints JSON and also writes `artifacts/fixtures/fixtures.json`, containing
the absolute Java executable, server paths, and plugin paths and hashes. Once the
cache is populated, `--offline` permits no downloads. Cached and downloaded bytes
must match the lock's SHA-256 and size.

## Plugin data contract

| Platform | Plugin ID / data directory | JARs |
| --- | --- | --- |
| Bukkit | `CrafletBukkitFixture` | `bukkit-v1.jar`, `bukkit-v2.jar` |
| Paper | `CrafletPaperFixture` | `paper-v1.jar`, `paper-v2.jar` |
| Velocity | `crafletvelocityfixture` | `velocity-v1.jar`, `velocity-v2.jar` |

Revisions `v1` and `v2` have descriptor versions `1.0.0` and `2.0.0`. Each plugin
writes these files under `runtime/plugins/<ID>/` when launched with Craflet:

- `enabled-version.txt`: version loaded at startup, ending in a newline.
- `config.yml`: generated only on the first startup; later starts preserve the file.
- `observed-message.txt`: the `message` value the Java plugin actually read on enable.
- `player-state.txt`: persistent fixture data, initialized to `fixture-player: original`.
- `observed-player-state.txt`: the persistent data actually read on enable.
- `saved-version.txt`: version saved during graceful shutdown, ending in a newline.
- `events.log`: ordered `enable:<version>` / `disable:<version>` lines.

For example, a cold backup taken after v1 stops must contain `saved-version.txt`
equal to `1.0.0\n`. Staging v2 while v1 is running must not change either the active
plugin bytes or `enabled-version.txt` until the next managed restart. Use the two
version marker files for backup assertions rather than assuming logs are included.

`-proc:none` disables API annotation processors. Metadata is generated explicitly;
the plugin JARs contain only the fixture's own classes, not server APIs. Builds use
sorted entries, no ZIP compression, no generated manifest, no debug information,
and a fixed ZIP timestamp. `--verify-reproducible` compiles each JAR twice in separate
directories and compares the resulting SHA-256.

For a workspace consistency test, set both
`-Dcraflet.fixture.sharedDirectory=<isolated-directory>` and
`-Dcraflet.fixture.instance=<unique-name>` on a fixture server. Its plugin creates
`<unique-name>.running` while enabled and removes it during graceful shutdown.
The group E2E explicitly includes that shared directory in the backup patterns;
no running markers may appear in its one group snapshot.

The E2E restores the extracted snapshot into the original managed runtime, verifies
that staging is discarded without rewriting the desired lock or base config, and
explicitly starts the restored active installation. Both version markers and
the values read by Java must match the snapshot. A group restore requires an
explicit mapping for the shared data directory. Every confirmed shutdown is also
checked by binding its former listening port.

Paper also checks that Java changes `world/level.dat` after the snapshot and that
applying the snapshot restores its exact SHA-256 before Java starts again. Its
flat-world generator settings come from the official 26.2 `classic_flat` preset.

Only a dedicated disposable fault test enables `-Dcraflet.fixture.allowFaults=true`.
With that flag, `stop-delay-ms.txt` requests a finite shutdown delay (at most ten
seconds), and `crash.request` asks the fixture to halt its own JVM with exit code 17.
Normal fixtures ignore both files. This tests stop timeout without an automatic
force kill, and process failure without applying pending plugin bytes. No test
locates or kills an unrelated process.

Additional real failure tests temporarily rename an owned backup repository while
the plugin is in its bounded stop delay, and temporarily deny creating files in
one stopped runtime's root directory. The latter leaves `plugins/` writable so the
real plugin replacement succeeds before the config write fails. The CLI must keep
a recovery journal, restore the old JAR through `recover`, and start that old JAR
only after an explicit request. Original repository paths and ACLs/modes are
restored in `finally` before cleanup. Windows uses a deny rule on the runtime
directory itself without inheritance or changing its permission-management
rights. Unix execution as root is rejected because its privilege could bypass
the intended filesystem failure.

## E2E safety

Create projects, worlds, homes, database files, and backup repositories only in an
isolated test temporary directory. Paper may require additional network access
on its first launch; these plugin fixtures do not imply a fully offline server
bootstrap. Paper initialization asks for EULA acceptance when needed and records
consent for the current OS user in `CRAFLET_HOME/eula.json`; startup reuses a valid
record. The Paper scenario checks the mandatory `CRAFLET_E2E_EULA=true` test-user
consent guard before any accepting command. On its fresh test home, plain JSON
`init` must fail with `CONFIRMATION_REQUIRED` without creating a manifest or
consent record. The explicitly authorized `init --yes` records acceptance in the
home only. Initialization, installation, and `start --dry-run` must leave runtime
`eula.txt` absent; plain `start` then uses the remembered consent to write
`eula=true` and launch Paper through the actual CLI. The existing later
`start --active` must run without renewed consent and preserve the accepted
runtime file's bytes and modification time.

Recent Paper versions generate `management-server-secret` in `server.properties`.
Use `${secret:TEST_MANAGEMENT_SECRET}` in the test's base config, map it to the
`CRAFLET_TEST_MANAGEMENT_SECRET` environment variable in the project manifest, and
pass a fixture-only value to all relevant Craflet processes. Never capture an
unregistered generated secret into Git or hide a missing test secret.

After building the CLI and fixtures, run the actual CLI tests:

```sh
pnpm build
pnpm exec vitest run --project e2e tests/e2e/real-server.test.ts -t Velocity
```

The complete `pnpm test:e2e` suite intentionally fails the Paper test unless
`CRAFLET_E2E_EULA=true` was explicitly supplied by a user who accepted the EULA.
The harness never sets this permission flag and does not silently skip Paper.
Each suite uses a fresh Craflet home; each test has separate projects, ports and
backup repositories. The harness confirms server shutdown before deleting test
data. Failed tests retain evidence under
`.test-tmp/real-e2e-*/`; `CRAFLET_E2E_KEEP=true` also keeps successful runs.
The retained `diagnostics/` directory contains CLI command outcomes, the last 400
lines of each runner log, and shutdown status. Known fixture secrets are redacted;
runtime configs, worlds, database files and backup repositories are not copied
into the diagnostic upload directory.

To test the actual distribution instead of the development bundle, pack it and
set `CRAFLET_E2E_PACKAGE` to the tarball path before invoking Vitest:

```sh
CRAFLET_VERSION="$(node -p "require('./packages/cli/package.json').version")"
pnpm --dir packages/cli pack --pack-destination "$PWD/artifacts"
CRAFLET_E2E_PACKAGE="artifacts/craflet-${CRAFLET_VERSION}.tgz" pnpm exec vitest run --project e2e tests/e2e/real-server.test.ts -t Velocity
```

In PowerShell, set `$env:CRAFLET_E2E_PACKAGE` before running the same Vitest command.
The harness copies and hashes that tarball, then uses `npm install --offline
--ignore-scripts` in a fresh temporary directory outside the repository. This
prevents missing bundled dependencies from being resolved through workspace
links or the repository's `node_modules`. The installed CLI must include its
runner and have no runtime package dependencies. The package directory is kept
with failed-test evidence; successful tests remove it only after all servers
have stopped. Node must include npm in a standard distribution layout.

## Updating locks

Locks are updated deliberately, not by the build script. Resolve STABLE builds
from the [official Fill API](https://docs.papermc.io/misc/downloads-service/), record
their exact version, build, URL, size and SHA-256, and verify downloaded bytes.
API artifacts come from the
[PaperMC Maven repository](https://repo.papermc.io/repository/maven-public/), using
published SHA-256 values. A timestamped Velocity snapshot is pinned to its exact
artifact filename. See the official
[Paper project setup](https://docs.papermc.io/paper/dev/project-setup/) and
[Velocity plugin setup](https://docs.papermc.io/velocity/dev/creating-your-first-plugin/).
