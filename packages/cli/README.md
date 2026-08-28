# Craflet

Minecraft サーバーの JAR、設定、運転、バックアップを管理する CLI です。サーバーを動かすホストで実行し、リモート操作には通常の SSH を利用します。Linux / Windows / macOS、Paper / Velocity が対象です。

## 導入

Node.js 24.20.0 以降と、対象サーバーが必要とする Java を用意してください。Java の自動導入、SSH 接続、OS サービスの登録は行いません。npm パッケージはまだ公開していません。リポジトリからビルドした tarball で導入できます。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir packages/cli pack --pack-destination ../../artifacts
npm install --global ./artifacts/craflet-0.1.0.tgz
craflet --help
```

利用者に pnpm や TypeScript は不要です。公開時は `npx craflet` にも対応する自己完結した配布物になります。CLI と runner は独立した ESM bundle です。runner は Craflet の管理領域へハッシュ付きで保存してから起動します。

## 最初のプロジェクト

```sh
craflet init my-server --name survival --type paper --version 26.2
cd my-server
craflet install
craflet doctor
```

Paper を起動する前に [Minecraft EULA](https://www.minecraft.net/eula) を読み、同意する場合だけ自分で `runtime/eula.txt` に `eula=true` を記載してください。`--yes` で EULA に同意したことにはなりません。

```sh
craflet start
craflet status
craflet logs --follow
craflet stop
```

`run` はログを表示しながら待機し、Ctrl-C で正常停止を要求します。`console` の切断、`logs --follow` の Ctrl-C ではサーバーを停止しません。停止タイムアウトや起動確認の失敗では自動で強制終了しません。プロセスを識別できない場合は `unknown` になります。

## 宣言と JAR

```yaml
schemaVersion: 1
name: survival
server:
    type: paper
    version: "26.2"
    build: latest
plugins:
    MyPlugin: file:../build/MyPlugin.jar
backup:
    repository: main
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

`init` は安定したプロジェクト UUID も生成します。プラグインのキーは `add` が JAR の `plugin.yml` / `paper-plugin.yml` の名前、または `velocity-plugin.json` の ID から取得します。JAR を実行して識別することはありません。

```text
modrinth:<project>@<version>
spigotmc:<resource-id>@<version>
hangar:<project>@<version>
github:<owner>/<repo>@<tag>#<asset-name>
file:../build/MyPlugin.jar
file:../build/MyPlugin-*.jar
```

ローカル glob は一致が一つの場合だけ使えます。相対パスは各 `craflet.yaml` 基準です。複雑な値は `{ provider: file, path: ../build/MyPlugin.jar }` のような構造化 YAML でも指定できます。取得元が認証、外部リンク、配布制限などで自動取得できない場合は、理由を表示して `file:` での導入を案内します。

`craflet-lock.yaml` は実際の版、取得元、サイズ、SHA-256 を固定します。`install` は既存 lock を再現し、`update` は明示的に新版を選びます。ローカル JAR の再取り込みにも `update` を使用します。一般の更新で Minecraft のバージョンは変えません。

JAR はバックアップから復元せず、lock が指す同一ハッシュのキャッシュまたは取得元から復元します。自作 JAR の旧版も、再入手できる場所に保管してください。旧版のキャッシュを削除し、元の `file:` も新版で置き換えた場合、その旧版を含むバックアップの適用は停止前に拒否します。異なるバイト列を同じ版として代用しません。

```sh
craflet add file:../build/MyPlugin.jar
craflet outdated
craflet update MyPlugin
craflet deploy plan
craflet restart
```

`add` / `remove` / `install` / `update` は **pending の準備だけ**を行い、起動中の JAR は変更しません。次回の `start` / `run` / `restart` が停止確認、設定再確認、バックアップ後にコピーで適用します。`--active` は pending を適用しません。`deploy apply` は停止が必須で、適用後に起動しません。`remove` でプラグインの保存データは削除されません。

## 設定と秘密情報

`config/` の相対パスがそのまま `runtime/` の相対パスになります。通常 `craflet.yaml` に config セクションは不要です。

```text
config/server.properties             -> runtime/server.properties
config/config/paper-global.yml       -> runtime/config/paper-global.yml
config/plugins/MyPlugin/config.yml   -> runtime/plugins/MyPlugin/config.yml
```

```sh
craflet config list --candidates
craflet config capture --initial
craflet config track plugins/MyPlugin/config.yml
craflet config diff
craflet config capture
craflet install
craflet restart
```

初回 capture は既存の標準設定、ops、whitelist を候補にします。ban リストは `--include-bans` で選択します。プラグイン内の YAML を無差別に設定として取り込みません。二回目以降は追跡中のファイルが対象です。原本、前回の観測、runtime を比較し、競合時には原本を変更しません。

原本を編集した後は `install` で設定も pending に準備してください。準備後に runtime が変更された場合は適用を拒否するため、`config diff` / `config capture` で確認してから再度 `install` します。

秘密値の必要な箇所には `${secret:NAME}` を置きます。宣言には参照だけを記載します。

```yaml
secrets:
    RCON_PASSWORD:
        env: MINECRAFT_RCON_PASSWORD
    FORWARDING_SECRET:
        file: /private/velocity-secret
```

capture / diff / pending / 観測基準は秘密参照へ戻します。既知のサーバー秘密フィールドを未登録の平文で取り込む操作は拒否します。プラグイン独自の秘密フィールドをすべて自動発見できるわけではありません。Git に追加する前に原本を確認してください。実際の runtime と暗号化前の復元先には実値が必要なので、アクセス権を制限します。管理対象ファイルに Biome は適用しません。変更なしなら原文を保持します。変更した TOML は現状コメントを保持できません。

## バックアップ

保存先は、明示登録したローカルディレクトリかマウント済み NAS です。暗号化パスワードは環境変数か秘密ファイルで渡します。

```sh
craflet backup setup main --path /mnt/backups/survival --password-env CRAFLET_BACKUP_PASSWORD --init --yes
craflet backup plan
craflet backup create
craflet backup list
craflet backup check --read-data
craflet backup restore <snapshot-id> --to /restore/survival
craflet backup apply /restore/survival --yes
```

既存のリポジトリの登録では `--init` を付けません。登録した実パスとリポジトリ ID を照合し、保存先が消えても別の場所や空の NAS マウントポイントに新規保存しません。restic は固定した公式配布物のハッシュを検証し、**サーバーを停止する前に**準備します。

`backup.files` は `craflet.yaml` 基準です。通常パターンで包含、`!` で除外し、後の一致が優先します。再包含は後ろに通常パターンを書きます。`!!` と `.gitignore` は使用しません。自作を含む全 JAR は初期設定で除外されます。world、プレイヤー、プラグインデータ、runtime 設定など運用中のデータを保存します。symlink は追いません。外部データは明示指定してください。

保存成功後は元から稼働していたサーバーだけを同じ active で再開し、pending は適用しません。停止前の検査に失敗した場合は稼働を維持し、停止後の保存に失敗した場合は停止を維持します。グループの再開に一部失敗した場合は、既に再開したサーバーも含めて個別の状態を報告します。`restore` は空の別ディレクトリへ展開します。`apply` はハッシュ、対象、事前バックアップを確認して反映し、起動しません。追加データ root と DB の反映には `--map root-id=absolute-path` と `--database id` による明示指定が必要です。復元しても YAML、共有 lock、過去の pending は反映しません。

SQLite は `backup.databases` に `id` / `kind: sqlite` / `path: runtime/...db` を宣言できます。MySQL / MariaDB は host / port / database / user / password 参照と、対応する dump/client コマンドが必要です。対応するテーブルは InnoDB に限定し、loopback 以外への接続には `sslCa` を指定します。共有 DB の writer を Craflet の管理外から停止できることまでは保証しません。外部 writer がある場合、運用側で停止・整合性を確保してください。

```yaml
backup:
    repository: main
    group: network
    files:
        - runtime/**
        - "!**/*.[jJ][aA][rR]"
    databases:
        - id: permissions
          kind: mysql
          host: 127.0.0.1
          database: minecraft
          user: backup_operator
          password:
              env: MINECRAFT_DB_PASSWORD
```

同じ DB を利用する workspace の全サーバーに同じ `backup.group` を指定します。共有 DB の設定・リポジトリ・保持方針が一致することを検査し、全サーバー停止後に一つの snapshot を作成します。`start` / `restart` / `deploy apply` / `backup create` / `backup apply` など、本番を操作する際はグループ全員の選択が必要です。`update` / `install` などの pending 準備は一部だけでも行え、別ディレクトリへの `backup restore` も本番には影響しません。グループの `backup apply` は全サーバーを一括で扱い、共有データと DB は一度だけ反映します。

配置や復元が中断された場合は `doctor` と `recover --dry-run` で確認してから `recover` を実行します。終了した操作のロックだけを除去するには `recover --unlock` を使います。PID だけで稼働中 Java を強制終了する機能ではありません。SQL の復元が途中で失敗した場合は自動で同じ SQL を再実行せず、事前 snapshot の ID を操作記録の `backupId` に残し、手動での DB 復旧を要求します。

`backup prune` と `cache prune` は既定で予定表示のみです。削除には `--apply` が必要です。JAR キャッシュは `~/.craflet/cache/artifacts/sha256/` に共有し、`CRAFLET_HOME` で変更できます。キャッシュ削除は登録済みの lock / active / pending と進行中操作を保護します。

## workspace とコマンド

`craflet-workspace.yaml` に `schemaVersion: 1` と `projects: ["servers/*"]` を指定します。lock は共有しますが、各サーバーのバージョンは独立です。`-r` / `--filter <name-or-path-pattern>` で対象を選択します。0 件はエラーです。宣言の確定は一つの操作記録で管理し、運転の部分失敗は個別結果と終了コードで示します。

| 分類 | コマンド |
| --- | --- |
| 準備 | init, import, workspace init/list, validate, doctor |
| JAR | inspect, add, remove, list, install, outdated, update |
| 適用 | deploy plan/apply/discard, recover |
| 運転 | run, start, stop, restart, status, logs, console, command |
| 設定 | config list/track/untrack/diff/capture/resolve |
| 保存 | backup setup/plan/create/list/show/diff/check/restore/apply/prune |
| 保守 | cache info/verify/prune, tools prepare restic |

`--json` は構造化結果、`--dry-run` は予定、`--offline` はネットワークを使わない取得、`--yes` は明示操作の対話確認を省略するために使います。安全検査は省略しません。詳細は各コマンドの `--help` を参照してください。自動 commit / push、npm 公開は行いません。

## 開発と検証

開発環境は mise.toml / .node-version / packageManager で固定します。依存は exact pin、入力検証は ArkType、Biome は 4 スペースで他の整形ルールは基本設定です。`core` は I/O を持たず、adapters と CLI を経由して実行します。

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:coverage
pnpm check:architecture
pnpm build
pnpm test:package
pnpm verify
```

実サーバー fixture は公式配布の ID と SHA-256 を `tests/fixtures/` の lock で固定し、専用の Bukkit / Paper / Velocity プラグインを JDK 25 でビルドします。

```sh
node tests/fixtures/build.mjs --with-servers --verify-reproducible
pnpm test:e2e
```

Paper E2E にはテスト用サーバーについての明示 EULA 同意が必要です。同意した実行者だけが `CRAFLET_E2E_EULA=true` を設定してください。同意や Java がない場合を成功扱いの skip にしません。テストは専用ディレクトリ、ポート、`CRAFLET_HOME` を使い、本番データやユーザーの共通キャッシュを利用しません。

PR の CI は Linux / Windows / macOS の実サーバー試験と、Linux の専用 MySQL / MariaDB サービス試験を必須にします。EULA に同意したリポジトリ管理者は Actions の repository variable `CRAFLET_E2E_EULA` を `true` に設定してください。実際に通過した tarball が試験対象です。ローカルで同じ経路を試すには `pnpm build` / `pnpm test:package` の後、`CRAFLET_E2E_PACKAGE=artifacts/craflet-0.1.0.tgz` を設定して `pnpm test:e2e` を実行します。
