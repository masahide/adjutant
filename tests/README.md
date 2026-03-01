# tests ディレクトリ方針

- `tests/unit`: 純粋ロジックの単体テスト
- `tests/contract`: スキーマ・境界契約テスト
- `tests/integration`: プロセス間連携を含む統合テスト
- `tests/live`: 外部 API 実接続テスト（`OPENAI_API_KEY` 必須）

実行方針:

- 通常の品質ゲート (`pnpm check`) では `tests/live` を実行しない
- 実 API 検証は `pnpm run test:live-agent` で別実行する
