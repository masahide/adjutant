#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./hack/cdp_portproxy.sh show         # 読み取りのみ（sudo不要）
#   ./hack/cdp_portproxy.sh              # setup 9222（sudo 1回）
#   ./hack/cdp_portproxy.sh 9333         # setup 9333（sudo 1回）
#   ./hack/cdp_portproxy.sh remove       # remove 9222（sudo 1回）
#   ./hack/cdp_portproxy.sh remove 9333  # remove 9333（sudo 1回）

OUT_DIR="${OUT_DIR:-.reaclog}"
OUT_FILE="${OUT_FILE:-${OUT_DIR}/cdp-endpoint.json}"
MODE="setup"
PORT="9222"
if [[ $# -ge 1 ]]; then
  case "$1" in
    show)   MODE="show";   PORT="${2:-9222}";;
    remove) MODE="remove"; PORT="${2:-9222}";;
    *)      MODE="setup";  PORT="$1";;
  esac
fi

HOST_IP="$(ip route | awk '/default/ {print $3}')"
if [[ -z "${HOST_IP}" ]]; then
  echo "[ERROR] Windows host IP not detected." >&2
  exit 1
fi
RULE_NAME="CDP ${PORT} from WSL"

win_ps() { powershell.exe -NoProfile -Command "$1" | tr -d '\r'; }

if [[ "$MODE" == "show" ]]; then
  echo "[INFO] Reading settings (no sudo)"
  echo "---- portproxy ----"
  win_ps "netsh interface portproxy show all"
  echo
  echo "---- iphlpsvc ----"
  win_ps "sc query iphlpsvc"
  echo
  echo "---- firewall ----"
  win_ps "Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { \$_.DisplayName -like 'CDP * from WSL' } | Select-Object DisplayName,Enabled,Direction,Action"
  echo "---- Test ----"
  echo "Test   : curl http://${HOST_IP}:${PORT}/json/version"
  echo "Config : ${OUT_FILE} $( [[ -f "$OUT_FILE" ]] && echo '(exists)' || echo '(absent)' )"

  exit 0
fi

echo "[INFO] Using Windows sudo once. HostIP=${HOST_IP}, Port=${PORT}, Mode=${MODE}"

# sudo + PowerShell を「標準入力から」実行（ExecutionPolicyに阻まれない）
# ※ sudo は事前に enable + mode normal（または disableInput）に設定しておくと見やすいです
powershell.exe -NoProfile -Command "sudo powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<PS_EOF
# ==== elevated PowerShell (stdin) ====
# Parameters (埋め込み)
\$HostIp  = '${HOST_IP}'
[int]\$Port = ${PORT}
\$RuleName = '${RULE_NAME}'
\$Mode = '${MODE}'

# 必須サービス（portproxyは IP Helper が必要）
\$svc = Get-Service iphlpsvc -ErrorAction SilentlyContinue
if (\$svc -and \$svc.Status -ne 'Running') { Start-Service iphlpsvc }

if (\$Mode -eq 'remove') {
  Write-Host ("[INFO] Removing: {0}:{1}" -f \$HostIp, \$Port)
  & netsh interface portproxy delete v4tov4 listenaddress=\$HostIp listenport=\$Port
  & netsh advfirewall firewall delete rule name="\$RuleName" | Out-Null
  Write-Host "[OK] Removed"
  & netsh interface portproxy show all
  exit 0
}

Write-Host ("[INFO] Setting: {0}:{1} -> 127.0.0.1:{1}" -f \$HostIp, \$Port)

# 置き換え
& netsh interface portproxy delete v4tov4 listenaddress=\$HostIp listenport=\$Port | Out-Null

# 追加
& netsh interface portproxy add v4tov4 listenaddress=\$HostIp listenport=\$Port connectaddress=127.0.0.1 connectport=\$Port
if (\$LASTEXITCODE -ne 0) { Write-Error "Failed to create portproxy"; exit 1 }

# FW ルール（WSL帯 172.16.0.0/12 限定）
& netsh advfirewall firewall delete rule name="\$RuleName" | Out-Null
& netsh advfirewall firewall add rule name="\$RuleName" dir=in action=allow protocol=TCP localip=\$HostIp localport=\$Port remoteip=172.16.0.0/12 | Out-Null

Write-Host "[OK] Ready"
& netsh interface portproxy show all
# ==== end elevated block ====
PS_EOF

mkdir -p "$OUT_DIR"

if [[ "$MODE" == "remove" ]]; then
  # remove のとき、同じポートを指すファイルなら削除
  if [[ -f "$OUT_FILE" ]]; then
    if grep -q "\"port\"[[:space:]]*:[[:space:]]*${PORT}" "$OUT_FILE"; then
      rm -f "$OUT_FILE"
      echo "[INFO] Removed endpoint file: $OUT_FILE"
    fi
  fi
else
  # setup のとき、エンドポイントを書き出し
  cat >"$OUT_FILE" <<JSON
{
  "host": "${HOST_IP}",
  "port": ${PORT},
  "updatedAt": "$(date -Iseconds)"
}
JSON
  echo "[INFO] Wrote endpoint file: $OUT_FILE"
fi
echo "---------------------------------------------"
echo "Listen : ${HOST_IP}:${PORT}   (from WSL)"
echo "Connect: 127.0.0.1:${PORT}    (Windows/Electron actual)"
echo "Test   : curl http://${HOST_IP}:${PORT}/json/version"
echo "Config : ${OUT_FILE}"
echo "---------------------------------------------"
