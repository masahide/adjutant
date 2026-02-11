#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./hack/cdp_portproxy.sh show         # 読み取りのみ（sudo不要）
#   ./hack/cdp_portproxy.sh              # setup 9222
#   ./hack/cdp_portproxy.sh 9333         # setup 9333
#   ./hack/cdp_portproxy.sh remove       # remove 9222
#   ./hack/cdp_portproxy.sh remove 9333  # remove 9333

OUT_DIR="${OUT_DIR:-.adjutant}"
OUT_FILE="${OUT_FILE:-${OUT_DIR}/cdp-endpoint.json}"
MODE="setup"
PORT="9222"

if [[ $# -ge 1 ]]; then
  case "$1" in
    show)   MODE="show";   PORT="${2:-9222}" ;;
    remove) MODE="remove"; PORT="${2:-9222}" ;;
    *)      MODE="setup";  PORT="$1" ;;
  esac
fi

win_ps() { powershell.exe -NoProfile -Command "$1" | tr -d '\r'; }

detect_network_mode() {
  win_ps "
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

get_host_ip() {
  ip route 2>/dev/null | awk '/default/ {print $3; exit}'
}

get_wsl_ip() {
  ip -o -4 addr show scope global up 2>/dev/null |
    awk '{split($4,a,"/"); if ($2 != "lo") {print a[1]; exit}}'
}

write_endpoint() {
  local host="$1"
  mkdir -p "$OUT_DIR"
  cat >"$OUT_FILE" <<JSON
{
  "host": "${host}",
  "port": ${PORT},
  "updatedAt": "$(date -Iseconds)"
}
JSON
  echo "[INFO] Wrote endpoint file: $OUT_FILE"
}

network_mode="$(detect_network_mode || true)"
[[ -n "$network_mode" ]] || network_mode="nat"

if [[ "$network_mode" == "mirrored" ]]; then
  if [[ "$MODE" == "show" ]]; then
    echo "[INFO] WSL networkingMode=mirrored"
    echo "[INFO] portproxy is not required."
    echo "Test   : curl http://127.0.0.1:${PORT}/json/version"
    echo "Config : ${OUT_FILE} $( [[ -f "$OUT_FILE" ]] && echo '(exists)' || echo '(absent)' )"
    exit 0
  fi

  if [[ "$MODE" == "remove" ]]; then
    if [[ -f "$OUT_FILE" ]] && grep -q '"host"[[:space:]]*:[[:space:]]*"127.0.0.1"' "$OUT_FILE"; then
      rm -f "$OUT_FILE"
      echo "[INFO] Removed endpoint file: $OUT_FILE"
    fi
    echo "[INFO] WSL networkingMode=mirrored, remove skipped (no portproxy)."
    exit 0
  fi

  write_endpoint "127.0.0.1"
  echo "[INFO] WSL networkingMode=mirrored, portproxy skipped."
  echo "---------------------------------------------"
  echo "Listen : 127.0.0.1:${PORT} (from WSL)"
  echo "Connect: 127.0.0.1:${PORT} (Windows/Electron actual)"
  echo "Test   : curl http://127.0.0.1:${PORT}/json/version"
  echo "Config : ${OUT_FILE}"
  echo "---------------------------------------------"
  exit 0
fi

HOST_IP="$(get_host_ip || true)"
WSL_IP="$(get_wsl_ip || true)"

if [[ -z "$HOST_IP" ]]; then
  echo "[ERROR] Windows host IP not detected from WSL default route." >&2
  exit 1
fi
if [[ -z "$WSL_IP" ]]; then
  echo "[ERROR] WSL IP not detected." >&2
  exit 1
fi

FW_REMOTE_IP="${CDP_REMOTE_IP:-${WSL_IP}/32}"
RULE_NAME="CDP ${PORT} from WSL"

if [[ "$MODE" == "show" ]]; then
  echo "[INFO] WSL networkingMode=${network_mode}"
  echo "---- portproxy ----"
  win_ps "netsh interface portproxy show all"
  echo
  echo "---- iphlpsvc ----"
  win_ps "sc query iphlpsvc"
  echo
  echo "---- firewall ----"
  win_ps "Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { \$_.DisplayName -like 'CDP * from WSL' } | Select-Object DisplayName,Enabled,Direction,Action"
  echo "Firewall remote IP allowlist: ${FW_REMOTE_IP}"
  echo "---- Test ----"
  echo "Test   : curl http://${HOST_IP}:${PORT}/json/version"
  echo "Config : ${OUT_FILE} $( [[ -f "$OUT_FILE" ]] && echo '(exists)' || echo '(absent)' )"
  exit 0
fi

echo "[INFO] Using Windows sudo once. HostIP=${HOST_IP}, WSL_IP=${WSL_IP}, Port=${PORT}, Mode=${MODE}"

powershell.exe -NoProfile -Command "sudo powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<PS_EOF
\$HostIp = '${HOST_IP}'
[int]\$Port = ${PORT}
\$RuleName = '${RULE_NAME}'
\$Mode = '${MODE}'
\$RemoteIp = '${FW_REMOTE_IP}'

\$svc = Get-Service iphlpsvc -ErrorAction SilentlyContinue
if (\$svc -and \$svc.Status -ne 'Running') { Start-Service iphlpsvc }

if (\$Mode -eq 'remove') {
  Write-Host ("[INFO] Removing: {0}:{1}" -f \$HostIp, \$Port)
  & netsh interface portproxy delete v4tov4 listenaddress=\$HostIp listenport=\$Port | Out-Null
  & netsh advfirewall firewall delete rule name="\$RuleName" | Out-Null
  Write-Host "[OK] Removed"
  & netsh interface portproxy show all
  exit 0
}

Write-Host ("[INFO] Setting: {0}:{1} -> 127.0.0.1:{1}" -f \$HostIp, \$Port)
& netsh interface portproxy delete v4tov4 listenaddress=\$HostIp listenport=\$Port | Out-Null
& netsh interface portproxy add v4tov4 listenaddress=\$HostIp listenport=\$Port connectaddress=127.0.0.1 connectport=\$Port
if (\$LASTEXITCODE -ne 0) { Write-Error "Failed to create portproxy"; exit 1 }

& netsh advfirewall firewall delete rule name="\$RuleName" | Out-Null
& netsh advfirewall firewall add rule name="\$RuleName" dir=in action=allow protocol=TCP localport=\$Port remoteip=\$RemoteIp | Out-Null

Write-Host "[OK] Ready"
& netsh interface portproxy show all
PS_EOF

if [[ "$MODE" == "remove" ]]; then
  if [[ -f "$OUT_FILE" ]] && grep -q "\"port\"[[:space:]]*:[[:space:]]*${PORT}" "$OUT_FILE"; then
    rm -f "$OUT_FILE"
    echo "[INFO] Removed endpoint file: $OUT_FILE"
  fi
else
  write_endpoint "$HOST_IP"
fi

echo "---------------------------------------------"
echo "Listen : ${HOST_IP}:${PORT}   (from WSL)"
echo "Connect: 127.0.0.1:${PORT}    (Windows/Electron actual)"
echo "Remote : ${FW_REMOTE_IP}      (Windows Firewall allowlist)"
echo "Test   : curl http://${HOST_IP}:${PORT}/json/version"
echo "Config : ${OUT_FILE}"
echo "---------------------------------------------"
