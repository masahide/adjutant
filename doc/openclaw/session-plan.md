# 以下、vendor/openclaw寄せでの sessionKey 確定案です

  根拠実装は vendor/openclaw/src/routing/session-key.ts:141 と vendor/openclaw/src/routing/session-key.ts:248、vendor/openclaw/src/routing/resolve-route.ts:300 です。

1. 案A（完全準拠）
    - dmScope = "main"（OpenClawデフォルト）
    - DM: agent:{agentId}:main
    - group/channel: agent:{agentId}:{channel}:{kind}:{peerId}
    - thread: :thread:{threadId} をsuffix付与
    - 長所: upstream一致度最大
    - 短所: 複数DM送信者が同一セッションに混在

1. 案B（推奨: 準拠 + 多チャネル/多アカウント向け）
    - dmScope = "per-account-channel-peer" を標準にする
    - DM: agent:{agentId}:{channel}:{accountId}:direct:{senderId}
    - group/channel: agent:{agentId}:{channel}:{kind}:{peerId}（OpenClaw準拠）
    - thread: baseSessionKey:thread:{threadId}（parentSessionKey=baseSessionKey）
    - 長所: OpenClaw方式を維持しつつ、DM混線を防止。Slack以外追加にも強い
    - 短所: セッション数は増える

1. 案C（拡張安全型）
    - DMだけでなくgroup/channelにも常にaccountIdを埋め込む
    - 例: agent:{agentId}:{channel}:{accountId}:{kind}:{peerId}
    - 長所: アカウント衝突を理論上最小化
    - 短所: OpenClaw標準キー形から外れる（互換/移植性低下）

# 結論: 今の要件（Slack以外も近日追加）なら 案B が最適です

  案BでのSlackマッピング（確定文言候補）

- im -> chatType=direct, peerId=senderId
- mpim -> chatType=group, peerId=channelId
- channel -> chatType=channel, peerId=channelId
- group -> chatType=group, peerId=channelId
- threadTsあり -> :thread:{threadTs} を付与

  この内容で doc/openclaw/ext-plan.md の 4.2 をそのまま更新できます。
