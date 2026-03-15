# Sandbox 仕様

## 1. 目的

この文書は、Adjutant の Docker sandbox がどの tool をどの条件で container 実行するかを定義する。

## 2. スコープ

### 含むもの

- sandbox mode
- runtime 初期化
- bash / file tools の container 実行
- workspace path restriction
- hardening flags

### 含まないもの

- worker / ACP プロトコル全体
  - [acp-architecture.md](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)

## 3. 有効化条件

`ADJUTANT_SANDBOX_MODE`:

- `off`
  - sandbox 無効
- `non-main`
  - `memoryScope !== "main"` の session だけ sandbox
- `all`
  - heartbeat を除く全 session を sandbox

既定値は `all` である。

## 4. 初期化

`initializeSandboxRuntime()` は起動時に次を行う。

1. config 解決
2. Docker daemon 可用性確認
3. image 存在確認
4. 必要なら `Dockerfile.sandbox` から build
5. `agent-session-factory` へ active sandbox を注入

`mode=off` なら Docker 確認は行わず、host 実行のままにする。

## 5. 対象ツール

sandbox 対象時は次を containerized 版へ差し替える。

- `bash`
- `read`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

custom tool の公開面自体は `tool_hub` のみで、sandbox は標準 tool と実行境界に適用される。

## 6. 実行契約

### 6.1 mount / user / home

- host workspace は container の `/workspace` へ bind mount
- `HOME` は既定 `/home/agent`
- 実行 user は `uid:gid`
  - `ADJUTANT_SANDBOX_USER` 未指定時は host uid/gid を使う
  - 不可環境では `1000:1000`

### 6.2 hardening

主な Docker 引数:

- `--rm`
- `--pull=never`
- `--init`
- `--read-only`
- `--tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777`
- `--tmpfs /run:rw,noexec,nosuid,size=64m,mode=755`
- `--tmpfs /home/agent:rw,exec,nosuid,size=512m,uid=<uid>,gid=<gid>,mode=700`
- `--network bridge`（既定。`ADJUTANT_SANDBOX_NETWORK=none` で遮断可能）
- `--cap-drop ALL`
- `--security-opt no-new-privileges=true`
- `--security-opt seccomp=builtin`
- `--ipc=private`
- `--cgroupns=private`
- `--hostname=sandbox`
- `--pids-limit 256`（既定）

### 6.3 env 伝播

既定 allowlist:

- `LANG`
- `LC_ALL`
- `TERM`
- `TZ`

追加 allowlist は `ADJUTANT_SANDBOX_ENV_ALLOWLIST` で与える。

## 7. File Tool 制約

file tools は workspace path restriction を通して host workspace 外を拒否する。

主な制約:

- 絶対 path でも workspace 外は拒否
- 相対 path は workspace 起点で解決
- symlink traversal を拒否

container 側では host path を `/workspace` へ写像して実行する。

## 8. 実装対応

- `src/sandbox/config.ts`
- `src/sandbox/config-helpers.ts`
- `src/sandbox/runtime.ts`
- `src/sandbox/docker-bash-operations.ts`
- `src/sandbox/path-mapper.ts`
- `src/assistant/containerized-file-tool-operations.ts`
- `src/assistant/workspace-path-restriction.ts`
- `src/assistant/agent-session-factory.ts`

## 9. 関連文書

- [assistant runtime 仕様](/Users/USER/masahide/git/adjutant/doc/spec/assistant-runtime.md)
- [ACP 分離アーキテクチャ](/Users/USER/masahide/git/adjutant/doc/spec/acp-architecture.md)
