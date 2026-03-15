# 実行コマンド仕様

## 1. 目的

この文書は、Adjutant の主要な実行コマンドと、そのコマンドがどの runtime / script を起動するかを整理する。

## 2. スコープ

### 含むもの

- `package.json` の主要 scripts
- control-plane / worker / collector 関連の起動導線
- 品質ゲートと補助コマンド

### 含まないもの

- 各 runtime の内部仕様
  - `doc/spec/` 配下の各詳細仕様を参照

## 3. 主要起動コマンド

### 3.1 `pnpm start`

```bash
pnpm start
```

- 実体: `tsx src/index.ts`
- control-plane の標準 entrypoint
- HTTP / SSE API、UI 配信、worker supervisor、collector supervisor、heartbeat、flusher、summary batch を統合して起動する

### 3.2 `pnpm dev`

```bash
pnpm dev
```

- 実体: `tsx scripts/dev.ts`
- 開発用導線
- 補助 script 側で Slack / CDP 準備を行ったうえで `pnpm start` を起動する想定

### 3.3 `pnpm serve`

```bash
pnpm serve
```

- 実体: `tsx scripts/serve.ts`
- build 後の backend 実行向け導線

### 3.4 worker 単体起動

```bash
node --import tsx src/agent-worker-acp/stdio-server.ts
```

- ACP worker を単体起動する
- `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load` の検証用

## 4. Build / Test / Check

### 4.1 型・整形・総合チェック

```bash
pnpm run typecheck
pnpm run format
pnpm run check
pnpm run qa
```

- `typecheck`
  - `tsc -p tsconfig.json --noEmit`
- `format`
  - `prettier --check .`
- `check`
  - `format -> typecheck -> test`
- `qa`
  - `check` の alias

### 4.2 テスト

```bash
pnpm run test
pnpm run test:no-docker
pnpm run test:live-agent
pnpm run test:slack
```

- `test`
  - `tests/**/*.test.ts` を `node --import tsx --test` で順次実行
- `test:no-docker`
  - `ADJUTANT_TEST_NO_DOCKER=1` を付けて test を実行
- `test:live-agent`
  - 実 agent 接続の確認 script
- `test:slack`
  - Slack 向け test 群

### 4.3 整形・lint 補助

```bash
pnpm run lint
pnpm run lint:fix
pnpm run format:write
```

## 5. Sandbox / Rawlog / Docs

### 5.1 sandbox image build

```bash
pnpm run sandbox:build
```

- 実体:

```bash
docker build -f Dockerfile.sandbox -t adjutant-sandbox:trixie-slim .
```

### 5.2 raw fetch log 補助

```bash
pnpm run rawlog:prepare
pnpm run rawlog:capture
pnpm run rawlog:analyze
```

- raw fetch log の準備、取得、解析を行う補助 script 群
- 現行標準 runtime の主経路ではなく、解析・検証用途

### 5.3 docs 整合性確認

```bash
pnpm run verify:config-doc-sync
```

- source code が参照する env とドキュメント記載の整合を検査する

## 6. 実装対応

- `package.json`
- `src/index.ts`
- `src/agent-worker-acp/stdio-server.ts`
- `scripts/dev.ts`
- `scripts/serve.ts`
- `scripts/verify-config-doc-sync.ts`

## 7. 関連文書

- [全体像](/Users/USER/masahide/git/adjutant/doc/spec/system-overview.md)
- [assistant runtime 仕様](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
- [ACP 分離アーキテクチャ仕様](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)
