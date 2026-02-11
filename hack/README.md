# WSL → Windows アプリ（Slack/Chrome）CDP 接続 & 起動ガイド

WSL から Windows 上アプリの **Chrome DevTools Protocol (CDP)** へ安全に接続するための手順とスクリプト一式です。

- 中継（portproxy）: `hack/cdp_portproxy.sh`
- Slack 起動（CDP有効）: `hack/launch_slack_cdp.sh`
- Chrome 起動（CDP有効）: `hack/launch_chrome_cdp.sh`

> 僕の意見：
>
> 1. まず portproxy を作って（WSL ⇄ Windows の橋渡し）、
> 2. アプリを CDP 有効で起動、
>    という流れが一番トラブル少ないです。

---

## 0. 事前準備（初回だけ）

### 0-1. Windows “sudo” を有効化（管理者 PowerShell）

管理者 PowerShell を一度起動して、以下を実行：

```powershell
sudo config --enable enable
sudo config --mode normal   # もしくは: sudo config --mode disableInput
```

> 代わりに WSL から **自動昇格ワンライナー**でもOK（UACの許可が1回出ます）：

```bash
powershell.exe -NoProfile -Command "Start-Process PowerShell -Verb RunAs -ArgumentList '-NoProfile','-Command','sudo config --enable enable; sudo config --mode normal; Write-Host Done; Start-Sleep 1'"
```

---

## 1. 中継を張る（portproxy）— `hack/cdp_portproxy.sh`

WSL から見える **Windows ブリッジ IP**（例：`172.28.x.1`）で待ち受け、**127.0.0.1** の CDP に中継します。

```bash
# 現状確認（sudo不要）
./hack/cdp_portproxy.sh show

# 作成（既定: 9222）
./hack/cdp_portproxy.sh
# または任意ポート
./hack/cdp_portproxy.sh 9333

# 削除
./hack/cdp_portproxy.sh remove          # 9222
./hack/cdp_portproxy.sh remove 9333     # 9333
```

表示例：

```
---- portproxy ----
Address         Port        Address         Port
--------------- ----------  --------------- ----------
172.28.16.1     9222        127.0.0.1       9222
```

---

## 2. Slack を CDP 有効で起動 — `hack/launch_slack_cdp.sh`

Windows 側の Slack.exe を自動検出し、**PowerShell Start-Process 経由**で CDP 有効起動します。

```bash
# 既定ポート 9222 で起動
./hack/launch_slack_cdp.sh

# 任意ポート
./hack/launch_slack_cdp.sh 9333

# パス表示のみ
./hack/launch_slack_cdp.sh show
```

起動後、ログに
`DevTools listening on ws://127.0.0.1:9222/...`
などが出ていれば成功。

WSL からの確認：

```bash
curl http://$(ip route | awk '/default/ {print $3}'):9222/json/version
```

---

## 3. Chrome を CDP 有効で起動 — `hack/launch_chrome_cdp.sh`

**cmd.exe だけ**で Windows パスをそのまま実行します（UNC回避のため `cd /d %SystemRoot%` を先頭に付与）。
Chrome が常駐していても別プロファイルで確実に CDP を開ける `--temp` も用意。

```bash
# 既定: 9222 / 127.0.0.1 にバインド（portproxy 併用）
./hack/launch_chrome_cdp.sh

# 任意ポート
./hack/launch_chrome_cdp.sh 9333

# 直バインド（portproxy不要で WSL から直接叩く）
./hack/launch_chrome_cdp.sh --bind        # address を WindowsブリッジIP に

# 既存Chromeの影響を受けない（一時プロファイル）
./hack/launch_chrome_cdp.sh --temp
./hack/launch_chrome_cdp.sh --bind --temp 9333

# 検出した Windows パスだけ表示
./hack/launch_chrome_cdp.sh --show
```

WSL からの確認：

```bash
# portproxy 併用の場合（既定）
curl http://$(ip route | awk '/default/ {print $3}'):9222/json/version

# --bind を付けた場合（直バインド）
curl http://$(ip route | awk '/default/ {print $3}'):9333/json/version
```

> うまく起動しない/ポートが開かない場合は `--temp` を推奨（既存インスタンスの影響を回避できます）。
> ※ 既存の Chrome を完全終了する場合は：
> `powershell.exe -NoProfile -Command "Stop-Process -Name chrome -Force"`

---

## 4. 使い分けの目安

- **Slack / Electron 系**は `--remote-debugging-address` を無視して 127.0.0.1 固定になることが多い → **portproxy を使う**のが安定。
- **Chrome**は `--remote-debugging-address` が効く → portproxy なしで **`--bind`（直バインド）**も便利。
- 既存プロセスの影響を排除したいときは **`--temp`** で一時プロファイル。

---

## 5. トラブルシュート

- **UNC パス警告が出る / 起動に失敗**
  - Slack 起動は PowerShell Start-Process を使用（UNCの影響なし）
  - Chrome 起動は `cmd.exe /s /c "cd /d %SystemRoot% & \"<path>\" args"` で UNC を回避済み

- **`remove` しても portproxy が消えない**
  - `sudo config --mode normal` を適用してから `./hack/cdp_portproxy.sh remove` を再実行
  - `show all` に出た `listenaddress` / `listenport` と**完全一致**で削除する

- **`ExecutionPolicy` で .ps1 が実行できない**
  - 本リポのスクリプトは **標準入力で PowerShell を実行**する方式にしてあり、回避済み

- **iphlpsvc が停止している**（portproxyが無効）

  ```bash
  powershell.exe -NoProfile -Command "sc query iphlpsvc"
  powershell.exe -NoProfile -Command "sudo sc start iphlpsvc"
  ```

---

## 6. セキュリティ

- CDP は**認証なし**です。**インターネットへ公開しない**こと。
- 本手順の Firewall ルールは **WSL サブネット (172.16.0.0/12)** のみに限定。さらに絞るなら `remoteip` を個別IPに。
- 使い終わったら `./hack/cdp_portproxy.sh remove` で中継口を閉じる運用が安全。

---

## 7. よく使うコマンドまとめ

```bash
# 中継の作成/確認/削除
./hack/cdp_portproxy.sh
./hack/cdp_portproxy.sh show
./hack/cdp_portproxy.sh remove

# Slack を 9222 で起動
./hack/launch_slack_cdp.sh
curl http://$(ip route | awk '/default/ {print $3}'):9222/json/version

# Chrome を 9333 直バインド + 一時プロファイル
./hack/launch_chrome_cdp.sh --bind --temp 9333
curl http://$(ip route | awk '/default/ {print $3}'):9333/json/version
```
