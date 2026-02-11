#!/bin/bash
set -euo pipefail

# PowerShell を呼び出して CRLF を除去
pwsh() {
  powershell.exe -NoProfile -Command "$1" | tr -d '\r'
}

to_wsl_path() {
  # Windowsパス -> WSLパス（変換できない場合は空文字）
  if wslpath -u "$1" 2>/dev/null; then
    wslpath -u "$1"
  else
    echo ""
  fi
}

found_win=""
found_wsl=""

exists_win_file() {
  [[ "$(pwsh "[IO.File]::Exists('$1')")" == "True" ]]
}

# 1) PATH 上の Slack.exe（WindowsApps エイリアス）
cmd_slack="$(pwsh "(Get-Command Slack.exe -ErrorAction SilentlyContinue).Source")"
if [[ -n "$cmd_slack" ]] && exists_win_file "$cmd_slack"; then
  found_win="$cmd_slack"
  found_wsl="$(to_wsl_path "$cmd_slack")"
fi

# 2) Microsoft Store (MSIX)
if [[ -z "$found_win" ]]; then
  msix_root="$(pwsh "(Get-AppxPackage -Name 'com.tinyspeck.slackdesktop' -ErrorAction SilentlyContinue).InstallLocation")"
  if [[ -n "$msix_root" ]]; then
    candidate_win="${msix_root}\\app\\Slack.exe"
    if exists_win_file "$candidate_win"; then
      found_win="$candidate_win"
      found_wsl="$(to_wsl_path "$candidate_win")"
    fi
  fi
fi

# 3) 通常インストーラ (%LOCALAPPDATA%\slack\app-*\slack.exe)
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
    if exists_win_file "$candidate_win"; then
      found_win="$candidate_win"
      found_wsl="$(to_wsl_path "$candidate_win")"
    fi
  fi
fi

# 4) Program Files フォールバック
if [[ -z "$found_win" ]]; then
  pf="$(pwsh '$env:ProgramFiles')"
  pf86="$(pwsh '$env:ProgramFiles(x86)')"
  for p in "${pf}\\slack\\slack.exe" "${pf86}\\slack\\slack.exe"; do
    if exists_win_file "$p"; then
      found_win="$p"
      found_wsl="$(to_wsl_path "$p")"
      break
    fi
  done
fi

if [[ -z "$found_win" ]]; then
  echo "Slack.exe が見つかりませんでした。Store版 or 通常版のインストールを確認してください。" >&2
  exit 1
fi

echo "Windows path: $found_win"
if [[ -n "$found_wsl" ]]; then
  echo "WSL path    : $found_wsl"
else
  echo "WSL path    : (変換不可: パスに特殊文字が含まれる等の理由)"
fi

# ついでに起動例（コメントアウトを外して使う）
# port=9222
# powershell.exe -NoProfile -Command "Start-Process -FilePath '$found_win' -ArgumentList @('--remote-debugging-port=' + $env:port)"
