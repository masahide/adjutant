# Adjutant プロセス参照ファイルパス一覧

プロセスがランタイムで参照・読み書きする全ファイルパスのリファレンス。

## ベースディレクトリ

| 変数名          | 環境変数                                               | デフォルト値                  | 説明                                            |
| --------------- | ------------------------------------------------------ | ----------------------------- | ----------------------------------------------- |
| `dataDir`       | Collector: `DATA_DIR` / Assistant: `ADJUTANT_DATA_DIR` | `data`                        | データ保存ルート                                |
| `workspaceDir`  | `ADJUTANT_WORKSPACE_DIR`                               | `{stateDir}/workspace`        | ワークスペースルート                            |
| `stateDir`      | `ADJUTANT_STATE_DIR`                                   | `{home}/.adjutant`            | 内部状態保存先                                  |
| `agentStateDir` | —                                                      | `{stateDir}/agents/{agentId}` | エージェント別状態 (agentId デフォルト: `main`) |

---

## 1. Slack イベントデータ

| パス                                      | R/W                           | 定義箇所                                                       |
| ----------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `{dataDir}/YYYY/MM/DD/slack/events.jsonl` | W (Collector) / R (Assistant) | `src/io/jsonlWriter.ts:27`, `src/assistant/event-reader.ts:32` |

## 2. キャッシュ

| パス                                                         | R/W | 定義箇所                                                        |
| ------------------------------------------------------------ | --- | --------------------------------------------------------------- |
| `{dataDir}/_cache/slack/channel-names-by-team/{teamId}.json` | R/W | `src/index.ts:228`, `src/proactive/slack-channel-plugin.ts:129` |
| `{dataDir}/_cache/slack/user-names-by-team/{teamId}.json`    | R/W | `src/index.ts:229`, `src/proactive/slack-channel-plugin.ts:130` |

設定時のベースパスは `.../channel-names-by-team.json` のようにファイル名で渡されるが、`nameCacheRepository.ts` が拡張子を除去してディレクトリ化し、チーム別に `{teamId}.json` を配置する (`src/slack/nameCacheRepository.ts:249,273,369`)。

## 3. デバッグログ

| パス                                | R/W | 環境変数での上書き            | 定義箇所                                                                             |
| ----------------------------------- | --- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `{dataDir}/_debug/cdp-events.jsonl` | W   | `ADJUTANT_CDP_EVENT_LOG_PATH` | `src/runtime/runtime-config-loader.ts:90`, `src/io/cdpEventFileLogger.ts:41,76`      |
| `{dataDir}/_debug/raw-fetch.jsonl`  | W   | `ADJUTANT_RAW_FETCH_LOG_PATH` | `src/runtime/runtime-config-loader.ts:95`, `src/io/rawFetchEventFileLogger.ts:38,57` |

## 4. 設定ファイル

| パス                                | R/W | 環境変数での上書き              | 定義箇所                                   |
| ----------------------------------- | --- | ------------------------------- | ------------------------------------------ |
| `{cwd}/.adjutant/cdp-endpoint.json` | R   | `CDP_ENDPOINT_FILE`             | `src/runtime/config.ts:15`                 |
| (任意パス)                          | R   | `ADJUTANT_CHANNELS_CONFIG_PATH` | `src/runtime/runtime-config-loader.ts:190` |

## 5. メモリーファイル (AI アシスタント)

| パス                                         | R/W | 定義箇所                                                                                                               |
| -------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------- |
| `{workspaceDir}/MEMORY.md`                   | R/W | `src/assistant/memory-paths.ts:62`, `src/assistant/memory-reader.ts:18`, `src/assistant/memory-writer.ts:42`           |
| `{workspaceDir}/memory.md` (別名)            | R   | `src/assistant/workspace-bootstrap.ts:12`                                                                              |
| `{workspaceDir}/memory/YYYY-MM-DD.md` (当日) | R/W | `src/assistant/memory-paths.ts:64`, `src/assistant/memory-writer.ts:33`, `src/assistant/markdown-summary-batch.ts:330` |
| `{workspaceDir}/memory/YYYY-MM-DD.md` (前日) | R   | `src/assistant/memory-paths.ts:65`                                                                                     |

## 6. ワークスペースブートストラップ (プロンプトファイル)

### テンプレート読み込み元

| パス                                   | R/W | 定義箇所                                     |
| -------------------------------------- | --- | -------------------------------------------- |
| `{cwd}/assistant/prompts/AGENTS.md`    | R   | `src/assistant/workspace-bootstrap.ts:14,89` |
| `{cwd}/assistant/prompts/SOUL.md`      | R   | 同上                                         |
| `{cwd}/assistant/prompts/TOOLS.md`     | R   | 同上                                         |
| `{cwd}/assistant/prompts/IDENTITY.md`  | R   | 同上                                         |
| `{cwd}/assistant/prompts/USER.md`      | R   | 同上                                         |
| `{cwd}/assistant/prompts/HEARTBEAT.md` | R   | 同上                                         |
| `{cwd}/assistant/prompts/BOOTSTRAP.md` | R   | 同上                                         |

### ワークスペースに展開されるファイル

初回起動時にテンプレートからコピーされ、以降は読み込みのみ。

| パス                          | R/W              | 定義箇所                                  |
| ----------------------------- | ---------------- | ----------------------------------------- |
| `{workspaceDir}/AGENTS.md`    | R (初期化時 W)   | `src/assistant/workspace-bootstrap.ts:4`  |
| `{workspaceDir}/SOUL.md`      | R (初期化時 W)   | `src/assistant/workspace-bootstrap.ts:5`  |
| `{workspaceDir}/TOOLS.md`     | R (初期化時 W)   | `src/assistant/workspace-bootstrap.ts:6`  |
| `{workspaceDir}/IDENTITY.md`  | R (初期化時 W)   | `src/assistant/workspace-bootstrap.ts:7`  |
| `{workspaceDir}/USER.md`      | R (初期化時 W)   | `src/assistant/workspace-bootstrap.ts:8`  |
| `{workspaceDir}/HEARTBEAT.md` | R (初期化時 W)   | `src/assistant/workspace-bootstrap.ts:9`  |
| `{workspaceDir}/BOOTSTRAP.md` | R (新規 WS のみ) | `src/assistant/workspace-bootstrap.ts:10` |

### ハートビートランナーでの直接参照

| パス                                   | R/W | 定義箇所                                |
| -------------------------------------- | --- | --------------------------------------- |
| `{cwd}/assistant/prompts/HEARTBEAT.md` | R   | `src/assistant/heartbeat-runner.ts:635` |
| `{cwd}/assistant/prompts/SOUL.md`      | R   | `src/assistant/heartbeat-runner.ts:664` |
| `{cwd}/assistant/prompts/USER.md`      | R   | `src/assistant/heartbeat-runner.ts:665` |
| `{cwd}/assistant/prompts/AGENTS.md`    | R   | `src/assistant/heartbeat-runner.ts:668` |

## 7. セッション管理

| パス                                           | R/W | 環境変数での上書き                 | 定義箇所                                                                     |
| ---------------------------------------------- | --- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `{agentStateDir}/sessions/sessions.json`       | R/W | `ADJUTANT_SESSION_ENTRIES_PATH`    | `src/assistant/session-paths.ts`, `src/assistant/session-entry-store.ts`     |
| `{agentStateDir}/sessions/{sessionKey}.jsonl`  | R/W | `ADJUTANT_SESSION_TRANSCRIPTS_DIR` | `src/assistant/session-paths.ts:99`, `src/assistant/transcript-reader.ts:72` |
| `{agentStateDir}/summary-batch-watermark.json` | R/W | —                                  | `src/assistant/session-paths.ts`, `src/assistant/markdown-summary-batch.ts`  |

追加の参照先として `ADJUTANT_TRANSCRIPTS_DIR` が設定されている場合、`{ADJUTANT_TRANSCRIPTS_DIR}/{sessionId}.jsonl` も候補に含まれる (`src/assistant/transcript-reader.ts:99-101`)。

## 8. タイムライン・ウォーターマーク (プロアクティブ機能)

| パス                         | R/W | 環境変数での上書き       | 定義箇所                                                    |
| ---------------------------- | --- | ------------------------ | ----------------------------------------------------------- |
| `{stateDir}/timeline.jsonl`  | R/W | `ADJUTANT_TIMELINE_PATH` | `src/runtime/runtime-config-loader.ts`                      |
| `{stateDir}/watermarks.json` | R/W | — ※1                     | `src/assistant/main.ts`, `src/proactive/watermark-store.ts` |

※1 `resolveWatermarksPath` は `ADJUTANT_WATERMARKS_PATH` をサポートするが、現行ランタイム (`src/assistant/main.ts:286`) が常にパスを直接渡すため実質上書き不可。

## 9. 冪等性ストア

| パス                           | R/W | 環境変数での上書き                | 定義箇所                                                                     |
| ------------------------------ | --- | --------------------------------- | ---------------------------------------------------------------------------- |
| `{stateDir}/idempotency.jsonl` | R/W | `ADJUTANT_IDEMPOTENCY_STORE_PATH` | `src/runtime/runtime-config-loader.ts`, `src/assistant/idempotency-store.ts` |

## 10. ハートビート実行記録

| パス                              | R/W | 定義箇所                            |
| --------------------------------- | --- | ----------------------------------- |
| `{stateDir}/heartbeat-runs.jsonl` | W   | `src/assistant/heartbeat-runner.ts` |

## 11. メモリーサーチ (SQLite DB)

| パス                                 | R/W | 環境変数での上書き               | 定義箇所                                                                          |
| ------------------------------------ | --- | -------------------------------- | --------------------------------------------------------------------------------- |
| `{stateDir}/memory/{agentId}.sqlite` | R/W | `ADJUTANT_MEMORY_SEARCH_DB_PATH` | `src/assistant/memory-search/config.ts`, `src/assistant/memory-search/manager.ts` |

## 12. UI / Vite

| パス                           | R/W  | 定義箇所                    |
| ------------------------------ | ---- | --------------------------- |
| `{cwd}/node_modules/.bin/vite` | 実行 | `src/assistant/main.ts:631` |

## 13. JSONL リカバリ

起動時に以下のパスから `.jsonl` ファイルを自動スキャン・修復する (`src/assistant/main.ts:214-235`, `src/index.ts:57-71`)。

- `{dataDir}/` 配下の全 `.jsonl`
- `{sessionTranscriptsDir}/` 配下の全 `.jsonl`
- `{timelinePath}` (timeline.jsonl)
- `{idempotencyStorePath}` (idempotency.jsonl)

---

## デフォルト設定時のディレクトリツリー

```
{cwd}/
├── .adjutant/
│   └── cdp-endpoint.json                    [R]   CDP接続情報
├── assistant/
│   └── prompts/
│       ├── AGENTS.md                        [R]   テンプレート
│       ├── SOUL.md                          [R]
│       ├── TOOLS.md                         [R]
│       ├── IDENTITY.md                      [R]
│       ├── USER.md                          [R]
│       ├── HEARTBEAT.md                     [R]
│       └── BOOTSTRAP.md                     [R]
├── data/                                    (= dataDir)
│   ├── YYYY/MM/DD/slack/
│   │   └── events.jsonl                     [R/W] Slackイベント
│   ├── _cache/slack/
│   │   ├── channel-names-by-team/
│   │   │   └── {teamId}.json                [R/W] チャンネル名
│   │   └── user-names-by-team/
│   │       └── {teamId}.json                [R/W] ユーザー名
│   └── _debug/
│       ├── cdp-events.jsonl                 [W]   CDPイベントログ
│       └── raw-fetch.jsonl                  [W]   Fetchログ
└── ~/.adjutant/                             (= stateDir)
    ├── workspace/                           (= workspaceDir)
    │   ├── MEMORY.md                        [R/W] 長期記憶
    │   ├── memory.md                        [R]   長期記憶 (別名)
    │   ├── AGENTS.md                        [R]   ブートストラップ
    │   ├── SOUL.md                          [R]
    │   ├── TOOLS.md                         [R]
    │   ├── IDENTITY.md                      [R]
    │   ├── USER.md                          [R]
    │   ├── HEARTBEAT.md                     [R]
    │   ├── BOOTSTRAP.md                     [R]   初期化時のみ
    │   └── memory/
    │       └── YYYY-MM-DD.md                [R/W] 日次メモリー
    ├── timeline.jsonl                       [R/W] タイムライン
    ├── watermarks.json                      [R/W] ウォーターマーク
    ├── idempotency.jsonl                    [R/W] 冪等性ストア
    ├── heartbeat-runs.jsonl                 [W]   HB実行記録
    ├── memory/
    │   └── main.sqlite                      [R/W] メモリーサーチDB
    └── agents/main/
        ├── summary-batch-watermark.json     [R/W] 要約バッチWM
        └── sessions/
            ├── sessions.json                [R/W] セッション一覧
            └── {sessionKey}.jsonl           [R/W] セッション記録
```
