# ACP Schema Snapshot

このディレクトリは `agentclientprotocol/agent-client-protocol` upstream の schema snapshot を保持します。

含むファイル:

- `schema.json`
- `meta.json`
- `schema.unstable.json`
- `meta.unstable.json`
- `manifest.json`

更新方法:

```bash
pnpm run acp-schema:update -- --ref main
```

特定 commit や tag に固定する場合:

```bash
pnpm run acp-schema:update -- --ref <commit-or-tag>
```
