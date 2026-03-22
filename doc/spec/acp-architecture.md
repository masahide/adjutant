# ACP 分離アーキテクチャ仕様

## 1. 目的

この文書は、control-plane、agent-worker-acp、collector-slack のプロセス分離と境界契約を定義する。

## 2. プロセス構成

- `control-plane`
  - 親プロセス
  - HTTP / SSE API
  - UI 同居配信
  - worker / collector supervision
- `agent-worker-acp`
  - ACP worker
  - `session/new`, `session/prompt`, `session/cancel`, `session/load`
  - child-originated `session/request_permission`
- `collector-slack`
  - Process RPC child
  - Slack event を `collector/ingest` で親へ送る

## 3. Worker 境界

### 3.1 transport

- JSON-RPC over stdio
- supervisor は `WorkerSupervisor`
- worker entry は `src/agent-worker-acp/stdio-server.ts`

### 3.2 主な method

- `initialize`
- `authenticate`
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/load`
- `session/request_permission`

`session/load` は `ACP_ENABLE_LOAD_SESSION=1` のときだけ有効である。

skills 用の ACP 専用 method は追加しない。`/skill:name` のような explicit invocation は `session/prompt.prompt` にそのまま載せて worker へ渡し、worker 内の `pi-coding-agent` session が展開する。

### 3.3 実行制約

- 同一 `sessionId` の同時 `session/prompt` は `SESSION_BUSY`
- 未知 session は `INVALID_RECORD`
- worker crash / timeout は supervisor 側で検知する
- skills discovery と catalog 注入は worker 内の session 初期化責務であり、ACP schema / HTTP API 契約は変更しない
- guardrail は worker 内の `tool_call` hook で判定し、`review` のときだけ ACP `session/request_permission` を発行する

### 3.4 review 専用 permission handshake

guardrail の permission 制御は ACP の意味論に合わせて `review` 専用で実装する。

- `allow`
  - worker 内のローカル判定でそのまま実行する
- `forbid`
  - worker 内のローカル判定で即拒否する
- `review`
  - worker から control-plane へ `session/request_permission` を送る
  - control-plane は `PermissionGateway` に登録し、UI / SSE へ `permission/requested` を流す
  - user が `allow_once` / `allow_always` / `reject_once` / `reject_always` を返す
  - control-plane は結果を worker に返し、worker が続行または拒否する

guardrail に付随する `reason`, `ruleId`, `policyCandidate`, `workspaceScopeKey` は ACP top-level を拡張せず `_meta.guardrail` に載せる。

## 4. Collector 境界

### 4.1 transport

- JSON-RPC over stdio
- supervisor は `CollectorSupervisor`

### 4.2 主な method

- request: `collector/ingest`
- response: `accepted`

collector は direct mention notification だけを親へ emit し、self activity は `dataDir/state/activity/self/*.jsonl` へ保存する。

## 5. Session / Run 管理

主要コンポーネント:

- `SessionRegistry`
- `SessionBridge`
- `SessionRecoveryStore`
- `WorkerSessionStore`
- `SessionExecutionRegistry`

役割:

- `sessionKey -> sessionId` の解決
- runId 採番
- worker restart 後の session recovery
- 同一 session の多重実行防止

## 6. HTTP / UI 境界

control-plane は主に次を公開する。

- `POST /api/commands`
- `GET /api/snapshot`
- `GET /api/events/stream`
- `GET /api/activity-feed`
- `POST /api/permissions/resolve`
- `POST /api/heartbeat/run`
- `GET /api/heartbeat/last`
- `GET /api/heartbeat/history`

`web-ui` は同一 process 内でこれらを利用する。

pending permission payload は title だけでなく `reason`, `ruleId`, `expiresAt` を含む。UI では guardrail 理由付きの human review として表示する。

## 7. エラーと回復

代表エラー:

- `UNSUPPORTED_CAPABILITY`
- `WORKER_TIMEOUT`
- `WORKER_CRASHED`
- `INVALID_RECORD`
- `SESSION_BUSY`

回復方針:

- worker / collector の異常終了は supervisor が再起動を試みる
- pending request は fail させる
- durable replay は journal / cursor / snapshot を使う部分だけに限定する

## 8. 実装対応

- `src/index.ts`
- `src/control-plane/acp/worker-supervisor.ts`
- `src/control-plane/acp/permission-gateway.ts`
- `src/control-plane/acp/permission-request-handler.ts`
- `src/control-plane/process-rpc/collector-supervisor.ts`
- `src/agent-worker-acp/control-plane-client.ts`
- `src/agent-worker-acp/stdio-server.ts`
- `src/agent-worker-acp/session-store.ts`
- `src/agent-worker-acp/session-execution-registry.ts`
- `src/agent-worker-acp/adapters/agent-runner-adapter.ts`
- `src/assistant/pi-skills.ts`
- `src/assistant/guardrail-extension.ts`
- `src/control-plane/acp/session-recovery-store.ts`
- `src/control-plane/acp/session-registry.ts`

## 9. v1 制約

- 単一ホスト実行のみ想定する
- restart 後の replay、duplicate/conflict 吸収、exactly-once delivery は保証しない
- terminal gateway / FS capability は v1 非スコープ

## 10. 関連文書

- [assistant runtime 仕様](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
- [proactive routing 仕様](/Users/USER/masahide/git/adjutant/doc/spec/proactive-routing.md)
- [sandbox 仕様](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)
