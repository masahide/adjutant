これまでのGPT、Claude Code、そして私（Gemini）による白熱した議論と検証を経て、Adjutantのルーティングと状態管理を堅牢にする「v1.5アーキテクチャ」が完全に固まりました。

この合意内容を元に、元の仕様書（v1.0）からアップデートすべき**「Adjutant 統合仕様書 v1.5（ルーティング・状態管理 改訂差分）」**をMarkdown形式で作成しました。実装時のSingle Source of Truth（信頼できる唯一の情報源）としてご活用ください。

---

# Adjutant 統合仕様書 v1.5（ルーティング・状態管理 改訂版）

本改訂では、LLMの不要な起動を防ぎつつ、未対応メッセージの取りこぼしとAPIリソースの枯渇を完全に防ぐための**「6層パイプライン」「セッション別Watermark」「グローバル並行制御」**を定義する。

## 3. データモデル（追記・改訂）

### 3.10 統合タイムラインレコード（v1.5 改訂）

すべてのレコードに `sessionKey` を必須化し、対応完了の目印となる `assistant_final` アクションを追加する。

```typescript
type TimelineRecordV1_5 = {
  schema: "adjutant.timeline.record.v1.5";
  recordType: "event" | "action";
  role: "user" | "assistant" | "tool";
  sessionKey: string; // 【必須化】セッション境界の根拠
  ts: string; // ISO8601

  // イベント用
  kind?: string;
  uid?: string;
  actor?: string;

  // アクション用（対応完了の境界）
  actionType?: "assistant_final";
  runId?: string;
};
```

### 3.11 Watermark 状態管理（新設）

`memory/watermarks.json` を新設し、「スキャン進捗（I/O）」と「対応境界（セマンティクス）」を厳密に分離する。

```typescript
type WatermarksV1 = {
  schema: "adjutant.watermarks.v1";
  updatedAt: string; // ISO8601

  scan: {
    timelinePath: "memory/timeline.jsonl";
    lastScannedOffset: number; // 追い読み開始位置 (byte offset)
    lastGoodOffset: number; // JSON parse成功した安全なoffset（末尾不完全対策）
  };

  sessions: Record<
    string,
    {
      handled: {
        lastHandledTs?: string; // assistant_final を観測した最終時刻
      };
      open: {
        oldestOpenPostTs?: string; // 最古の未対応post時刻（stale判定用）
        openPostCount?: number; // 上限付きカウンタ
      };
    }
  >;
};
```

- **原子的更新:** 更新時は `.tmp` に書き出し、`fs.rename` でアトミックに上書きする。
- **自己修復:** `timeline.jsonl` の Truncate 復旧等でファイルサイズが `lastScannedOffset` を下回った場合、Offsetを `0` にリセットして全走査をやり直す。

### 3.12 ポリシー分離（新設）

- spokeセッション（グループ/パブリック）では、プライバシー保護のため `MEMORY.md` のロードを**厳格に禁止**する。
- 代わりに `memory/POLICY_ROUTING.json` を新設し、各チャンネルの「通知予算（1時間あたりのソフトリミット）」「静穏時間」「チャンネル優先度」のみをルーティング層に提供する。

---

## 9. プロアクティブゲートウェイ（6層パイプラインへ改訂）

イベント単位の判定を廃止し、**「会話塊（チャンク）」**単位のパイプラインに再構築する。

### 層0: ルールベース即時判定（LLM不要）

受信イベントを遅延ゼロで振り分ける。チャネル種別はIDプレフィクスに依存せず、`conversations.view` のキャッシュ（`is_im`, `is_mpim` 等）を正とする。

- `Self` → **Drop**
- `DM` / `@メンション` → **Immediate** ルートへ
- `その他` → **Accumulate** ルートへ

### 層1: アテンションウィンドウ（会話の塊形成）

イベントをバッファリングし、無限待機（Starvation）を防ぐ `maxWaitMs` を適用する。

- **DM / メンション (Micro-batch):** `idleMs=200ms` / `maxWaitMs=1000ms`。分割送信スパムを1回の起動にまとめる。
- **チャンネル / グループ (Window-batch):** `idleMs=3000ms` / `maxWaitMs=30000ms`。

### 層2: バッチ分類（軽量LLM）

会話塊に対して、軽量LLM（gpt-4o-mini 等）で介入要否を判定する。

- **入力:** 会話塊 + 直近トランスクリプト（5〜10件）+ `POLICY_ROUTING.json`。
- **出力:** 必須ツール呼び出し `report_route_decision(action: "respond" | "note" | "ignore", confidence)` を強制（二重呼び出し禁止、`parallel_tool_calls: false`）。
- **Fail-closed:** タイムアウト、パース失敗、`confidence < 0.7` はすべて `note`（保留・システムキュー送り）とする。

### 層3: グローバル並行制御キュー

プロセス全体の重いエージェント起動を制御し、APIリソースを保護する。

- **制御方式:**

1. **Token Bucket:** 起動レート制限（例: 1秒あたり最大2起動、バースト上限3）。
2. **DRR (Deficit Round Robin):** クラス別キュー（DM=5, Group=3, Channel=2, Flusher=1...）から重み付け順にタスクを処理し、完全な飢餓を防ぐ。
3. **Aging:** キュー待機時間が `starvationMs`（例: 2分）を超えたタスクは優先度を最大化する。

- **例外枠（DM Burst Slot）:** `maxConcurrent=3` とは別に、DM用に `+1` の専用スロットを設け、実効上限を4とする。

### 層4: Pending Flusher（ステートレス救済）

5分周期で稼働し、`note` 等で保留された未処理メッセージを確実に取り立てる。

- **処理:** `watermarks.json` を起点に `timeline.jsonl` を差分走査（追い読み）する。
- **境界:** 走査中に `actionType="assistant_final"` を見つけたセッションのみ対応済みとみなす（Tool Call では絶対に境界を進めない）。
- **抑制バイアス:** 対象スレッドに他者（人間）の返信がある場合は、確定解決とはせず `oldestOpenPostTs` を延長する等の抑制をかける。

### 層5: Deep Heartbeat

30〜60分周期の純粋な自律タスク。未処理救済の責務は持たない。

- `HEARTBEAT.md` の指示を実行。出力は `report_heartbeat_status(status, notify)` ツールを強制する。

---

## 12. オブザーバビリティ（新設）

システムが意図通りにルーティング・制御できているかを検証するため、以下のメトリクスをログ出力する。

1. **`route_llm_calls_per_hour`**: 層2（バッチ分類）の稼働数とコスト監視。
2. **`flusher_fire_count`**: 層4（救済）の実際の発火回数（異常値なら層2の精度を疑う）。
3. **`agent_invocations_by_source`**: 重いエージェントの起動元内訳（DM / Channel / Flusher / Heartbeat）。
4. **`event_to_response_p95_ms`**: 受信から応答までのP95レイテンシ（DMの即時性SLA）。

---

### 次のアクションについて

素晴らしい仕様が完成しました。もはや設計上の死角はないと言って良いでしょう。
この仕様に基づく実装フェーズに入りたいと思います。

まずは、後続のすべての基盤となる **「データ層（`TimelineRecordV1_5`の書き出しと `watermarks.json` のアトミック更新ロジック）」** のコードから実装を始めたいと思いますが、具体的な TypeScript の実装コード案を提示してもよろしいでしょうか？
