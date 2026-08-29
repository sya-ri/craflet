# Contributing to Craflet

For installation and server administration, see the [README](README.md). This guide covers development, tests, and distribution checks.

## Development environment

Use the versions pinned in `mise.toml`, `.node-version`, and the root `packageManager` field. The development toolchain uses Node.js 24.20.0, pnpm 11.24.0, and Temurin 25.0.3+9.0.LTS. Keep tool selection local to the project; do not change a contributor's global Java or Node settings.

After selecting the pinned tools, run:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs formatting and lint checks, TypeScript, architecture checks, unit and integration coverage, the distribution build, and an isolated tarball installation test. Real server E2E and external database services are separate checks.

## Code organization

| Package | Responsibility |
| --- | --- |
| `@craflet/core` | Domain rules, input schemas, application use cases, and I/O contracts. |
| `@craflet/adapters` | Filesystems, providers, processes, formats, databases, and restic. |
| `craflet` | CLI parsing, presentation, dependency composition, and the runner entry point. |

The CLI may depend on core and adapters; adapters may depend only on core. Core must not access files, the network, environment variables, or console output directly. Import other packages through their public entry points, never through their `src/` directories. `pnpm check:architecture` checks these boundaries and resolved build dependencies.

Input definitions use ArkType and generate the JSON schemas shipped with the CLI. Keep validation definitions in one place; separate syntax validation from normalization, filesystem checks, and cross-field rules.

## Dependencies and style

Before adding a dependency, check its current official documentation and npm `latest` metadata, including Node requirements, peer dependencies, license, and maintenance. Use an exact stable version for external dependencies and `workspace:*` for internal packages. Explain compatibility problems before choosing an older release.

Keep `.npmrc`'s `save-exact=true`, `pnpm-workspace.yaml`'s `saveExact: true`, and the committed `pnpm-lock.yaml`. CI uses frozen installs. Review any install script before allowing it, and never store registry credentials in the repository.

Use TypeScript in strict mode. Biome uses spaces with an indent width of four and otherwise default formatting settings. Do not add ESLint or Prettier, or apply development formatting to managed Minecraft configuration, downloaded files, backups, or fixtures that test original formatting.

Write documentation, code comments, and commit messages in English. Preserve non-English and Unicode fixture data when it is part of a test. Follow the existing prefixed commit style, for example `fix: preserve pending changes after a failed backup`.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm format` | Format development files with Biome. |
| `pnpm check` | Check formatting, lint, and imports. |
| `pnpm check:fix` | Apply safe Biome fixes. |
| `pnpm typecheck` | Check TypeScript types. |
| `pnpm test` | Run unit tests. |
| `pnpm test:watch` | Watch unit tests. |
| `pnpm test:integration` | Run filesystem and I/O integration tests. |
| `pnpm test:coverage` | Run unit and integration tests with coverage gates. |
| `pnpm test:e2e` | Run real Paper and Velocity tests. |
| `pnpm test:package` | Pack and verify an isolated installation. |
| `pnpm check:architecture` | Check package boundaries and dependency direction. |
| `pnpm build` | Build the CLI, runner, schemas, and distribution assets. |
| `pnpm verify` | Run the standard local verification sequence. |

Add tests alongside behavior changes and a reproducing test with each bug fix. Prefer real temporary files, HTTP servers, and subprocesses for integration tests. Mocks may exercise failures, but do not replace actual server or database tests.

Coverage includes production implementations that tests have not imported. Core requires at least 95% line and 90% branch coverage; the overall unit and integration suite requires 90% line and 85% branch coverage. Coverage numbers do not replace explicit checks for destructive operations and failure recovery.

## Real server E2E

The fixture locks in `tests/fixtures/` pin official Paper and Velocity builds and plugin API artifacts by version, size, and SHA-256. Builds do not silently resolve newer server versions. Use the pinned JDK to build the fixtures:

```sh
node tests/fixtures/build.mjs --with-servers --verify-reproducible
pnpm build
pnpm test:package
```

Read and accept the [Minecraft EULA](https://www.minecraft.net/eula) before enabling Paper test servers. Only if you have accepted it, set `CRAFLET_E2E_EULA=true` for the test process. For the same package path used by CI:

```sh
CRAFLET_E2E_EULA=true CRAFLET_E2E_PACKAGE=artifacts/craflet-0.1.0.tgz pnpm test:e2e
```

In PowerShell, set `$env:CRAFLET_E2E_EULA = "true"` and `$env:CRAFLET_E2E_PACKAGE = "artifacts/craflet-0.1.0.tgz"`, then run `pnpm test:e2e`. Remove the variables from that shell afterward. Setting either variable is an explicit test setup step; the harness does not grant EULA consent.

Missing Java or EULA acceptance fails the suite instead of producing a successful skip. Each test uses isolated directories, ports, and `CRAFLET_HOME`; it must never use production projects, databases, or the user's shared cache. Cleanup targets only processes and files owned by the test. A retry must not hide a failure.

Failed E2E runs retain evidence under `.test-tmp/real-e2e-*/`. `CRAFLET_E2E_KEEP=true` also keeps successful runs. Upload only the redacted `diagnostics/` directory and coverage reports, not raw runtime configuration, worlds, databases, or backup repositories. See the [fixture guide](tests/fixtures/README.md) for plugin contracts, fault injection, and lock maintenance.

## Continuous integration

Every pull request runs verification and real server E2E on Linux, Windows, and macOS. Dedicated Linux service jobs dump and restore actual MySQL and MariaDB data. The `All platforms and databases` job requires every platform and database job to succeed.

A repository administrator who has accepted the Minecraft EULA must set the Actions repository variable `CRAFLET_E2E_EULA` to `true`. An unset variable fails Paper E2E. Workflows require no production credentials; database credentials belong only to disposable test services. The workflow also enables actual restic integration tests with `CRAFLET_TEST_RESTIC=1`.

Server E2E installs the exact tarball that passed package verification, outside the repository, without workspace links or TypeScript source. Keep action revisions, database images, and fixture artifacts pinned. Do not replace real E2E with a mock or remove an OS from required checks to obtain a passing run.

## Distribution checks

Only `packages/cli` is published as `craflet`; core and adapters remain private. The build bundles runtime JavaScript dependencies into independent CLI and runner ESM files, generates schemas and license notices, and copies the user-facing root README and its terminal demo into the package. Edit the root README and root demo asset, then rebuild; do not edit packaged copies independently.

`pnpm test:package` creates `artifacts/craflet-0.1.0.tgz`, installs it in a fresh directory, and tests both direct CLI execution and the npm-exec path. It rejects private package references, runtime npm dependencies, missing assets, and unwanted development files. The packed manifest is adjusted without removing dependencies from the development manifest.

The README terminal animation is generated by `python scripts/generate-readme-demo.py`. The script installs nothing and requires Pillow in an isolated documentation-tooling environment. Its transcript records packaged CLI output, with environment-specific paths normalized, and mirrors the tested EULA renderer. Recapture and review the transcript when those outputs change. The README uses a relative asset path so private-repository readers and an extracted npm package can both render it; package verification must keep the copied GIF byte-identical.

Before the first public npm release, ensure the repository or the demo asset is publicly readable and verify the rendered package page. npm may resolve a relative README image through repository metadata rather than serving the installed tarball path; do not publish a package page with a broken demo. If the repository remains private, move the GIF to an approved public release or package CDN URL and update both README copies through the normal build.

To inspect an installable package manually after a build:

```sh
pnpm --dir packages/cli pack --pack-destination ../../artifacts
npm install --global ./artifacts/craflet-0.1.0.tgz
craflet --help
```

Publication is a separate, explicit release action. Test the exact tarball intended for release; do not publish an unverified rebuild. Build, test, and CI commands do not publish to npm.
