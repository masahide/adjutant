# Adjutant 仕様インデックス

このディレクトリは、Adjutant 仕様書の正規エントリポイントである。

現時点では、以下の大枠ドキュメントを先に切り出している。

- [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
- [全体像](/Users/USER/masahide/git/adjutant/doc/spec/system-overview.md)
- [機能一覧](/Users/USER/masahide/git/adjutant/doc/spec/feature-catalog.md)
- [詳細仕様インデックス](/Users/USER/masahide/git/adjutant/doc/spec/detail-index.md)
- [収集ランタイム仕様](/Users/USER/masahide/git/adjutant/doc/spec/collector-runtime.md)
- [データモデル仕様](/Users/USER/masahide/git/adjutant/doc/spec/data-model.md)
- [保存仕様](/Users/USER/masahide/git/adjutant/doc/spec/storage.md)
- [設定仕様](/Users/USER/masahide/git/adjutant/doc/spec/configuration.md)
- [assistant runtime 仕様](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
- [proactive routing 仕様](/Users/USER/masahide/git/adjutant/doc/spec/proactive-routing.md)
- [memory 仕様](/Users/USER/masahide/git/adjutant/doc/spec/memory.md)
- [sandbox 仕様](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)
- [ACP 分離アーキテクチャ仕様](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)
- [実行コマンド仕様](/Users/USER/masahide/git/adjutant/doc/spec/command-reference.md)
- [設計原則と制約](/Users/USER/masahide/git/adjutant/doc/spec/design-principles.md)

## 目的

- 仕様を責務ごとに読みやすく分割する
- 概要、全体像、機能一覧、個別仕様の導線を明確にする
- 実装とドキュメントの差分を追いやすくする

## 読み方

- 最初に読む文書
  - [概要](/Users/USER/masahide/git/adjutant/doc/spec/overview.md)
  - [全体像](/Users/USER/masahide/git/adjutant/doc/spec/system-overview.md)
- 実装範囲や機能の所在を把握したいとき
  - [機能一覧](/Users/USER/masahide/git/adjutant/doc/spec/feature-catalog.md)
- 今後の詳細仕様の分割先を確認したいとき
  - [詳細仕様インデックス](/Users/USER/masahide/git/adjutant/doc/spec/detail-index.md)
- 次に詳細へ進むとき
  - [収集ランタイム仕様](/Users/USER/masahide/git/adjutant/doc/spec/collector-runtime.md)
  - [データモデル仕様](/Users/USER/masahide/git/adjutant/doc/spec/data-model.md)
  - [保存仕様](/Users/USER/masahide/git/adjutant/doc/spec/storage.md)
  - [設定仕様](/Users/USER/masahide/git/adjutant/doc/spec/configuration.md)
  - [assistant runtime 仕様](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
  - [proactive routing 仕様](/Users/USER/masahide/git/adjutant/doc/spec/proactive-routing.md)
  - [memory 仕様](/Users/USER/masahide/git/adjutant/doc/spec/memory.md)
  - [sandbox 仕様](/Users/USER/masahide/git/adjutant/doc/spec/sandbox.md)
  - [ACP 分離アーキテクチャ仕様](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)
  - [実行コマンド仕様](/Users/USER/masahide/git/adjutant/doc/spec/command-reference.md)
  - [設計原則と制約](/Users/USER/masahide/git/adjutant/doc/spec/design-principles.md)

## 分割方針

- 新規更新は `doc/spec/` 側を正とする
- 旧統合仕様書の内容は `doc/spec/` へ責務ごとに分割した
- 詳細仕様はドメイン単位で分割する
  - 収集
  - assistant / proactive
  - sandbox
  - ACP
  - データ保存
  - API / UI

## 現時点の優先詳細仕様候補

- 収集ランタイム仕様
- データモデル仕様
- 保存仕様
- 設定仕様
- assistant / proactive 仕様
- sandbox 仕様
- ACP 分離アーキテクチャ仕様
