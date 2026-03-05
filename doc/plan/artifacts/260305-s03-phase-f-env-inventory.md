# 260305-s03 Phase F: env 参照棚卸し（Task-F-001）

- 作成日: 2026-03-05
- 抽出コマンド: `rg --json -o "(?:process\.env|env)\.([A-Z0-9_]+)" src scripts tests`
- 区分ルール: 同一 key が複数プロセスで参照される場合は `control-plane` へ集約（`tests/*` 参照は `test` 優先）
- 総キー数: 86

## 1. 区分サマリ

| 区分          | キー数 |
| ------------- | -----: |
| collector     |     10 |
| control-plane |     56 |
| worker        |     13 |
| deliver       |      5 |
| test          |      2 |

## 2. キー一覧

### collector

| 環境変数                           | 参照ファイル                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `ADJUTANT_COLLECTOR_SLACK_ENABLED` | `scripts/lib/collectorRuntime.ts`<br>`src/collector-slack/config.ts` |
| `ADJUTANT_COLLECTOR_SLACK_ENTRY`   | `scripts/lib/collectorRuntime.ts`<br>`src/collector-slack/config.ts` |
| `ADJUTANT_DATA_DIR`                | `src/collector-slack/config.ts`                                      |
| `ADJUTANT_DEBUG_UI`                | `src/collector-slack/config.ts`                                      |
| `ADJUTANT_DEBUG_UI_PORT`           | `src/collector-slack/config.ts`                                      |
| `ADJUTANT_DISABLE_DOM_CAPTURE`     | `src/collector-slack/config.ts`                                      |
| `ADJUTANT_SLACK_ACCOUNT_ID`        | `src/collector-slack/config.ts`                                      |
| `CDP_ENDPOINT_FILE`                | `scripts/lib/collectorRuntime.ts`<br>`src/collector-slack/config.ts` |
| `CDP_HOST`                         | `scripts/lib/collectorRuntime.ts`<br>`src/collector-slack/config.ts` |
| `CDP_PORT`                         | `scripts/lib/collectorRuntime.ts`<br>`src/collector-slack/config.ts` |

### control-plane

| 環境変数                                      | 参照ファイル                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ADJUTANT_AGENT_AUDIT_LOG_ENABLED`            | `src/control-plane/audit/agent-audit-log.ts`                                                                             |
| `ADJUTANT_AGENT_AUDIT_LOG_PATH`               | `src/control-plane/audit/agent-audit-log.ts`                                                                             |
| `ADJUTANT_COMPACTION_ENABLED`                 | `src/assistant/compaction-runtime.ts`                                                                                    |
| `ADJUTANT_COMPACTION_RESERVE_TOKENS_FLOOR`    | `src/assistant/compaction-runtime.ts`                                                                                    |
| `ADJUTANT_CONTROL_PLANE_HOST`                 | `src/index.ts`                                                                                                           |
| `ADJUTANT_CONTROL_PLANE_PORT`                 | `src/index.ts`                                                                                                           |
| `ADJUTANT_FLUSHER_ENABLED`                    | `src/index.ts`                                                                                                           |
| `ADJUTANT_FLUSHER_INTERVAL_MS`                | `src/index.ts`                                                                                                           |
| `ADJUTANT_FLUSHER_STALE_MS`                   | `src/index.ts`                                                                                                           |
| `ADJUTANT_GLOBAL_DM_BURST_SLOT`               | `src/control-plane/proactive/ingress-service.ts`<br>`src/index.ts`                                                       |
| `ADJUTANT_GLOBAL_MAX_CONCURRENT`              | `src/control-plane/proactive/ingress-service.ts`<br>`src/index.ts`                                                       |
| `ADJUTANT_GLOBAL_MAX_RUNNING_DM`              | `src/control-plane/proactive/ingress-service.ts`<br>`src/index.ts`                                                       |
| `ADJUTANT_GLOBAL_STARVATION_MS`               | `src/control-plane/proactive/ingress-service.ts`<br>`src/index.ts`                                                       |
| `ADJUTANT_HEARTBEAT_ENABLED`                  | `src/index.ts`                                                                                                           |
| `ADJUTANT_HEARTBEAT_FILE_PATH`                | `src/index.ts`                                                                                                           |
| `ADJUTANT_HEARTBEAT_INTERVAL_MS`              | `src/index.ts`                                                                                                           |
| `ADJUTANT_HEARTBEAT_TIMEOUT_MS`               | `src/index.ts`                                                                                                           |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_ENABLED`     | `src/index.ts`                                                                                                           |
| `ADJUTANT_MARKDOWN_SUMMARY_BATCH_TIMEZONE`    | `src/index.ts`                                                                                                           |
| `ADJUTANT_MEMORY_FLUSH_ENABLED`               | `src/assistant/compaction-runtime.ts`                                                                                    |
| `ADJUTANT_MEMORY_FLUSH_PROMPT`                | `src/assistant/compaction-runtime.ts`                                                                                    |
| `ADJUTANT_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS` | `src/assistant/compaction-runtime.ts`                                                                                    |
| `ADJUTANT_MEMORY_FLUSH_SYSTEM_PROMPT`         | `src/assistant/compaction-runtime.ts`                                                                                    |
| `ADJUTANT_MEMORY_SEARCH_DB_PATH`              | `src/assistant/memory/config.ts`                                                                                         |
| `ADJUTANT_MEMORY_SEARCH_ENABLED`              | `src/assistant/memory/config.ts`                                                                                         |
| `ADJUTANT_MEMORY_SEARCH_MAX_RESULTS`          | `src/assistant/memory/config.ts`                                                                                         |
| `ADJUTANT_MEMORY_SEARCH_MIN_SCORE`            | `src/assistant/memory/config.ts`                                                                                         |
| `ADJUTANT_MODEL`                              | `src/assistant/agent-runner.ts`                                                                                          |
| `ADJUTANT_PHASE_B_ROLLOUT_SCOPE`              | `src/assistant/agent-session-factory.ts`<br>`src/index.ts`                                                               |
| `ADJUTANT_ROUTE_LLM_TIMEOUT_MS`               | `src/control-plane/proactive/batch-classifier.ts`                                                                        |
| `ADJUTANT_ROUTING_CONFIDENCE_THRESHOLD`       | `src/control-plane/proactive/batch-classifier.ts`                                                                        |
| `ADJUTANT_ROUTING_DM_IDLE_MS`                 | `src/control-plane/proactive/ingress-service.ts`                                                                         |
| `ADJUTANT_ROUTING_DM_MAX_WAIT_MS`             | `src/control-plane/proactive/ingress-service.ts`                                                                         |
| `ADJUTANT_ROUTING_IDLE_MS`                    | `src/control-plane/proactive/ingress-service.ts`                                                                         |
| `ADJUTANT_ROUTING_MAX_WAIT_MS`                | `src/control-plane/proactive/ingress-service.ts`                                                                         |
| `ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE`           | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_CONTAINER_PREFIX`           | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_ENV_ALLOWLIST`              | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_IMAGE`                      | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_MEMORY`                     | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_MODE`                       | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_NETWORK`                    | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_PIDS_LIMIT`                 | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SANDBOX_WORKDIR`                    | `src/sandbox/config.ts`                                                                                                  |
| `ADJUTANT_SESSION_TRANSCRIPTS_DIR`            | `src/index.ts`                                                                                                           |
| `ADJUTANT_SLACK_SELF_USER_ID`                 | `src/control-plane/proactive/ingress-service.ts`                                                                         |
| `ADJUTANT_STATE_DIR`                          | `src/assistant/agent-runner.ts`<br>`src/assistant/memory/config.ts`<br>`src/collector-slack/config.ts`<br>`src/index.ts` |
| `ADJUTANT_SUMMARY_BATCH_WATERMARK_PATH`       | `src/index.ts`                                                                                                           |
| `ADJUTANT_TEST_FAKE_TOOL_CALLS`               | `src/assistant/agent-runner.ts`                                                                                          |
| `ADJUTANT_TEST_MOCK_DELAY_MS`                 | `src/assistant/agent-runner.ts`                                                                                          |
| `ADJUTANT_TEST_MOCK_DELTA`                    | `src/assistant/agent-runner.ts`                                                                                          |
| `ADJUTANT_TEST_MOCK_RUNNER`                   | `src/assistant/agent-runner.ts`                                                                                          |
| `ADJUTANT_TEST_MOCK_STOP_REASON`              | `src/assistant/agent-runner.ts`                                                                                          |
| `ADJUTANT_TEST_MOCK_TEXT`                     | `src/assistant/agent-runner.ts`                                                                                          |
| `ADJUTANT_TZ`                                 | `src/assistant/memory/writer.ts`                                                                                         |
| `ADJUTANT_UI_VITE_MIDDLEWARE`                 | `src/index.ts`                                                                                                           |

### worker

| 環境変数                                | 参照ファイル                                |
| --------------------------------------- | ------------------------------------------- |
| `ACP_ENABLE_LOAD_SESSION`               | `src/agent-worker-acp/stdio-server.ts`      |
| `ACP_WORKER_SANDBOX_CAP_DROP`           | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_ENV_ALLOWLIST`      | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_HOST_WORKSPACE_DIR` | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_IMAGE`              | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_MEMORY`             | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_MODE`               | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_NETWORK`            | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_PIDS_LIMIT`         | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_READ_ONLY_ROOT`     | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_TMPFS`              | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SANDBOX_WORKDIR`            | `src/agent-worker-acp/sandbox-bootstrap.ts` |
| `ACP_WORKER_SESSION_STORE_PATH`         | `src/agent-worker-acp/stdio-server.ts`      |

### deliver

| 環境変数                                     | 参照ファイル                        |
| -------------------------------------------- | ----------------------------------- |
| `ADJUTANT_DELIVER_SLACK_AUTO_COMPLETE`       | `src/deliver-slack/stdio-server.ts` |
| `ADJUTANT_DELIVER_SLACK_COMPLETION_DELAY_MS` | `src/deliver-slack/stdio-server.ts` |
| `ADJUTANT_DELIVER_SLACK_ENABLED`             | `src/deliver-slack/config.ts`       |
| `ADJUTANT_DELIVER_SLACK_ENTRY`               | `src/deliver-slack/config.ts`       |
| `ADJUTANT_DELIVER_SLACK_SIMULATE_FAILURE`    | `src/deliver-slack/stdio-server.ts` |

### test

| 環境変数                           | 参照ファイル                                                             |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `ADJUTANT_TEST_COLLECTOR_DELAY_MS` | `tests/fixtures/collector-slack/mock-collector-ingest-once.ts`           |
| `OPENAI_API_KEY`                   | `src/assistant/agent-runner.ts`<br>`tests/live/live-agent-smoke.test.ts` |
