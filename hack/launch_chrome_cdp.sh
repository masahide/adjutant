#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./hack/launch_chrome_cdp.sh            # 9222 / 127.0.0.1 (portproxy併用向け)
#   ./hack/launch_chrome_cdp.sh 9333       # 任意ポート
#   ./hack/launch_chrome_cdp.sh --bind     # WSL直アクセス（WindowsブリッジIPにバインド）
#   ./hack/launch_chrome_cdp.sh --temp     # 一時プロファイルで起動
#   ./hack/launch_chrome_cdp.sh --show     # 見つけた chrome.exe のWindowsパスだけ表示

PORT="9222"
BIND_HOST=0
TEMP_PROFILE=0
SHOW_ONLY=0

for a in "$@"; do
  case "$a" in
    --bind) BIND_HOST=1;;
    --temp) TEMP_PROFILE=1;;
    --show) SHOW_ONLY=1;;
    ''|*[!0-9]*) ;;                       # 数字以外は無視（上のフラグで処理）
    *) PORT="$a";;
  esac
done

# PowerShellは“検出”だけに使用（起動は使わない）
pwsh() { powershell.exe -NoProfile -Command "$1" | tr -d '\r'; }

# ---- chrome.exe を Windows 側で検出（優先：PF\x64 → PF\x86 → LocalAppData → Canary）----
CHROME_WIN="$(pwsh '$c=Get-Command chrome.exe -ErrorAction SilentlyContinue; if($c){$c.Path}else{$pf=$env:ProgramFiles;$pf86=${env:ProgramFiles(x86)};$la=$env:LOCALAPPDATA; foreach($p in @(
  (Join-Path $pf   "Google\Chrome\Application\chrome.exe"),
  (Join-Path $pf86 "Google\Chrome\Application\chrome.exe"),
  (Join-Path $la   "Google\Chrome\Application\chrome.exe"),
  (Join-Path $la   "Google\Chrome SxS\Application\chrome.exe")
)){if(Test-Path $p){$p;break}} }')"

if [[ -z "$CHROME_WIN" ]]; then
  echo "[ERROR] chrome.exe が見つかりませんでした。" >&2
  exit 1
fi

echo "Windows path: $CHROME_WIN"
[[ "$SHOW_ONLY" -eq 1 ]] && exit 0

# バインド先（既定は127.0.0.1 → portproxy 併用）
ADDRESS="127.0.0.1"
if [[ $BIND_HOST -eq 1 ]]; then
  ADDRESS="$(ip route | awk '/default/ {print $3}')"
fi

EXTRA=""
if [[ $TEMP_PROFILE -eq 1 ]]; then
  EXTRA=" --user-data-dir=%TEMP%\\chrome-cdp-${PORT}"
fi

echo "[INFO] Launching (cmd.exe): port=$PORT, addr=$ADDRESS, temp=$TEMP_PROFILE"

cmd.exe /c "${CHROME_WIN}" --remote-debugging-port=${PORT}

echo "[OK] Launched."
if [[ $BIND_HOST -eq 1 ]]; then
  echo "WSL直アクセス: curl http://$ADDRESS:$PORT/json/version"
else
  echo "portproxy経由: curl http://$(ip route | awk '/default/ {print $3}'):$PORT/json/version"
fi
