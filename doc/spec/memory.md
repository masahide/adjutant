# Memory 仕様

## 1. 目的

この文書は、Adjutant の memory read / write と SQLite index の契約を定義する。

## 2. スコープ

### 含むもの

- `tool_hub(provider=memory, action=search|get|write)`
- `MEMORY.md` と `memory/*.md`
- SQLite index の既定 path
- path guard / allowlist

### 含まないもの

- Project Context 注入そのもの
  - [assistant-runtime.md](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)

## 3. Source of Truth

memory の正本は workspace 上の Markdown である。

- `MEMORY.md`
- `memory/YYYY-MM-DD.md`

SQLite は検索用の派生 index であり、正本ではない。

## 4. ToolHub 契約

memory 操作は `tool_hub` 経由で公開される。

- `provider=memory`, `action=search`
- `provider=memory`, `action=get`
- `provider=memory`, `action=write`

公開条件:

- `search` / `get`
  - `memoryScope=main`
  - `ADJUTANT_MEMORY_SEARCH_ENABLED=true`
- `write`
  - `memoryWriteEnabled=true`
  - phase B rollout 条件を満たす

## 5. Search / Get

### 5.1 index path

既定 index path:

```text
<stateDir>/memory/<agentId>.sqlite
```

main session では通常 `<stateDir>/memory/main.sqlite` を使う。

### 5.2 検索契約

主要設定:

- `ADJUTANT_MEMORY_SEARCH_ENABLED`
- `ADJUTANT_MEMORY_SEARCH_DB_PATH`
- `ADJUTANT_MEMORY_SEARCH_MAX_RESULTS`
- `ADJUTANT_MEMORY_SEARCH_MIN_SCORE`

`executeMemorySearchRequest()` は `MEMORY.md` と `memory/*.md` を対象に snippet を返す。

### 5.3 get 契約

`executeMemoryGetRequest()` は次を満たす path だけを読む。

- `MEMORY.md` または `memory/*.md`
- workspace 内
- symlink traversal を起こさない

失敗時は throw ではなく、`disabled` / `error` を含むレスポンスに正規化する。

## 6. Write

`memory/write` の入力:

```json
{
  "content": "string",
  "scope": "daily" | "long-term"
}
```

挙動:

- `scope=daily`
  - `memory/YYYY-MM-DD.md` に追記
- `scope=long-term`
  - `MEMORY.md` を更新

## 7. 実装対応

- `src/assistant/tool-hub-provider-registry.ts`
- `src/assistant/memory/config.ts`
- `src/assistant/memory/tool-definitions.ts`
- `src/assistant/memory/sqlite-index.ts`
- `src/assistant/memory/path-guard.ts`
- `src/assistant/memory/writer.ts`

## 8. 関連文書

- [assistant runtime 仕様](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
- [保存仕様](/Users/USER/masahide/git/adjutant/doc/spec/storage.md)
