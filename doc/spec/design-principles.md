# 設計原則と制約

## 1. 目的

この文書は、Adjutant の実装全体に通底する設計原則、既知の制約、将来拡張の方向性を整理する。

## 2. ファイルファースト保存原則

Adjutant は File First を基本とする。

- 正本データはファイルとして保存する
- イベント / メッセージの正本は JSONL とする
- agent memory の正本は Markdown とする
- SQLite は検索や参照高速化のための派生 index として扱う

### 2.1 書き込み順序

基本方針:

1. 正本ファイルへ append / update する
2. 正本書き込み成功後に index 更新や派生処理へ進む
3. 失敗時は正本から再構築できる形を維持する

### 2.2 一貫性モデル

- index 反映は eventual consistency を許容する
- 検索結果と正本の間に短時間のズレがありうる
- 復旧は正本ファイルからの再走査・再 index を基本とする

## 3. 既知の制約

- Slack 収集は CDP と Slack Desktop の DOM / network shape に依存する
- `uid` 去重は主にプロセス内であり、再起動をまたぐ厳密な exactly-once は保証しない
- 永続層は JSONL / Markdown 中心であり、大規模集計は派生 index に依存する
- `POLICY_ROUTING.json` のような policy routing 本実装は現時点の標準経路では未適用
- ACP / worker / collector は単一ホスト実行を前提としている

## 4. 非同期 index 更新の考え方

想定フロー:

1. 正本ファイルへ保存する
2. 差分を index 更新対象として扱う
3. SQLite などの派生ストアを更新する
4. 不整合時は再走査・再構築で回復する

設計要件:

- 派生ストアは冪等更新に寄せる
- 正本喪失を避けるため、派生ストアを先に書かない
- バックアップ / 移行の基準は正本ファイル群とする

## 5. ロードマップメモ

現時点で spec 上に残している主な将来方向:

- GitHub / git-local collector の追加
- cross-source 集計のための検索 / index 強化
- API / UI 仕様の分離と整理
- 旧統合仕様書からの分割完了と参照先の整理

## 6. 実装対応

- `doc/spec/storage.md`
- `doc/spec/memory.md`
- `src/assistant/memory/config.ts`
- `src/assistant/markdown-summary-batch.ts`
- `src/runtime/journal-store.ts`

## 7. 関連文書

- [保存仕様](/Users/USER/masahide/git/adjutant/doc/spec/storage.md)
- [memory 仕様](/Users/USER/masahide/git/adjutant/doc/spec/memory.md)
- [設定仕様](/Users/USER/masahide/git/adjutant/doc/spec/configuration.md)
