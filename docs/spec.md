# Adjutant 仕様書 v0.1（シングルソース実装 + ロードマップ）

> 現状：Slack の投稿/リアクションを CDP で収集し、日付ごとの JSONL とビューア（SvelteKit）で参照できるようにする。将来的には Slack Workflow / Slack Events API 経路や GitHub / ローカル Git を統合し、LLM 要約まで拡張する。

---

## 0. スコープ & ロードマップ

- **現在実装済み（v0.1 時点）**：
  - Slack（CDP 経由）の `chat.postMessage` / `reactions.add|remove` を正規化して JSONL へ追記
  - JSONL を読み込む SvelteKit 製ビューア
    - ダッシュボード（日次集計）、日別タイムライン、RAW ビュー
    - Slack イベント用パーマリンク生成（`ADJUTANT_SLACK_WORKSPACE` 系の環境変数が必須）
  - クリップボードテンプレート（Handlebars）と UI での編集
  - SSE ベースのリアルタイム反映（`/day/<date>/stream`）

- **今後の予定（ロードマップ）**：
  - Slack Workflow 経路の取り込み（`SlackWorkflowAdapter`）
  - Slack Events API 経路の取り込み（`SlackEventsApiAdapter`）
  - GitHub イベント（PR/Issue/コメント/レビュー）の取り込み
  - ローカル Git hooks からのコミット連携
  - JSONL から MD-Record v1 を生成する要約バッチと LLM プロンプト
  - SQLite / FTS を利用した検索・集約の検討

- **非スコープ（v0.1）**：
  - 組織全体監査や権限管理など、個人用途を超える運用
  - 高度な PII マスキング

---

## 1. 全体アーキテクチャ（現状と拡張案）

```mermaid
flowchart TB
  subgraph Sources
    S["Slack (CDP)"]
    G["GitHub (API / later App)"]
    L["Local Git (hooks)"]
    O["Others (later)"]
  end

  subgraph Ingestion["1. Ingestion Adapters"]
  end
  subgraph Normalizer["2. Normalizer（正規化→テキスト化）"]
  end
  subgraph Storage["3. Storage (Filesystem JSONL, daily partition)"]
  end
  subgraph Summarizer["4. Summarizer (LLM, planned)"]
  end

  S --> Ingestion
  style G stroke-dasharray: 4 4
  style L stroke-dasharray: 4 4
  style O stroke-dasharray: 4 4
  G --> Ingestion
  L --> Ingestion
  O --> Ingestion
  Ingestion --> Normalizer --> Storage --> Summarizer --> Storage
```

**設計原則**

- 現状は Slack アダプタのみが動作。GitHub / Git は将来追加する。
- 保存は **日付×ソースの JSONL 追記**でシンプル運用（SQL 依存なし）。
- 将来的に LLM 要約を行う場合は **Markdown レコード（MD‑Record v1）**を想定。

---

## 2. データモデル（Filesystem / JSONL + Markdown）

### 2.1 保存ディレクトリ構成（例）

```
<dataDir>/
  2025/
    11/
      03/
        slack/
          events.jsonl       # 1行=1 JSON レコード（正規化イベント）
          ingest.log         # 任意の収集ログ
        github/
          events.jsonl
        git-local/
          events.jsonl
        summaries/
          daily.md           # その日の最終 Markdown サマリ
```

- 追記専用（append-only）。ファイルロックで多重書き込みを抑止。
- ディレクトリの日付は **イベント記録時刻 (`logged_at`)** に基づく。すべてのレコードで `logged_at` を必須とし、ISO8601 の文字列で格納する。
- ローテーションは日付ディレクトリ単位。

### 2.2 JSONL レコード仕様（NormalizedEvent v1.1：共通＋ネスト詳細）

**目的**：どのイベントにも共通な最小コアをフラットに配置し、ソース固有の項目は `detail` にネスト保持する。

```json
{
  "schema": "adjutant.event.v1.1",
  "uid": "slack:C08QLKYPUUW@1762150061.xxxx10",
  "source": "slack", // "slack" | "github" | "git-local" | ...
  "kind": "post", // 共通の論理種別
  "action": null, // 任意
  "actor": "山崎", // 任意
  "subject": "テストメッセージ", // 任意（見出し）
  "ts": "2025-11-03T15:07:41+09:00", // イベント時刻（ISO8601）
  "logged_at": "2025-11-03T15:07:42+09:00", // 取り込み時刻

  "detail": {
    // ソース固有の生/準生データ（ネスト）
    "slack": {
      "type": "post",
      "channel_id": "C08QLKYPUUW",
      "channel_name": "dev-infra",
      "text": "テストメッセージ",
      "blocks": null,
      "thread_ts": "1762150053.xxxxx9"
    }
  },

  "meta": {
    // 付帯情報（共通）
    "transport": "cdp", // "cdp" | "workflow" | "events_api" | ...
    "url": null,
    "truncated": false
  }
}
```

- `detail` のキーは **source 名**（例：`slack`/`github`/`git_local`）。
- `detail.<source>` の型は**下記 3.1 のネスト型**に準拠。未使用キーは省略可。
- コア側の `subject/text/diff/repo/channel/refs` は**任意**。必要なら `detail` から計算して後段でレンダリング。
- `meta.transport` は同一 `source` 内の取得経路を示す。Slack は `cdp` / `workflow` / `events_api` を使用する。

#### 例：Slack reaction

```json
{
  "schema": "adjutant.event.v1.1",
  "uid": "slack:C08QLKYPUUW@1762149560.712159:eyes:added:U123",
  "source": "slack",
  "kind": "reaction",
  "action": "added",
  "actor": "山崎",
  "ts": "2025-11-03T15:07:55+09:00",
  "logged_at": "2025-11-03T15:07:56+09:00",
  "detail": {
    "slack": {
      "type": "reaction",
      "channel_id": "C08QLKYPUUW",
      "channel_name": "dev-infra",
      "message_ts": "1762149560.712159",
      "emoji": "eyes",
      "user": "U123",
      "message_text": "例: こんにちは"
    }
  }
}
```

- UID は `channel@message_ts:emoji:action:user_id` 形式とし、同じ投稿に対して別ユーザーが add/remove を繰り返しても重複除外されないようにする。

#### 例：GitHub PR

```json
{
  "schema": "adjutant.event.v1.1",
  "uid": "gh:you/repo#PR#123",
  "source": "github",
  "kind": "pr",
  "action": "opened",
  "actor": "octocat",
  "ts": "2025-11-03T04:10:22Z",
  "subject": "Add CDP logging and multipart parsing",
  "detail": {
    "github": {
      "repo": "you/repo",
      "number": 123,
      "title": "Add CDP logging and multipart parsing",
      "state": "open",
      "head": "feat/cdp-logging",
      "base": "main",
      "html_url": "https://github.com/you/repo/pull/123"
    }
  },
  "meta": { "url": "https://github.com/you/repo/pull/123" }
}
```

#### 例：Local Git commit

```json
{
  "schema": "adjutant.event.v1.1",
  "uid": "git:/home/you/repo#commit#abc123",
  "source": "git-local",
  "kind": "commit",
  "actor": "you",
  "ts": "2025-11-03T10:21:00+09:00",
  "subject": "feat: add multipart parser",
  "detail": {
    "git_local": {
      "repo_path": "/home/you/repo",
      "sha": "abc123",
      "branch": "main",
      "files": ["src/index.ts"],
      "patch": "+ add parseMultipart()
- TODO: handle binary parts
"
    }
  }
}
```

> 保存はこれまで通り `YYYY/MM/DD/<source>/events.jsonl` への**追記**。後段のレンダラが JSONL → MD‑Record v1 を生成する。

### 2.3 LLM 投入用テキスト（MD‑Record v1）

> **ステータス**：未実装（要約ジョブ追加時に本仕様を採用予定）

- **目的**：JSONL を LLM が読みやすい Markdown に一時レンダリング。
- **レコード区切り**：単独行の `---`
- **ヘッダ行（1行）**：
  `## [source=slack] kind=post uid=<uid> ts=<ISO8601>`
- **メタ行（任意・最大5行）**：`actor: ...` / `channel: ...` / `repo: ...` / `action: ...` / `refs: ...`
- **サブセクション**：`### text` / `### comment` / `### diff` / `### reactions` / `### links`
- **本文は必ずコードフェンス**。フェンスは **動的長**（中身のバッククォート最大長+1）または **~ フェンス**。

例（Slack: post）

````
## [source=slack] kind=post uid=slack:C08...@1762... ts=2025-11-03T15:07:41+09:00
actor: 山崎
channel: #dev-infra

### text
```text
テストメッセージ
````

---

```

例（Git: commit + diff）
```

## [source=git-local] kind=commit uid=git:/path#commit#abc123 ts=2025-11-03T10:21:00+09:00

actor: you
repo: /home/you/repo
refs: sha=abc123

### text

```text
feat: add multipart parser
```

### diff

```diff
+ add parseMultipart()
- TODO: handle binary parts
```

---

```

### 2.4 検索/集約
- 当面は `ripgrep/grep` + `jq` + `awk` で十分。
- 日次サマリ生成時にメモリ上で UID 去重・ソートを実施。

---
- **目的**：JSONL を LLM が読みやすい Markdown に**一時レンダリング**。
- **レコード区切り**：単独行の `---`
- **ヘッダ行（1行）**：
  `## [source=slack] kind=post uid=<uid> ts=<ISO8601>`
- **メタ行（任意・最大5行）**：`actor: ...` / `channel: ...` / `repo: ...` / `action: ...` / `refs: ...`
- **サブセクション**：`### text` / `### comment` / `### diff` / `### reactions` / `### links`
- **本文は必ずコードフェンス**。フェンスは **動的長**（中身のバッククォート最大長+1）または **~ フェンス**。

例（Slack: post）
```

## [source=slack] kind=post uid=slack:C08...@1762... ts=2025-11-03T15:07:41+09:00

actor: 山崎
channel: #dev-infra

### text

```text
テストメッセージ
```

---

```

例（Git: commit + diff）
```

## [source=git-local] kind=commit uid=git:/path#commit#abc123 ts=2025-11-03T10:21:00+09:00

actor: you
repo: /home/you/repo
refs: sha=abc123

### text

```text
feat: add multipart parser
```

### diff

```diff
+ add parseMultipart()
- TODO: handle binary parts
```

---

````

### 2.4 検索/集約
- 当面は `ripgrep/grep` + `jq` + `awk` で十分。
- 日次サマリ生成時にメモリ上で UID 去重・ソートを実施。

---

## 3. 収集アダプタ（Adapters）

> Slack アダプタのみ実装済み。GitHub / Git-local は本仕様をベースに今後実装する。

### 3.1 共通 IF（コア＋ネスト詳細）

```ts
export type EventCore = {
  schema: 'adjutant.event.v1.1';
  uid: string;                 // 一意キー（再生成可能）
  source: 'slack'|'github'|'git-local';
  kind: string;                // post|reaction|commit|pr|review|issue|comment|...
  action?: string;             // opened|merged|added|removed|...
  actor?: string;
  subject?: string;            // 見出し（任意）
  ts: string;                  // ISO8601（JST推奨）
  logged_at?: string;          // 取り込み時刻
  meta?: {
    transport?: 'cdp'|'workflow'|'events_api'|string;
    [k: string]: unknown;
  };
};

export type SlackDetail =
  | {
      type: 'post';
      channel_id: string;
      channel_name?: string;
      text?: string;
      blocks?: unknown;
      thread_ts?: string;
    }
  | {
      type: 'reaction';
      message_ts: string;
      channel_id: string;
      channel_name?: string;
      emoji?: string;
    }
  | {
      type: 'trigger';
      channel_id?: string;
      channel_name?: string;
      trigger_id?: string;
      workflow_id?: string;
      text?: string;
      payload?: unknown;
    };

export type GithubDetail = {
  repo: string; number?: number; title?: string; state?: string;
  head?: string; base?: string; html_url?: string;
};

export type GitLocalDetail = {
  repo_path: string; sha: string; branch?: string; files?: string[]; patch?: string;
};

export type EventDetail =
  | { slack: SlackDetail }
  | { github: GithubDetail }
  | { git_local: GitLocalDetail };

export type NormalizedEvent = EventCore & { detail?: EventDetail };

export interface IngestionAdapter {
  name: string;
  start(emit: (ev: NormalizedEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
}
````

**運用上の注意**

- コアに置くのは横断集計でよく使う最小集合（`uid/source/kind/ts/actor/subject` など）。
- ソース固有の深い情報は `detail` 側に閉じ込める（型進化の影響を局所化）。
- 将来の互換性のため `schema` を明示。フィールド追加は後方互換で行う。

### 3.2 Slack（複数 transport / 現在は CDP 実装）

- 既存 `SlackAdapter` は `SlackCdpAdapter` の位置付けとし、今後は取得経路ごとにアダプタを追加する。
  - `SlackCdpAdapter`（現行実装）
  - `SlackWorkflowAdapter`（追加予定）
  - `SlackEventsApiAdapter`（将来追加）
- いずれも `IngestionAdapter` を実装し、`source='slack'` は固定、経路差分は `meta.transport` で表現する。

- **取得チャネル**
  - `Fetch.requestPaused`（POST body）：`chat.postMessage` / `reactions.add|remove` の payload を正規化。
  - `Network.webSocketFrameReceived`：リッチテキストやリアルタイム編集をキャッシュ。
  - `Network.responseReceived`：一部 API 応答を補完キャッシュとして利用。
  - **DOM スナップショット**：リアクション検知直後に `Runtime.evaluate` で可視 DOM から本文を抜き出す。DOM 取得は既定で有効（`ADJUTANT_DISABLE_DOM_CAPTURE=1` で無効化可能）。
    - トリガー元は `/api/reactions.*` への Fetch リクエストのみ。Slack クライアントが自分のリアクションを送信する際にだけ DOM 取得が実行される。
    - WebSocket 経由で他ユーザーのリアクションを受信しても DOM キャプチャは発火しない。必要最小限のキャッシュ更新のみを行う。
- **正規化**
  - `kind='post'|'reaction'`
  - `detail.slack.type='post'|'reaction'|'trigger'` を付与して判別可能にする
  - `subject`：`[#{channel}] メッセージの先頭120字` など軽量な見出し
  - `detail.slack` へ `channel_id / channel_name / text / blocks / message_ts / emoji` 等を格納
  - `uid`：`slack:{channel_id}@{message_ts}`（リアクションは `:emoji:{action}` を付与し actor でユニーク化）
- **冪等**
  - `uid` で去重
  - DOM キャプチャの成功時に得た本文をキャッシュし、同メッセージの後続リアクションでも再利用する
  - DOM キャプチャを無効化した場合は本文が空文字／`undefined` になる前提（フォールバック無し）

### 3.3 GitHub（最小：Polling / 将来：App+Webhook）※未実装

- **最小実装**：PAT + Octokit で `repos[]` を 5–10 分間隔でポーリング
  - PR/Issue/コメント/レビューの**最新 N 件**を取得
  - `uid` を `gh:{repo}#PR#{number}` / `#issueevent#{id}` / `#comment#{id}`

- **差分**：必要に応じて `GET /pulls/{number}/files` の `patch` をトリムして `diff` に
- **将来**：GitHub App + Webhook → 小型受信サーバ（Fastify/Express）へ

### 3.4 Local Git（hooks）※未実装

- `.git/hooks/post-commit` 等で JSON を生成し、**UNIX ドメインソケット**（Windows は Named Pipe）へ送信
- 受信側で `uid='git:{repo-path}#commit#{sha}'` として保存

---

## 4. サマライザ（LLM／計画中）

> 要約機能はまだ実装されていない。以下はバッチ実装時の設計メモとして維持する。

### 4.1 日次ジョブ（JST）

- **時刻**：23:55 JST（余裕枠）
- **入力**：対象日の `*/events.jsonl` を読み込み→UID 去重→時刻ソート
- **前処理**：
  - 連投のマージ（1分以内 & 同 actor）
  - bot/通知のフィルタ（channel / actor / subject パターン）
  - Slack reaction は**元メッセージへ付加**（近接マージ）

- **レンダリング**：JSONL → **MD‑Record v1** へ変換（本文は動的フェンス）
- **チャンク**：`source×(channel|repo)×(thread|PR|commit)` 単位に 2–4KB 分割
- **サブサマリ → 統合**：最終 Markdown を生成
- **保存**：`<dataDir>/YYYY/MM/DD/summaries/daily.md` へ書き出し（再生成可能）

### 4.2 出力テンプレート（Markdown）

```markdown
# Adjutant 日報 {{YYYY-MM-DD}}

## Slack

- [#channel] 要点 …

## GitHub

- owner/repo PR #123: タイトル …

## Local Git

- ~/work/adjutant: commits 3件 …

## TODO / ブロッカー

- …
```

### 4.3 プロンプト要点

- **役割**：業務日報編集者（冗長禁止 / 要点優先 / 技術語OK）
- **形式**：見出し＋箇条書き、重複排除、80字程度/行
- **機密対策**：人名/トークン/クエリは前処理でマスク

---

## 5. 実行モデル & バッチ

### 5.1 開発モード（`pnpm dev`）

- `scripts/dev.ts` を介して `pnpm dev` を実行すると、Slack の CDP ポート（`CDP_HOST`/`CDP_PORT`。既定 `127.0.0.1:9222`）が開いているかを確認し、必要なら `hack/launch_slack_cdp.sh` を用いて Slack を再起動する。
- `hack/launch_slack_cdp.sh` は macOS で `open -a Slack --args --remote-debugging-port=<port>` を発火し、`curl http://localhost:<port>/json/version` が成功するまで 1 秒間隔で最大 10 回リトライする。試行回数と待機時間は `CDP_WAIT_ATTEMPTS` / `CDP_WAIT_DELAY` で上書きできる。
- CDP が利用可能になると `pnpm start`（バックエンド収集）を起動し、標準出力と `logs/backend-dev.log` にタイムスタンプ付きでログをストリームする。`Ctrl+C` または SIGINT/SIGTERM でプロセスをまとめて停止する。
- 既に Slack が CDP 無効で立ち上がっている場合は停止するかどうかを標準入力で確認し、拒否された場合は安全のため起動を中断する。

### 5.2 `pnpm start`（Slack 収集プロセス）

- `tsx src/index.ts` を起動し、Slack デスクトップアプリ（`app.slack.com`）の CDP へ接続して JSONL に追記する常駐プロセス。
- 環境変数 `ADJUTANT_DATA_DIR` で保存先、`CDP_HOST`/`CDP_PORT` で接続先を上書き可能。
- `ADJUTANT_DISABLE_DOM_CAPTURE=1` を指定すると DOM キャプチャを停止（本文は空になる想定）。

### 5.4 単一起動オーケストレータ（`pnpm run serve` / リリース想定）

- `scripts/serve.ts` を新設し、Slack CDP ヘルパーと JSONL 収集デーモンを**1 コマンドで起動/停止**できるようにする。開発用 `scripts/dev.ts` と同じく `spawn` ベースだが、本番向けの安定性とログ出力に最適化されている。
  - **Slack CDP チェック**：`ensureSlackWithCdp` を共通化し、`--skip-slack-helper` フラグで既に CDP が有効な環境では Slack 再起動を省略できるようにする。
    - Slack が既に起動している場合は必ずユーザーに終了可否を確認する。非対話モードでは自動終了せずエラーで中断し、手動停止を案内する。
  - **バックエンド起動**：`dist/backend/index.js`（`pnpm run build:backend` で生成）を `node` で実行し、ログを `logs/runtime/backend.log` にストリーミング。プロセス終了時は自動でリスタート（最大 5 回、指数バックオフ）。
  - **シグナル処理**：SIGINT/SIGTERM 受信時に子プロセスへ順番に SIGTERM→SIGKILL を送り、すべてのログストリームをクローズしてから終了コード 0 で落ちる。異常終了時は終了コード 1。
  - **構成ファイル読み込み**：デフォルトで `adjutant.config.json` を参照し、`--config` で上書き可能。`dataDir` や `timezone` 等を子プロセスへ環境変数として受け渡す。
- `pnpm run serve`（`node --import tsx scripts/serve.ts`）をリポジトリの標準起動コマンドとし、将来的なネイティブバンドル（`nexe` など）ではこのエントリポイントをラップする。

### 5.6 CLI 拡張（将来）

- `adjutant summary --day 2025-11-03`：JSONL から日次要約を生成
- `adjutant search --q "keyword"`：`rg` + `jq` で検索
- `adjutant export --day 2025-11-03 --out daily-2025-11-03.md`

### 5.7 スケジューリング（将来）

- **Windows**：タスク スケジューラ
- **Linux/macOS**：cron/systemd timer

---

---

## 6.1 デバッグ設定 / 起動例

Slack アダプタは環境変数で挙動を切り替えられる。

| 変数                                                        | 例                                                | 説明                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADJUTANT_DEBUG`                                            | `slack:verbose,slack:domprobe`                    | ドメイン別デバッグログ。`slack:verbose` で Slack アダプタの詳細、`slack:domprobe` で DOM 評価ログ、`slack:network` 等でネットワークイベントを個別に有効化。 |
| `ADJUTANT_DISABLE_DOM_CAPTURE`                              | `1`                                               | DOM 取得を完全に無効化（フォールバックなし、`message_text` は空のまま）。トラブルシュート時のみ使用。                                                       |
| `ADJUTANT_TZ`                                               | `Asia/Tokyo`                                      | タイムゾーン上書き。未指定時は `Asia/Tokyo` を使用。                                                                                                        |
| `ADJUTANT_SLACK_WORKSPACE` / `ADJUTANT_SLACK_WORKSPACE_URL` | `example-team` / `https://example-team.slack.com` | ビューアで Slack パーマリンクを生成する際のベース URL。チームスラッグまたはホスト名を指定する。設定が無い場合はリンクが非表示。                             |

**起動例**

- 通常運用（最小ログ）
  ```bash
  pnpm start
  ```
- DOM 取得を調査しながら実行
  ```bash
  ADJUTANT_DEBUG=slack:verbose,slack:domprobe pnpm start | tee -a debug_dom.log
  ```
- フォールバック検証（DOM無効化）
  ```bash
  ADJUTANT_DISABLE_DOM_CAPTURE=1 ADJUTANT_DEBUG=slack:verbose pnpm start | tee -a debug_fallback.log
  ```

### 手動検証（リアクション DOM キャプチャ）

1. Slack 起動済みの状態で `ADJUTANT_DEBUG=slack:verbose pnpm start` を実行し、リアクションを 1 件追加する。
   - 自分の操作直後に `{"ok":true,...}` の DOM ログと JSONL への記録が生成されることを確認する。
2. 他メンバーのリアクション通知が届くのを待ち、`{"ok":false,...,"reason":"dom-not-found"}` などが追加で現れないことを確認する（WebSocket 経由では DOM キャプチャが発火しないため）。
3. 必要に応じて `ADJUTANT_DISABLE_DOM_CAPTURE=1` で再実行し、DOM キャプチャが無効化されると `message_text` が空のままになるフォールバック挙動を確認する。

````

Slack 以外のソースを含む統合ログの確認には `/data/YY/MM/DD/<source>/events.jsonl` を直接参照する。

---

## 6. 設定ファイル（例：`adjutant.config.json`）

```json
{
"timezone": "Asia/Tokyo",
"dataDir": "./data", // ルートディレクトリ
"slack": { "enabled": true },
"github": {
  "enabled": true,
  "token": "${GH_TOKEN}",
  "repos": ["you/repo1", "you/repo2"],
  "intervalMs": 300000
},
"gitLocal": {
  "enabled": true,
  "socket": "/tmp/adjutant.sock" // Windows は \\.\pipe\adjutant
},
"retention": { "days": 365 }, // ディレクトリ削除でローテーション
"llm": { "model": "gpt-*-mini", "maxChunkChars": 3500 }
}
````

---

## 7. セキュリティ / プライバシ

- **ローカル優先**：`dataDir` と設定/トークンはローカル（権限は本人のみ）
- **マスキング**：LLM投入前に `@user` や `token=...` 等を伏字処理
- **保持**：ディレクトリローテーションで削除（`retention.days`）
- **公開**：外部共有は `summaries/daily.md` のみ（生 JSONL は非公開）

---

## 8. ロギング / エラー処理

- **追記専用**：JSONL は append-only。崩れた行は `.bad` に退避。
- **冪等**：同 uid の重複は要約前処理で去重（最後勝ち）。
- **バックオフ**：GitHub ポーリング/API失敗は指数バックオフ
- **サイズガード**：`text/diff` は最大 N KB、超過はトリム＋`meta.truncated=true`
- **観測性**：`[Adjutant] adapter=slack level=debug` 等の構造化ログ

---

## 9. パフォーマンス / スケール

- 1日あたりのファイルは**数MB〜数十MB**想定。日次ファイルで自然にシャーディング。
- 検索は `rg` + `jq` で高速（必要なら later: DuckDB/SQLite 外部インデックス）。
- GitHub は **最新 N 件**と `updated_at` ウォーターマークで差分取得。

---

## 10. 将来拡張

- **GitHub App + Webhook**（自分 org/repo への限定導入）
- **Jira / Linear / Notion** の軽量取り込み
- **Embedding + クラスタリング**で話題自動整理
- **週次・月次サマリ**、KPT/OKR 連携

---
