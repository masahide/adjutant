# 260228-s04 Stage 4 Verification Report

## 実施日

- 2026-02-28

## 1) Edge Cases (`Task-AB-VERIFY-002`)

### 実施内容

- cancel edge-case
  - `node --import tsx --test tests/unit/agent-worker-acp/agent-runner-adapter.test.ts`
  - 検証: `AgentRunnerAdapter.cancelSession aborts active run`
- duplicate `idempotencyKey`
  - `node --import tsx --test tests/integration/control-plane-http-sse.test.ts`
  - 検証: `POST /api/commands dedupes same idempotencyKey and rejects conflicting payload`
- long context
  - `node --import tsx --test tests/unit/assistant/agent-runner-compaction.test.ts`
  - 検証: pre-compaction flush 後に context overflow で `session.compact()` リトライ

### 結果

- すべて pass

## 2) Logs / Exceptions (`Task-AB-VERIFY-003`)

### 実施内容

- timeout / worker crash
  - `node --import tsx --test tests/integration/acp-recovery.test.ts`
  - 検証: supervisor の timeout 検知、protocol error、crash restart recovery
- sandbox unavailable
  - `node --import tsx --test tests/unit/sandbox/runtime.test.ts`
  - 検証: `initializeSandboxRuntime fails closed when docker is unavailable`

### 結果

- すべて pass

## 3) Global Checks

### 実施内容

- `pnpm run check`

### 結果

- pass
- format / typecheck / test すべて green

## 4) Live Agent (`Task-AB-VERIFY-006`)

### 実施内容

- `pnpm run test:live-agent`
- 実行環境: `source .env` で `OPENAI_API_KEY` を読み込み
- 実行環境2: `.env` 読み込みで control-plane 実起動し `POST /api/commands` を直接実行

### 結果

- pass
- 出力: `running live agent tests...` / `pass 1`
- control-plane 実行: `STATUS=completed`
- 例: `RUN_ID=session:sess_29ec4325-f488-4f17-b0ee-ec3a396d36a5:run:1`

## 5) WebUI Playwright

### 実施内容

- `playwright-cli` で WebUI を実操作
  - 初期表示確認
  - 送信時の `accepted/update/completed` ログ確認
  - tool call (`tool_call` / `tool_call_update`) ログ確認
  - reload 後の再送確認

### 結果

- 全 4 ケース pass
- ケース定義: `doc/plan/artifacts/260228-s04-webui-playwright-test-cases.md`
- snapshot: `doc/plan/artifacts/260228-s04-webui-*.yml`

## 6) 備考

- live test は現状 scaffold 1 件（`tests/live/live-agent-smoke.test.ts`）のため、実 API 呼び出しの深い検証は今後追加が必要。
