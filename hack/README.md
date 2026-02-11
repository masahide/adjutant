# Hack Scripts (WSL <-> Windows CDP)

`hack/` には、WSL から Windows 上の Slack/Chrome の CDP に接続するための補助スクリプトがあります。

## Scripts

- `hack/launch_slack_cdp.sh`
  - Slack を CDP 有効 (`--remote-debugging-port`) で起動
  - 既存 Slack が CDP 無効で動いている場合は一度停止して再起動
  - `~/.wslconfig` の `networkingMode` を見て接続先を判断
    - `mirrored`: `127.0.0.1`
    - それ以外: `cdp_portproxy.sh` を利用

- `hack/cdp_portproxy.sh`
  - NAT 系モード向けに Windows `portproxy` と Firewall を設定
  - mirrored では設定をスキップし、エンドポイント情報のみ更新

- `hack/launch_chrome_cdp.sh`
  - Chrome を CDP 有効で起動
  - `--bind` で Windows 側 IP バインド
  - `--temp` で一時プロファイル起動

- `hack/find_slack.sh`
  - Windows 側 Slack 実体パスの確認用

## Typical Usage

```bash
# Slack 起動（既定 9222）
./hack/launch_slack_cdp.sh
curl -sS http://127.0.0.1:9222/json/version | jq .

# NAT モードで明示的に portproxy を確認
./hack/cdp_portproxy.sh show
./hack/cdp_portproxy.sh 9222

# Chrome 起動
./hack/launch_chrome_cdp.sh --temp 9333
```

## Notes

- CDP は認証なしです。外部公開しないでください。
- `cdp_portproxy.sh` の setup/remove は Windows 側の昇格権限が必要です。
