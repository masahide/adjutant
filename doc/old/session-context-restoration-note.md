# Session Context Restoration Responsibility Note

## 目的

OpenClaw 準拠の責務分離を adjutant で明示する。

- 会話履歴の復元: `SessionManager.buildSessionContext()`（`createAgentSession()` 経由）
- ChatHandler の責務: 実行キュー制御、system event の 1 ターン注入、`## User Message` の受け渡し
- 履歴表示 API: `/api/chat/history` は transcript-reader ベース（表示用途）

## 変更後の方針

- ChatHandler では transcript / memory を再注入しない。
- system event は履歴とは別レイヤの一時入力として注入を継続する。
- モデル送信コンテキストは SessionManager 復元経路に一本化する。

## branch/compaction 検証メモ（手動）

- 実施日: 2026-02-16
- 手順:
  - `sessions.json` と `*.jsonl` に `compaction` / `branch` / `message` を含む transcript を作成
  - `loadRecentSessionEvents()` で読み取り可能であることを確認
  - 同一 `sessionKey` で `ChatHandler.acceptMessage()` を実行し、`runAgent` へ渡る prompt を確認
- 結果:
  - `recentCount=2`（`user`, `assistant`）で transcript は読み取り可能
  - `prompt` は `## User Message\\nnew question` のみ
  - `old branch user` や `## Recent Session Transcript` は prompt に含まれない
- 解釈:
  - branch/compaction を含む transcript が存在しても、ChatHandler の再注入廃止により prompt 側の不整合は発生しない
  - 会話履歴復元の責務は SessionManager 側に限定される
