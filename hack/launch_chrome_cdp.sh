#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./hack/launch_chrome_cdp.sh
#   ./hack/launch_chrome_cdp.sh 9333
#   ./hack/launch_chrome_cdp.sh --bind
#   ./hack/launch_chrome_cdp.sh --temp
#   ./hack/launch_chrome_cdp.sh --show

PORT="9222"
BIND_HOST=0
TEMP_PROFILE=0
SHOW_ONLY=0

for a in "$@"; do
  case "$a" in
    --bind) BIND_HOST=1 ;;
    --temp) TEMP_PROFILE=1 ;;
    --show|show) SHOW_ONLY=1 ;;
    ''|*[!0-9]*) ;;
    *) PORT="$a" ;;
  esac
done

pwsh() { powershell.exe -NoProfile -Command "$1" | tr -d '\r'; }

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

get_windows_host_ip() {
  ip route 2>/dev/null | awk '/default/ {print $3; exit}'
}

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

ADDRESS="127.0.0.1"
if [[ "$BIND_HOST" -eq 1 ]]; then
  ADDRESS="$(get_windows_host_ip || true)"
  if [[ -z "$ADDRESS" ]]; then
    echo "[ERROR] Windows host IP を検出できませんでした。" >&2
    exit 1
  fi
fi

ARGS=("--remote-debugging-port=${PORT}" "--remote-debugging-address=${ADDRESS}")
if [[ "$TEMP_PROFILE" -eq 1 ]]; then
  ARGS+=("--user-data-dir=%TEMP%\\chrome-cdp-${PORT}")
fi

echo "[INFO] Launching Chrome (port=${PORT}, addr=${ADDRESS}, temp=${TEMP_PROFILE})"
pwsh "
\$exe = '$CHROME_WIN'
\$args = @($(printf "'%s'," "${ARGS[@]}" | sed 's/,$//'))
Start-Process -FilePath \$exe -ArgumentList \$args -ErrorAction Stop | Out-Null
"

echo "[OK] Launched."
mode="$(detect_wsl_networking_mode || true)"
if [[ "$mode" == "mirrored" ]]; then
  echo "Test: curl http://127.0.0.1:${PORT}/json/version"
else
  host_ip="$(get_windows_host_ip || true)"
  if [[ -n "$host_ip" ]]; then
    echo "Test: curl http://${host_ip}:${PORT}/json/version"
  else
    echo "Test: curl http://127.0.0.1:${PORT}/json/version"
  fi
fi
