# 260228-s03: ACP構成での legacy 移植ロードマップ（概要）

## 1. 目的

`legacy/impl-20260228` にある運用機能を、現行の ACP 分離アーキテクチャ（`control-plane` / `agent-worker-acp` / `collector` / `deliver`）へ段階移植する。

このドキュメントは「全体の進め方」を示す概要版であり、個別実装の詳細タスクは各フェーズ着手時に別ドキュメントで作成する。

## 2. ゴール（到達状態）

1. Web UI から API 経由で会話実行・状態監視・監査確認ができる。
2. Slack 縦切り（collector -> control-plane -> worker -> deliver）が実プロセスで動作する。
3. `session/prompt` が `pi-coding-agent` 実実装に接続される。
4. 主要運用機能（proactive/heartbeat/memory/sandbox/recovery）が ACP 構成上で再稼働する。
5. `pnpm check` と主要 E2E が継続的に通る。

## 3. 非ゴール（今回やらない）

- 分散実行（Kafka/NATS, マルチホスト）
- DLQ 再投入 UI
- 完全後方互換レイヤ

## 4. 全体フェーズ

### Phase A: pi-coding-agent と WebUI 対話の成立（最優先）

- 目的: まず Web UI から coding agent と対話できる状態を成立させる。
- 範囲: control-plane API, worker 接続, `session/prompt` の `pi-coding-agent` 実接続, Web UI 起動導線。
- 完了条件: ブラウザ操作で 1 run を実行し、`accepted -> update -> completed` を確認できる。

### Phase B: memory / audit / sandbox の再導入

- 目的: ツール実行と運用可観測性を先に回復する。
- 範囲: memory read/write/search, markdown summary batch, agent audit, docker sandbox。
- 範囲（agent-worker-acp）:
  - Pre-compaction memory flush + context compaction 連動
  - `memory_search` / `memory_get` ツール実装（main セッション限定）
- 範囲（control-plane）:
  - 初回実行リチュアル（workspace bootstrap / BOOTSTRAP context 注入）
- 完了条件: WebUI 対話中に memory/sandbox 系ツールと監査参照が一連で検証できる。

### Phase C: collector-slack の本移植

- 目的: Slack から通知を受け取り、ACP 構成へ取り込む。
- 範囲（collector-slack）:
  - Slack CDP接続
  - SlackAdapter
  - DOM capture
  - 名称キャッシュ
  - JSONL追記保存
  - Debug UI
- 完了条件: Slack 通知が `collector/ingest` 経由で control-plane に到達し、処理連携できる。

### Phase D: 運用基盤（queue/recovery）の強化

- 目的: 実運用で必要な制御系を強化する。
- 範囲: queue/idempotency/session persistence/recovery, deliver completion 冪等管理。
- 完了条件: restart 復旧・重複通知吸収・run 再開が統合テストで安定する。

### Phase E: proactive と heartbeat の再導入

- 目的: legacy の自律運用能力を ACP 構成へ再配置する。
- 範囲: route triage, attention window, classifier, pending flusher, watermark, heartbeat。
- 完了条件: proactive/heartbeat の主要シナリオが E2E で再現できる。

### Phase F: 仕上げと安定化

- 目的: 継続開発可能な状態でクローズする。
- 範囲: 設定整理、ドキュメント同期、CI 安定化、移植監査。
- 完了条件: 主要仕様/README/実装が一致し、回帰テストが定常運用できる。

## 4.1 コンポーネント責務（spec 2.1 差分の明示）

- `collector-slack` に実装するもの:
  - Slack CDP接続 / SlackAdapter / DOM capture / 名称キャッシュ / JSONL追記保存 / Debug UI
- `control-plane` に実装するもの:
  - 初回実行リチュアル（workspace bootstrap / BOOTSTRAP context 注入）
- `agent-worker-acp` に実装するもの:
  - Pre-compaction memory flush + context compaction 連動
  - `memory_search` / `memory_get` ツール（main セッション限定）

## 4.2 ACP適合方針（終端レコード）

- 方針:
  - ACP 境界では `session/prompt` の `stopReason` を正とし、標準 `session/update` を進捗通知として利用する。
  - worker から「終端専用の独自インターフェース」を追加することは避ける。
  - 一方で、control-plane 内部では運用要件（永続化/復旧/冪等）を満たすため、終端状態の内部レコードは保持する。
- 内部レコードの扱い:
  - `assistant_final` / `assistant_aborted` / `assistant_error` は protocol ではなく内部状態として扱う。
  - run の最終状態確定後に journal/cursor 連携で commit し、再起動復旧と重複吸収の基準にする。
  - pending flusher / watermark などの後段制御はこの内部終端状態を参照する。

## 5. 優先順位（実装順）

1. `pi-coding-agent` + API + Worker + Web UI の対話導線
2. memory/audit/sandbox（ツール利用可能化）
3. collector-slack 実装（Slack 通知取り込み）
4. queue/idempotency/persistence/recovery
5. proactive/heartbeat
6. 設定整理・ドキュメント同期・CI 安定化

## 6. 成果物の分割方針

各 Phase 開始時に、次の 1 セットを新規作成する。

1. 詳細実装プラン（タスクリスト + 受け入れ条件）
2. 契約テスト計画（contract/integration/e2e）
3. リスクとロールバック方針

## 7. 進行ルール

- 1 Phase ずつ完了させてから次へ進む（並行で広げない）。
- 各 Phase の最後に `pnpm check` と対象 E2E を必須化する。
- 完了チェックは「動くこと + テスト + ドキュメント更新」の 3 点セットで付ける。

## 8. 次アクション

最初に Phase A の詳細プランを作る。

- 対象: API 実体、UI エントリ、`pi-coding-agent` 接続、`accepted -> update -> completed` の E2E
- 出力先候補: `doc/plan/260228-s03-phase-a-implementation-plan.md`
