#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./hack/launch_slack_cdp.sh         # port=9222 で起動
#   ./hack/launch_slack_cdp.sh 9333    # port=9333 で起動
#   ./hack/launch_slack_cdp.sh --show  # 検出した Slack パスだけ表示

PORT="${1:-9222}"
if [[ "$PORT" == "--show" ]]; then
  SHOW_ONLY=1
  PORT="9222"
else
  SHOW_ONLY=0
fi

OS_NAME="$(uname -s)"

if [[ "$OS_NAME" == "Darwin" ]]; then
  echo "[INFO] Launching via open (port=$PORT)"
  open -a "Slack" --args "--remote-debugging-port=$PORT"
  echo "[OK] Launched. (Check for 'DevTools listening on ws://127.0.0.1:$PORT/...')"
  attempts="${CDP_WAIT_ATTEMPTS:-10}"
  delay="${CDP_WAIT_DELAY:-1}"
  echo "curl http://localhost:$PORT/json/version"
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "http://localhost:$PORT/json/version"; then
      exit 0
    fi
    echo "[WARN] DevTools endpoint not ready yet (attempt $i/$attempts). Retrying in ${delay}s..."
    sleep "$delay"
  done
  echo "[ERROR] DevTools endpoint did not respond after $attempts attempts." >&2
  curl "http://localhost:$PORT/json/version" || true
  exit 1
fi

pwsh() { powershell.exe -NoProfile -Command "$1" | tr -d '\r'; }

found_win=""

# 1) Microsoft Store (MSIX)
msix_root="$(pwsh "(Get-AppxPackage -Name 'com.tinyspeck.slackdesktop' -ErrorAction SilentlyContinue).InstallLocation")"
if [[ -n "$msix_root" ]]; then
  candidate_win="${msix_root}\\app\\Slack.exe"
  if [[ "$(pwsh "[IO.File]::Exists('$candidate_win')")" == "True" ]]; then
    found_win="$candidate_win"
  fi
fi

# 2) 通常インストーラ (%LOCALAPPDATA%\slack\app-*\slack.exe)
if [[ -z "$found_win" ]]; then
  latest_dir="$(pwsh @'
$root = "$env:LOCALAPPDATA\slack"
if (Test-Path $root) {
  Get-ChildItem -Path $root -Directory -Filter 'app-*' |
    Sort-Object Name -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
'@)"
  if [[ -n "$latest_dir" ]]; then
    candidate_win="${latest_dir}\\slack.exe"
    if [[ "$(pwsh "[IO.File]::Exists('$candidate_win')")" == "True" ]]; then
      found_win="$candidate_win"
    fi
  fi
fi

# 3) Program Files フォールバック
if [[ -z "$found_win" ]]; then
  pf="$(pwsh '$env:ProgramFiles')"
  pf86="$(pwsh '$env:ProgramFiles(x86)')"
  for p in "${pf}\\slack\\slack.exe" "${pf86}\\slack\\slack.exe"; do
    if [[ "$(pwsh "[IO.File]::Exists('$p')")" == "True" ]]; then
      found_win="$p"; break
    fi
  done
fi

if [[ -z "$found_win" ]]; then
  echo "[ERROR] Slack.exe が見つかりませんでした。" >&2
  exit 1
fi

echo "Windows path: $found_win"
[[ "$SHOW_ONLY" -eq 1 ]] && exit 0

echo "[INFO] Launching via PowerShell Start-Process (port=$PORT)"
powershell.exe -NoProfile -Command \
  "Start-Process -FilePath '$found_win' -ArgumentList @('--remote-debugging-port=$PORT')"


echo "[OK] Launched. (Check for 'DevTools listening on ws://127.0.0.1:$PORT/...')"
