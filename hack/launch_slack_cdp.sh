#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./hack/launch_slack_cdp.sh         # port=9222 で起動
#   ./hack/launch_slack_cdp.sh 9333    # port=9333 で起動
#   ./hack/launch_slack_cdp.sh --show  # 検出した Slack パスだけ表示

ARG1="${1:-9222}"
PORT="$ARG1"
if [[ "$ARG1" == "--show" || "$ARG1" == "show" ]]; then
  SHOW_ONLY=1
  PORT="9222"
else
  SHOW_ONLY=0
fi

OS_NAME="$(uname -s)"

if [[ "$OS_NAME" == "Darwin" ]]; then
  is_mac_cdp_ready() {
    curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>/dev/null
  }

  is_mac_slack_running() {
    pgrep -x "Slack" >/dev/null 2>/dev/null
  }

  stop_mac_slack_process() {
    osascript -e 'tell application "Slack" to quit' >/dev/null 2>/dev/null || true
    if is_mac_slack_running; then
      pkill -x "Slack" >/dev/null 2>/dev/null || true
    fi
  }

  wait_until_mac_slack_stops() {
    local attempts="${SLACK_STOP_WAIT_ATTEMPTS:-10}"
    local delay="${SLACK_STOP_WAIT_DELAY:-1}"
    for ((i = 1; i <= attempts; i++)); do
      if ! is_mac_slack_running; then
        return 0
      fi
      sleep "$delay"
    done
    return 1
  }

  find_mac_slack_exec() {
    local candidate
    for candidate in \
      "/Applications/Slack.app/Contents/MacOS/Slack" \
      "$HOME/Applications/Slack.app/Contents/MacOS/Slack"; do
      if [[ -x "$candidate" ]]; then
        echo "$candidate"
        return 0
      fi
    done

    if command -v mdfind >/dev/null 2>&1; then
      candidate="$(mdfind "kMDItemCFBundleIdentifier == 'com.tinyspeck.slackmacgap'" | head -n1 || true)"
      if [[ -n "$candidate" && -x "$candidate/Contents/MacOS/Slack" ]]; then
        echo "$candidate/Contents/MacOS/Slack"
        return 0
      fi
    fi

    return 1
  }

  mac_exec="$(find_mac_slack_exec || true)"
  if [[ "$SHOW_ONLY" -eq 1 ]]; then
    if [[ -n "$mac_exec" ]]; then
      echo "macOS path: $mac_exec"
      exit 0
    fi
    echo "[ERROR] Slack.app が見つかりませんでした。" >&2
    exit 1
  fi

  if is_mac_cdp_ready; then
    echo "[OK] DevTools endpoint is already reachable: http://127.0.0.1:$PORT/json/version"
    exit 0
  fi

  if is_mac_slack_running; then
    echo "[INFO] Slack is running without reachable CDP endpoint. Restarting Slack..."
    stop_mac_slack_process
    if ! wait_until_mac_slack_stops; then
      echo "[ERROR] Failed to stop existing Slack process on macOS." >&2
      exit 1
    fi
  fi

  echo "[INFO] Launching via open -na (port=$PORT)"
  open -na "Slack" --args "--remote-debugging-port=$PORT" || true
  echo "[OK] Launch command sent. (Check for 'DevTools listening on ws://127.0.0.1:$PORT/...')"

  attempts="${CDP_WAIT_ATTEMPTS:-15}"
  delay="${CDP_WAIT_DELAY:-1}"
  fallback_done=0

  echo "curl http://127.0.0.1:$PORT/json/version"
  for ((i = 1; i <= attempts; i++)); do
    if is_mac_cdp_ready; then
      echo "[OK] DevTools endpoint is reachable: http://127.0.0.1:$PORT/json/version"
      curl -fsS "http://127.0.0.1:$PORT/json/version" || true
      exit 0
    fi

    if [[ "$fallback_done" -eq 0 && "$i" -ge 3 ]]; then
      fallback_done=1
      if [[ -z "$mac_exec" ]]; then
        mac_exec="$(find_mac_slack_exec || true)"
      fi
      if [[ -n "$mac_exec" ]]; then
        echo "[INFO] Retrying launch via app executable: $mac_exec"
        "$mac_exec" "--remote-debugging-port=$PORT" >/dev/null 2>/dev/null &
      fi
    fi

    echo "[WARN] DevTools endpoint not ready yet (attempt $i/$attempts). Retrying in ${delay}s..."
    sleep "$delay"
  done

  echo "[ERROR] DevTools endpoint did not respond after $attempts attempts." >&2
  curl "http://127.0.0.1:$PORT/json/version" || true
  exit 1
fi

pwsh() { powershell.exe -NoProfile -Command "$1" | tr -d '\r'; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

get_wsl_host_ip() {
  if ! command -v ip >/dev/null 2>&1; then
    return 1
  fi
  ip route 2>/dev/null | awk '/default/ {print $3; exit}'
}

add_target() {
  local candidate="$1"
  [[ -z "$candidate" ]] && return 0
  for t in "${targets[@]}"; do
    [[ "$t" == "$candidate" ]] && return 0
  done
  targets+=("$candidate")
}

read_endpoint_host() {
  local endpoint_file=".adjutant/cdp-endpoint.json"
  if [[ -f "$endpoint_file" ]]; then
    sed -nE 's/.*"host"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$endpoint_file" | head -n1
  fi
}

is_slack_running() {
  local count
  count="$(pwsh "(Get-Process -Name 'Slack' -ErrorAction SilentlyContinue | Measure-Object).Count")"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  [[ "$count" -gt 0 ]]
}

is_cdp_ready() {
  local host="$1"
  curl -fsS --connect-timeout 1 --max-time 2 "http://${host}:${PORT}/json/version" >/dev/null 2>/dev/null
}

wait_for_slack_process() {
  local attempts="${SLACK_START_WAIT_ATTEMPTS:-5}"
  local delay="${SLACK_START_WAIT_DELAY:-1}"
  for ((i = 1; i <= attempts; i++)); do
    if is_slack_running; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

stop_slack_process() {
  pwsh "
Get-Process -Name 'Slack' -ErrorAction SilentlyContinue |
  Stop-Process -ErrorAction SilentlyContinue
"
}

wait_until_slack_stops() {
  local attempts="${SLACK_STOP_WAIT_ATTEMPTS:-10}"
  local delay="${SLACK_STOP_WAIT_DELAY:-1}"
  for ((i = 1; i <= attempts; i++)); do
    if ! is_slack_running; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

detect_wsl_networking_mode() {
  pwsh "
\$mode = 'nat'
\$cfg = Join-Path \$env:USERPROFILE '.wslconfig'
if (Test-Path \$cfg) {
  \$line = Get-Content \$cfg | Where-Object { \$_ -match '^\s*networkingMode\s*=' } | Select-Object -First 1
  if (\$line) {
    \$mode = ((\$line -split '=', 2)[1]).Trim().ToLowerInvariant()
  }
}
\$mode
"
}

found_win=""

# 1) PATH 上の Slack.exe（WindowsApps エイリアス）
cmd_slack="$(pwsh "(Get-Command Slack.exe -ErrorAction SilentlyContinue).Source")"
if [[ -n "$cmd_slack" ]]; then
  if [[ "$(pwsh "[IO.File]::Exists('$cmd_slack')")" == "True" ]]; then
    found_win="$cmd_slack"
  fi
fi

# 2) Microsoft Store (MSIX 実体)
if [[ -z "$found_win" ]]; then
msix_root="$(pwsh "(Get-AppxPackage -Name 'com.tinyspeck.slackdesktop' -ErrorAction SilentlyContinue).InstallLocation")"
  if [[ -n "$msix_root" ]]; then
    candidate_win="${msix_root}\\app\\Slack.exe"
    if [[ "$(pwsh "[IO.File]::Exists('$candidate_win')")" == "True" ]]; then
      found_win="$candidate_win"
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
    if [[ "$(pwsh "[IO.File]::Exists('$candidate_win')")" == "True" ]]; then
      found_win="$candidate_win"
    fi
  fi
fi

# 4) Program Files フォールバック
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

if is_cdp_ready "127.0.0.1"; then
  echo "[OK] DevTools endpoint is already reachable: http://127.0.0.1:$PORT/json/version"
  exit 0
fi

if is_slack_running; then
  echo "[INFO] Slack is running without reachable CDP endpoint. Restarting Slack..."
  stop_slack_process
  if ! wait_until_slack_stops; then
    echo "[ERROR] Failed to stop existing Slack process." >&2
    exit 1
  fi
fi

echo "[INFO] Launching via PowerShell Start-Process (port=$PORT)"
pwsh "
\$exe = '$found_win'
\$port = '$PORT'
\$launched = \$false
try {
  Start-Process -FilePath \$exe -ArgumentList @('--remote-debugging-port=' + \$port) -ErrorAction Stop | Out-Null
  \$launched = \$true
} catch {
  # WindowsApps のエイリアス実行で失敗する環境向けフォールバック
}
if (-not \$launched) {
  cmd /c start \"\" \"\$exe\" --remote-debugging-port \$port | Out-Null
}
"

if ! wait_for_slack_process; then
  echo "[WARN] Slack process is not detected yet. Continue with CDP endpoint polling."
fi

echo "[OK] Launched. (Check for 'DevTools listening on ws://127.0.0.1:$PORT/...')"

attempts="${CDP_WAIT_ATTEMPTS:-30}"
delay="${CDP_WAIT_DELAY:-1}"
targets=("127.0.0.1")
add_target "${CDP_HOST:-}"

network_mode="$(detect_wsl_networking_mode || true)"
if [[ -z "$network_mode" ]]; then
  network_mode="nat"
fi
echo "[INFO] WSL networkingMode=${network_mode}"

if [[ "$network_mode" != "mirrored" ]]; then
  if [[ -x "${SCRIPT_DIR}/cdp_portproxy.sh" ]]; then
    echo "[INFO] Ensuring portproxy for NAT-like mode (port=$PORT)"
    "${SCRIPT_DIR}/cdp_portproxy.sh" "$PORT" || true
  fi
  add_target "$(read_endpoint_host || true)"
  host_gateway_ip="$(get_wsl_host_ip || true)"
  add_target "$host_gateway_ip"
fi

for ((i = 1; i <= attempts; i++)); do
  for host in "${targets[@]}"; do
    if is_cdp_ready "$host"; then
      echo "[OK] DevTools endpoint is reachable: http://${host}:${PORT}/json/version"
      exit 0
    fi
  done
  echo "[WARN] DevTools endpoint not ready yet (attempt $i/$attempts). Retrying in ${delay}s..."
  sleep "$delay"
done

echo "[ERROR] DevTools endpoint did not respond after $attempts attempts." >&2
echo "[INFO] Tried endpoints:" >&2
for host in "${targets[@]}"; do
  echo "  - http://${host}:${PORT}/json/version" >&2
done
exit 1
