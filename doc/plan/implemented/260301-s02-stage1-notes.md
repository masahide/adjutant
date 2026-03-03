# 260301-s02 Stage 1 実施メモ

## Task-AUI-002: runtime 接続パターン確定

- 確認バージョン: `@assistant-ui/react@0.12.14`
- 採用 API:
  - `useExternalStoreRuntime(store)`（stable）
  - `unstable_useRemoteThreadListRuntime(options)`（thread list）
  - `unstable_RemoteThreadListAdapter`（adapter 型）
- 接続方針:
  - `runtimeHook` から `useExternalStoreRuntime` を返す
  - `adapter` は `/api/threads*` を正本に実装する
  - `generateTitle()` は v1 で `assistant-stream` を使ったフェイク応答で対応する

## Task-AUI-005: `/src/index.ts` ルート抽出の設計確定

- 抽出先責務:
  - `src/control-plane/http/chat-api-controller.ts`
    - `/api/chat/messages`
    - `/api/chat/runs/:runId/stream`
    - `/api/chat/history`
    - `/api/chat/abort`
    - `/api/chat/runs/:runId/audit`
  - `src/control-plane/http/thread-api-controller.ts`
    - `/api/threads*`
  - `src/control-plane/http/http-router.ts`
    - method/path ディスパッチ
    - JSON body/レスポンス共通ヘルパー
  - `src/index.ts`
    - DI と server bootstrap のみに縮退
- 非互換回避:
  - `/api/commands`, `/api/events/stream`, `/api/snapshot` は移行期間中も維持

## Task-AUI-006: 既存 `src/ui` 存廃判定

- 判定結果（計画書 §5.6 と一致）:
  - `src/ui/runtime.ts`: Keep
  - `src/ui/minimal-page.ts`: 暫定維持（Stage 4 再判定）
  - `src/ui/components/control-plane-console.tsx`: Replace（Stage 2 以降で移行）
  - `src/ui/components/AuditDetailTab.tsx`: Keep

## Task-AUI-009: init 生成物流用確認

- `vendor/assistant-ui-init-ref/` に計画書記載の候補ファイルが存在することを確認済み
- 本体 `package.json` に不要依存 `@assistant-ui/react-ai-sdk`, `ai`, `@ai-sdk/openai` が混入していないことを確認済み

## Task-AUI-010: `assistant-stream` 導入と整合確認

- `assistant-stream@0.3.4` を `devDependencies` に追加
- あわせて `@assistant-ui/react` を latest (`0.12.14`) に更新
- `@assistant-ui/react-markdown` も `0.12.5` へ更新
- `assistant-stream` は `@assistant-ui/react` 側依存範囲（`^0.3.2`）に収まる
