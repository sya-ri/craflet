# Contributing to Crafleet

For installation and server administration, see the [README](README.md). This guide covers development, tests, and distribution checks.

## Development environment

Use the versions pinned in `mise.toml`, `.node-version`, and the root `packageManager` field. The development toolchain uses Node.js 24.20.0, pnpm 11.24.0, and Temurin 25.0.3+9.0.LTS. Keep tool selection local to the project; do not change a contributor's global Java or Node settings.

The published CLI supports every Node.js 24 release, but the development toolchain requires Node.js 24.11.1 or later because of its build dependencies and a config-loading bug in Node.js 24.11.0. CI builds with a supported development runtime, then runs the packaged CLI and targeted runtime tests separately on Node.js 24.0.0.

After selecting the pinned tools, run:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs formatting and lint checks, TypeScript, architecture checks, unit and integration coverage, the distribution build, and an isolated tarball installation test. Real server E2E and external database services are separate checks.

## Code organization

| Package | Responsibility |
| --- | --- |
| `@crafleet/core` | Domain rules, input schemas, application use cases, and I/O contracts. |
| `@crafleet/adapters` | Filesystems, providers, processes, formats, databases, and restic. |
| `crafleet` | CLI parsing, presentation, dependency composition, and the runner entry point. |

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
| `pnpm release:prepare` | Verify and record the exact release commit and tarball. |
| `pnpm release:check` | Recheck the release receipt, tag, commit, and tarball hash. |
| `pnpm release:publish` | Publish only the tarball recorded by `release:prepare`. |

Add tests alongside behavior changes and a reproducing test with each bug fix. Prefer real temporary files, HTTP servers, and subprocesses for integration tests. Mocks may exercise failures, but do not replace actual server or database tests.

Coverage includes production implementations that tests have not imported. Core requires at least 95% line and 90% branch coverage; the overall unit and integration suite requires 90% line and 85% branch coverage. Coverage numbers do not replace explicit checks for destructive operations and failure recovery.

## Real server E2E

The fixture locks in `tests/fixtures/` pin official Paper and Velocity builds and plugin API artifacts by version, size, and SHA-256. Builds do not silently resolve newer server versions. Use the pinned JDK to build the fixtures:

```sh
node tests/fixtures/build.mjs --with-servers --verify-reproducible
pnpm build
pnpm test:package
```

Read and accept the [Minecraft EULA](https://www.minecraft.net/eula) before enabling Paper test servers. Only if you have accepted it, set `CRAFLEET_E2E_EULA=true` for the test process. For the same package path used by CI:

```sh
CRAFLEET_VERSION="$(node -p "require('./packages/cli/package.json').version")"
CRAFLEET_E2E_EULA=true CRAFLEET_E2E_PACKAGE="artifacts/crafleet-${CRAFLEET_VERSION}.tgz" pnpm test:e2e
```

In PowerShell, read the version with `$crafleetVersion = node -p "require('./packages/cli/package.json').version"`, set `$env:CRAFLEET_E2E_EULA = "true"` and `$env:CRAFLEET_E2E_PACKAGE = "artifacts/crafleet-$crafleetVersion.tgz"`, then run `pnpm test:e2e`. Remove the variables from that shell afterward. Setting either variable is an explicit test setup step; the harness does not grant EULA consent.

Missing Java or EULA acceptance fails the suite instead of producing a successful skip. Each test uses isolated directories, ports, and `CRAFLEET_HOME`; it must never use production projects, databases, or the user's shared cache. Cleanup targets only processes and files owned by the test. A retry must not hide a failure.

Failed E2E runs retain evidence under `.test-tmp/real-e2e-*/`. `CRAFLEET_E2E_KEEP=true` also keeps successful runs. Upload only the redacted `diagnostics/` directory and coverage reports, not raw runtime configuration, worlds, databases, or backup repositories. See the [fixture guide](tests/fixtures/README.md) for plugin contracts, fault injection, and lock maintenance.

## Continuous integration

Every pull request runs verification and real server E2E on Linux, Windows, and macOS. Dedicated Linux service jobs dump and restore actual MySQL and MariaDB data. The `All platforms and databases` job requires every platform and database job to succeed.

A repository administrator who has accepted the Minecraft EULA must set the Actions repository variable `CRAFLEET_E2E_EULA` to `true`. An unset variable fails Paper E2E. Workflows require no production credentials; database credentials belong only to disposable test services. The workflow also enables actual restic integration tests with `CRAFLEET_TEST_RESTIC=1`.

Server E2E installs the exact tarball that passed package verification, outside the repository, without workspace links or TypeScript source. Keep action revisions, database images, and fixture artifacts pinned. Do not replace real E2E with a mock or remove an OS from required checks to obtain a passing run.

## Distribution checks

Only `packages/cli` is published as `crafleet`; core and adapters remain private. The build bundles runtime JavaScript dependencies into independent CLI and runner ESM files, generates schemas and license notices, and copies the user-facing root README and its terminal demo into the package. Edit the root README and root demo asset, then rebuild; do not edit packaged copies independently.

`pnpm test:package` creates `artifacts/crafleet-<version>.tgz`, using the version in `packages/cli/package.json`, installs it in a fresh directory, and tests both direct CLI execution and the npm-exec path. It rejects private package references, runtime npm dependencies, missing assets, and unwanted development files. The packed manifest is adjusted without removing dependencies from the development manifest.

The README terminal animation is generated by `python scripts/generate-readme-demo.py`. The script installs nothing and requires Pillow in an isolated documentation-tooling environment. Its transcript mirrors the tested human-facing setup, backup registration, plugin update, pending-state, and restart output, with environment-specific paths normalized. Recapture and review the transcript when those outputs or pinned demo versions change. The README uses the repository's absolute raw asset URL so GitHub and npm render it consistently; package verification also keeps an offline copy byte-identical.

Keep the public repository and raw demo asset readable, and verify the rendered GitHub and npm package pages after each release. Do not publish a package page with a broken demo.

To inspect an installable package manually after a build:

```sh
CRAFLEET_VERSION="$(node -p "require('./packages/cli/package.json').version")"
pnpm --dir packages/cli pack --pack-destination ../../artifacts
npm install --global "./artifacts/crafleet-${CRAFLEET_VERSION}.tgz"
crafleet --help
```

### Publishing

Never publish `packages/cli` directly. Its executable bundle and schemas are generated, while tracked package assets may be stale until the distribution build runs. Release only the exact tarball produced and verified by `pnpm release:prepare`.

The initial `0.1.0` publish establishes ownership of the unscoped npm package from an authenticated local workstation. Start from a clean, signed release commit that has been pushed to `master`, and wait for its full CI run to pass. Then authenticate without copying a token into this repository:

```sh
pnpm release:prepare
git tag v0.1.0
pnpm release:check
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
pnpm release:publish
npm view crafleet@0.1.0 version --registry=https://registry.npmjs.org/
```

Do not push the tag or create the GitHub release until the package publish succeeds. The release helper fetches `origin/master`, requires `HEAD` to be included there, and accepts only a commit signed by the pinned release key. It also requires a clean worktree, an exact `v<package-version>` tag at `HEAD`, and a receipt whose commit, package version, size, and SHA-256 still match. It publishes an exclusive staged copy through the public npm registry with public access and the `latest` dist-tag. Local provenance is explicitly disabled; the helper enables it only after validating the exact GitHub Actions repository, push event, version tag, and commit.

Once npm confirms `0.1.0`, push the immutable tag and create its GitHub release manually. The trusted-publishing flag is deliberately absent during this first tag run, so CI reruns the full test matrix without trying to publish the package again; the local `release:check` has already verified the tag.

```sh
git push origin v0.1.0
gh release create v0.1.0 --repo sya-ri/crafleet --verify-tag --generate-notes --title v0.1.0
```

After the initial release exists on both npm and GitHub, install the version-controlled repository rulesets and create an npm environment restricted to `v*` tags with `sya-ri` as its required reviewer. The master ruleset requires signed commits and prevents deletion and force pushes. The release-tag ruleset prevents existing version tags from being moved or deleted. Required environment approval keeps a repository writer from replacing the release key and publishing without the release owner's approval.

```sh
gh api --method POST repos/sya-ri/crafleet/rulesets --input .github/rulesets/master.json
gh api --method POST repos/sya-ri/crafleet/rulesets --input .github/rulesets/release-tags.json
gh api --method PUT repos/sya-ri/crafleet/environments/npm --input .github/environments/npm.json
gh api --method POST repos/sya-ri/crafleet/environments/npm/deployment-branch-policies --field name='v*' --field type=tag
```

Configure npm trusted publishing for this exact repository, workflow filename, and environment while authenticated as a package owner. Set the repository variable only after `npm trust list` shows the relationship and the GitHub protection settings above are active.

```sh
npm trust github crafleet --file ci.yml --repo sya-ri/crafleet --env npm --allow-publish --yes
npm trust list crafleet
gh variable set CRAFLEET_NPM_TRUSTED_PUBLISHING --repo sya-ri/crafleet --body true
```

Subsequent stable `v<version>` tag pushes run the full required Node, operating system, real server, and database matrix before publishing the freshly verified tarball with npm provenance and creating the GitHub release. The publish job requires a protected tag and rejects a triggering tag that differs from the package version. Workflow dispatches never publish. No long-lived npm token belongs in GitHub or the repository.

The publish job imports only the public key in `.github/keys/release-signing-key.asc`, requires exactly one authorized primary fingerprint, and checks the commit's primary signer fingerprint. Update the key and both pinned fingerprint checks in one reviewed change when the authorized release signer changes.

If a local publish is interrupted, first query npm for the exact version. If it exists, treat npm publication as complete and do not publish it again. If it does not exist, read `artifacts/.release-publish.lock`, inspect the recorded PID, and confirm that no npm or Node publisher still owns the operation. Only after both checks may you remove that lock and the matching `artifacts/.release-*.tgz` staging file, run `pnpm release:check`, and retry. Never infer failure from a missing terminal response alone.

If npm contains the new version but the GitHub release step fails, do not rerun an immutable npm publication. Inspect the failed run and create the release manually with `gh release create` as shown above. If npm does not contain the version, fix the failure without moving or replacing the existing tag, then rerun the failed workflow only after confirming that another publisher did not complete it.
