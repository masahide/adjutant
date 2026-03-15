# 設定仕様

## 1. 目的

この文書は、現行 `src/` 実装が参照する主要な環境変数と既定値を定義する。

## 2. 基本ルール

### 2.1 `.env` 読み込み

主要 entrypoint は project root の `.env` と `.env.local` を自動で読む。

- 読み込み順: `.env` -> `.env.local`
- ただし、すでに process に存在するキーは上書きしない
- 実効優先順位: `export 済み env > .env.local > .env`

### 2.2 パス解決

- 相対 path はその設定を解決するコンポーネント基準で `resolve(...)` される
- `CDP_ENDPOINT_FILE` は collector の `cwd` 基準で解決する
- `ADJUTANT_STATE_DIR`, `ADJUTANT_WORKSPACE_DIR`, `ADJUTANT_DATA_DIR` などの永続パスは絶対化して扱う

## 3. ディレクトリ / ランタイム基底設定

| 変数                     | 既定値                               | 用途                                                         |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------ |
| `ADJUTANT_STATE_DIR`     | `~/.adjutant`                        | control-plane / worker の状態保存先                          |
| `ADJUTANT_WORKSPACE_DIR` | `<stateDir>/workspace`               | agent の workspace                                           |
| `ADJUTANT_DATA_DIR`      | `<stateDir>/data`                    | collector 系保存先                                           |
| `DATA_DIR`               | `ADJUTANT_DATA_DIR` 未指定時のみ使用 | 旧互換の data dir alias                                      |
| `OPENAI_API_KEY`         | 未設定                               | 設定時は外部 agent runner を有効化。未設定時は echo fallback |
| `ADJUTANT_MODEL`         | 未指定                               | agent session に渡すモデル名                                 |

## 4. Collector / Slack

| 変数                               | 既定値                                     | 用途                                   |
| ---------------------------------- | ------------------------------------------ | -------------------------------------- |
| `ADJUTANT_COLLECTOR_SLACK_ENABLED` | `false`                                    | collector-slack 子プロセスを起動するか |
| `ADJUTANT_COLLECTOR_SLACK_ENTRY`   | `src/collector-slack/process-rpc-entry.ts` | collector entrypoint                   |
| `CDP_ENDPOINT_FILE`                | `.adjutant/cdp-endpoint.json`              | CDP endpoint JSON の読み込み先         |
| `CDP_HOST`                         | `127.0.0.1`                                | CDP 接続先ホスト                       |
| `CDP_PORT`                         | `9222`                                     | CDP 接続先ポート                       |
| `ADJUTANT_SLACK_ACCOUNT_ID`        | `default`                                  | collector の account 識別子            |
| `ADJUTANT_SLACK_SELF_USER_IDS`     | 未設定                                     | self user id の CSV                    |
| `ADJUTANT_SLACK_SELF_USER_ID`      | 未設定                                     | self user id の単数 alias              |
| `ADJUTANT_SLACK_WORKSPACE_HOSTS`   | 未設定                                     | `teamId=host` の CSV                   |
| `ADJUTANT_TZ`                      | `Asia/Tokyo`                               | collector と memory writer の時刻基準  |
| `ADJUTANT_DISABLE_DOM_CAPTURE`     | `false`                                    | DOM capture を無効化する               |
| `ADJUTANT_DEBUG_UI`                | `false`                                    | collector debug UI を有効化する        |
| `ADJUTANT_DEBUG_UI_PORT`           | `8787`                                     | collector debug UI ポート              |

collector 標準経路では raw fetch / CDP debug log 系の env は使っていない。旧 script / legacy 用の設定はこの文書の対象外とする。

## 5. Control-plane / HTTP / UI

| 変数                             | 既定値      | 用途                                   |
| -------------------------------- | ----------- | -------------------------------------- |
| `ADJUTANT_CONTROL_PLANE_HOST`    | `127.0.0.1` | HTTP bind host                         |
| `ADJUTANT_CONTROL_PLANE_PORT`    | `3100`      | HTTP bind port                         |
| `ADJUTANT_UI_VITE_MIDDLEWARE`    | `true`      | Vite middleware を同居起動するか       |
| `ADJUTANT_PHASE_B_ROLLOUT_SCOPE` | `main`      | Phase B rollout scope (`main` / `all`) |

## 6. Proactive / Queue / Heartbeat

| 変数                                    | 既定値                        | 用途                                   |
| --------------------------------------- | ----------------------------- | -------------------------------------- |
| `ADJUTANT_ROUTING_IDLE_MS`              | `1000`                        | channel attention window の idle       |
| `ADJUTANT_ROUTING_MAX_WAIT_MS`          | `30000`                       | channel attention window の max wait   |
| `ADJUTANT_ROUTING_DM_IDLE_MS`           | `200`                         | DM attention window の idle            |
| `ADJUTANT_ROUTING_DM_MAX_WAIT_MS`       | `1000`                        | DM attention window の max wait        |
| `ADJUTANT_ROUTING_CONFIDENCE_THRESHOLD` | `0.7`                         | batch classifier の confidence 閾値    |
| `ADJUTANT_GLOBAL_MAX_CONCURRENT`        | `3`                           | global queue 同時実行上限              |
| `ADJUTANT_GLOBAL_DM_BURST_SLOT`         | `1`                           | DM burst slot                          |
| `ADJUTANT_GLOBAL_MAX_RUNNING_DM`        | `3`                           | DM 同時実行上限                        |
| `ADJUTANT_GLOBAL_STARVATION_MS`         | `120000`                      | starvation 昇格閾値                    |
| `ADJUTANT_FLUSHER_ENABLED`              | `true`                        | pending flusher を有効化するか         |
| `ADJUTANT_FLUSHER_INTERVAL_MS`          | `60000`                       | flusher 実行周期                       |
| `ADJUTANT_FLUSHER_STALE_MS`             | `900000`                      | stale open post 判定閾値               |
| `ADJUTANT_HEARTBEAT_ENABLED`            | `true`                        | heartbeat periodic tick を有効化するか |
| `ADJUTANT_HEARTBEAT_INTERVAL_MS`        | `1800000`                     | heartbeat tick 間隔                    |
| `ADJUTANT_HEARTBEAT_TIMEOUT_MS`         | `30000`                       | heartbeat run timeout                  |
| `ADJUTANT_HEARTBEAT_FILE_PATH`          | `<workspaceDir>/HEARTBEAT.md` | heartbeat prompt 読み込み先            |

## 7. Deliver Slack / Summary Batch / Audit

| 変数                                         | 既定値                                                | 用途                                     |
| -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `ADJUTANT_DELIVER_SLACK_ENABLED`             | `false`                                               | deliver-slack 子プロセスを起動するか     |
| `ADJUTANT_DELIVER_SLACK_ENTRY`               | `src/deliver-slack/stdio-server.ts`                   | deliver-slack entrypoint                 |
| `ADJUTANT_DELIVER_SLACK_AUTO_COMPLETE`       | `true`                                                | enqueue 後に completion を自動送信するか |
| `ADJUTANT_DELIVER_SLACK_COMPLETION_DELAY_MS` | `5`                                                   | completion 送信遅延                      |
| `ADJUTANT_DELIVER_SLACK_SIMULATE_FAILURE`    | `false`                                               | completion を failed にするか            |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED`    | `true`                                                | summary batch を有効化するか             |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_TIMEZONE`   | `UTC`                                                 | summary batch の日付集計タイムゾーン     |
| `ADJUTANT_SESSION_TRANSCRIPTS_DIR`           | `<stateDir>/agents/main/transcripts`                  | summary batch の transcript 入力先       |
| `ADJUTANT_SUMMARY_BATCH_WATERMARK_PATH`      | `<stateDir>/agents/main/summary-batch-watermark.json` | summary batch watermark                  |
| `ADJUTANT_AGENT_AUDIT_LOG_ENABLED`           | `true`                                                | agent audit log を有効化するか           |
| `ADJUTANT_AGENT_AUDIT_LOG_PATH`              | `<stateDir>/audit/agent-audit.ndjson`                 | agent audit log 出力先                   |

## 8. Compaction / Memory

| 変数                                          | 既定値                               | 用途                                            |
| --------------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `ADJUTANT_COMPACTION_ENABLED`                 | `true`                               | context overflow 時の compaction を有効化するか |
| `ADJUTANT_MEMORY_FLUSH_ENABLED`               | `true`                               | pre-compaction memory flush を有効化するか      |
| `ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR`    | `20000`                              | flush 判定用 reserve                            |
| `ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS` | `4000`                               | flush 判定用 soft threshold                     |
| `ADJUTANT_MEMORY_FLUSH_PROMPT`                | 組み込み既定文                       | flush turn の user prompt                       |
| `ADJUTANT_MEMORY_FLUSH_SYSTEM_PROMPT`         | 組み込み既定文                       | flush turn の system prompt                     |
| `ADJUTANT_MEMORY_SEARCH_ENABLED`              | `true`                               | `tool_hub` の memory search/get を有効化するか  |
| `ADJUTANT_MEMORY_SEARCH_DB_PATH`              | `<stateDir>/memory/<agentId>.sqlite` | memory search index DB                          |
| `ADJUTANT_MEMORY_SEARCH_MAX_RESULTS`          | `5`                                  | memory search の最大結果件数                    |
| `ADJUTANT_MEMORY_SEARCH_MIN_SCORE`            | `0`                                  | memory search の最低スコア                      |

現行 `src/assistant/memory/config.ts` では vector 検索モデルや chunk サイズ関連の env は読んでいない。

## 9. Sandbox

| 変数                                | 既定値                                     | 用途                                      |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------- |
| `ADJUTANT_SANDBOX_MODE`             | `all`                                      | sandbox mode (`off` / `non-main` / `all`) |
| `ADJUTANT_SANDBOX_IMAGE`            | `adjutant-sandbox:trixie-slim`             | Docker image                              |
| `ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE` | `true`                                     | image 不在時に自動 build するか           |
| `ADJUTANT_SANDBOX_CONTAINER_PREFIX` | `adjutant-sandbox`                         | container 名 prefix                       |
| `ADJUTANT_SANDBOX_WORKDIR`          | `/workspace`                               | container 内作業ディレクトリ              |
| `ADJUTANT_SANDBOX_HOME`             | `/home/agent`                              | container 内 `HOME`                       |
| `ADJUTANT_SANDBOX_USER`             | `<host uid>:<host gid>` または `1000:1000` | container 実行 uid/gid                    |
| `ADJUTANT_SANDBOX_ENV_ALLOWLIST`    | 未設定                                     | sandbox に追加で渡す env の CSV           |
| `ADJUTANT_SANDBOX_NETWORK`          | `none`                                     | Docker network                            |
| `ADJUTANT_SANDBOX_PIDS_LIMIT`       | `256`                                      | Docker pids limit                         |
| `ADJUTANT_SANDBOX_MEMORY`           | 未設定                                     | Docker memory / memory-swap limit         |

`LANG`, `LC_ALL`, `TERM`, `TZ` は allowlist の有無にかかわらず sandbox 側で基本 env として扱う。

## 10. ACP / Worker

| 変数                      | 既定値  | 用途                           |
| ------------------------- | ------- | ------------------------------ |
| `ACP_ENABLE_LOAD_SESSION` | `false` | `session/load` capability gate |

`ACP_WORKER_*` は control-plane から worker に bridge される内部 env であり、ユーザー向け設定としては扱わない。

## 11. 実装対応

- `src/runtime/load-project-env.ts`
- `src/runtime/runtime-directories.ts`
- `src/collector-slack/config.ts`
- `src/collector-slack/process-rpc-entry.ts`
- `src/index.ts`
- `src/control-plane/proactive/ingress-service.ts`
- `src/control-plane/proactive/batch-classifier.ts`
- `src/control-plane/audit/agent-audit-log.ts`
- `src/deliver-slack/config.ts`
- `src/deliver-slack/stdio-server.ts`
- `src/assistant/agent-runner.ts`
- `src/assistant/compaction-runtime.ts`
- `src/assistant/memory/config.ts`
- `src/sandbox/config.ts`
- `src/sandbox/config-helpers.ts`

## 12. 関連文書

- [保存仕様](/Users/USER/masahide/git/adjutant/doc/spec/storage.md)
- [収集ランタイム仕様](/Users/USER/masahide/git/adjutant/doc/spec/collector-runtime.md)
- [sandbox 仕様](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)
