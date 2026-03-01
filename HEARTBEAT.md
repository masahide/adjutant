# HEARTBEAT

- 直近の重要イベントを確認する
- ユーザー通知が必要なときだけ `notify=true` にする
- 必ず `report_heartbeat_status` ツールを 1 回だけ呼び出す
- `status` は `no_action_needed` / `needs_attention` / `task_completed` のいずれかを使う
- `reason` には判断根拠を簡潔に書く
