# 260228-s04 インターフェース契約凍結 (Stage 1)

- 作成日: 2026-02-28
- 参照元:
  - `doc/spec/acp-architecture.md` (境界契約)
  - `doc/spec/acp-architecture.md` (Capability Gate 相当の worker 境界 / method 制約)
  - `doc/spec/acp-architecture.md` (エラー分類)
  - `doc/plan/260228-s04-phase-a-b-pi-agent-webui-memory-sandbox.md` 4.1-4.6

## 1. HTTP/SSE 契約

- `POST /api/commands`
  - request: `CommandRequest`
  - response: `AcceptedResponse`
- `GET /api/snapshot`
  - response: `SnapshotResponse`
- `GET /api/events/stream`
  - event: `run/accepted | run/update | run/completed | run/failed | permission/requested | permission/resolved`

定義実体:

- `src/control-plane/contracts/http-api.ts`

## 2. ACP 契約

- baseline methods (必須): `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update`
- optional stable: `authenticate`, `session/load`
- optional unstable: `session/list` (feature flag 有効時のみ)

## 3. 命名規約

- StreamEvent 名称は ACP 内部命名に合わせる
- 区切りは `/` で統一する
- SSE で別命名への変換を行わない

## 4. エラー分類

- `INVALID_REQUEST`
- `UNSUPPORTED_CAPABILITY`
- `ACP_PROTOCOL_ERROR`
- `JOURNAL_APPEND_FAILED`
- `WORKER_TIMEOUT`
- `WORKER_CRASHED`
- `DOWNSTREAM_ERROR`
- `INVALID_RECORD`

## 5. 凍結ルール

- ここで定義した契約を変更する場合は、以下を同時更新すること
  - `doc/spec/acp-architecture.md`
  - `doc/plan/260228-s04-phase-a-b-pi-agent-webui-memory-sandbox.md` (4.x)
  - contract test (`tests/contract/*`)
