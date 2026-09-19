/**
 * Agent 一键安装脚本与二进制分发。
 * - /install.sh  /install.ps1：按请求源动态注入 BASE，复制粘贴一条命令即可完成
 *   下载、配置写入与开机自启（systemd --user / launchd / Scheduled Task）。
 * - /api/agent/download/<file>：反向代理 GitHub 滚动发布 agent-latest 的构建产物，
 *   让被墙区域的机器经本站域名完成下载。文件名白名单限制，防止开放代理滥用。
 * Token 写入 chmod 600 的 env 文件而非命令行参数，避免 ps 泄露。
 */

const AGENT_RELEASE_BASE =
  'https://github.com/vexuni/cloud-ssh/releases/download/agent-latest';

const AGENT_ASSET_PATTERN = /^cloudssh-agent-(linux|darwin|windows)-(x64|arm64)(\.exe)?$/;

const INSTALL_SH = `#!/bin/sh
# cloudssh-agent 一键安装 —— CloudSSH P2P 网关 Agent
#   curl -fsSL __BASE__/install.sh | sh -s -- --token <githubId>:<agentId>:<secret>
# 可选：--server <origin> 覆盖站点地址；--no-service 跳过开机自启
set -eu

BASE="__BASE__"
TOKEN=""
SERVER=""
NO_SERVICE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="\${1#*=}"; shift ;;
    --server) SERVER="$2"; shift 2 ;;
    --server=*) SERVER="\${1#*=}"; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    -h|--help)
      echo "usage: install.sh --token <githubId>:<agentId>:<secret> [--server <origin>] [--no-service]"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TOKEN" ] || { echo "error: --token <githubId>:<agentId>:<secret> is required" >&2; exit 2; }
[ -n "$SERVER" ] || SERVER="$BASE"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  linux)  ASSET_OS=linux ;;
  darwin) ASSET_OS=darwin ;;
  *) echo "unsupported OS: $OS — on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64)  ASSET_ARCH=x64 ;;
  aarch64|arm64) ASSET_ARCH=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET="cloudssh-agent-\${ASSET_OS}-\${ASSET_ARCH}"
URL="$BASE/api/agent/download/$ASSET"
INSTALL_DIR="\${CLOUDSSH_AGENT_DIR:-$HOME/.local/bin}"
CONFIG_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/cloudssh-agent"
BIN="$INSTALL_DIR/cloudssh-agent"
ENV_FILE="$CONFIG_DIR/agent.env"

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
echo "==> downloading $ASSET"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$BIN"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$BIN"
else
  echo "error: curl or wget required" >&2; exit 1
fi
chmod +x "$BIN"

# 凭据写入 600 权限的 env 文件，token 不进命令行
umask 077
cat > "$ENV_FILE" <<EOF
AGENT_TOKEN=$TOKEN
AGENT_SERVER=$SERVER
EOF
umask 022

SIGNAL_URL="$(echo "$SERVER" | sed 's|^http|ws|')/api/agent/ws"
{
  echo "AGENT_SIGNAL_URL=$SIGNAL_URL"
} >> "$ENV_FILE"

start_now() {
  if [ "$NO_SERVICE" = 1 ]; then
    ( set -a; . "$ENV_FILE"; set +a; nohup "$BIN" >/dev/null 2>&1 & )
    echo "==> agent started in background (no autostart; restart manually on boot)"
    return 0
  fi
  return 1
}

install_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/cloudssh-agent.service" <<EOF
[Unit]
Description=CloudSSH P2P Agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$BIN
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload 2>/dev/null || return 1
  systemctl --user enable --now cloudssh-agent 2>/dev/null || return 1
  loginctl enable-linger "$USER" 2>/dev/null || true
  echo "==> systemd user service installed and started (cloudssh-agent)"
  echo "    status: systemctl --user status cloudssh-agent"
  return 0
}

install_launchd() {
  [ "$ASSET_OS" = darwin ] || return 1
  PLIST="$HOME/Library/LaunchAgents/online.lemonhub.cloudssh-agent.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>online.lemonhub.cloudssh-agent</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>AGENT_TOKEN</key><string>$TOKEN</string>
    <key>AGENT_SERVER</key><string>$SERVER</string>
    <key>AGENT_SIGNAL_URL</key><string>$SIGNAL_URL</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
  chmod 600 "$PLIST"
  launchctl bootout "gui/$(id -u)/online.lemonhub.cloudssh-agent" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || return 1
  echo "==> launchd agent installed and started"
  return 0
}

if [ "$NO_SERVICE" = 0 ]; then
  if install_systemd; then :;
  elif install_launchd; then :;
  else
    NO_SERVICE=1
  fi
fi
start_now || true

echo ""
echo "==> cloudssh-agent installed: $BIN"
echo "    config: $ENV_FILE (token redacted from command line)"
echo "    verify: $BIN --version"
echo "    the agent should appear online in the CloudSSH Agent panel within seconds"
`;

const INSTALL_PS1 = `# cloudssh-agent 一键安装 —— CloudSSH P2P 网关 Agent（Windows）
#   iex "& { $(irm __BASE__/install.ps1) } -Token '<githubId>:<agentId>:<secret>'"
# 可选：-Server <origin> 覆盖站点地址；-NoService 跳过开机自启
param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Server = "__BASE__",
  [switch]$NoService
)
$ErrorActionPreference = 'Stop'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw "unsupported architecture: $env:PROCESSOR_ARCHITECTURE (x64 build only)"
}
$Base = "__BASE__"
$Dir = Join-Path $env:LOCALAPPDATA 'CloudSSHAgent'
$Bin = Join-Path $Dir 'cloudssh-agent.exe'
$EnvFile = Join-Path $Dir 'agent.env'
$Runner = Join-Path $Dir 'run-agent.ps1'
New-Item -ItemType Directory -Force $Dir | Out-Null

Write-Host "==> downloading cloudssh-agent-windows-x64.exe"
Invoke-WebRequest "$Base/api/agent/download/cloudssh-agent-windows-x64.exe" -OutFile $Bin

# 凭据写入 env 文件；计划任务执行包装脚本，token 不进任务命令行
$SignalUrl = ($Server -replace '^http','ws') + '/api/agent/ws'
Set-Content -Path $EnvFile -Encoding ascii -Value @(
  "AGENT_TOKEN=$Token",
  "AGENT_SERVER=$Server",
  "AGENT_SIGNAL_URL=$SignalUrl"
)
Set-Content -Path $Runner -Encoding ascii -Value @(
  'Get-Content "' + $EnvFile + '" | ForEach-Object { $p = $_ -split "=",2; [Environment]::SetEnvironmentVariable($p[0], $p[1]) }',
  '& "' + $Bin + '"'
)

if (-not $NoService) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' \`
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$Runner\`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  Register-ScheduledTask -TaskName 'CloudSSHAgent' -Action $action -Trigger $trigger \`
    -Description 'CloudSSH P2P Agent' -Force | Out-Null
  Start-ScheduledTask -TaskName 'CloudSSHAgent'
  Write-Host "==> scheduled task 'CloudSSHAgent' registered and started"
} else {
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden \`
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \`"$Runner\`""
  Write-Host "==> agent started in background (no autostart)"
}

Write-Host ""
Write-Host "==> cloudssh-agent installed: $Bin"
Write-Host "    config: $EnvFile"
Write-Host "    verify: & $Bin --version"
Write-Host "    the agent should appear online in the CloudSSH Agent panel within seconds"
`;

function withOrigin(script: string, origin: string): string {
  return script.replaceAll('__BASE__', origin);
}

/** 安装脚本响应（无认证；内容按请求源模板化，curl|sh 直接可用）。 */
export function installScriptResponse(request: Request, kind: 'sh' | 'ps1'): Response {
  const origin = new URL(request.url).origin;
  const body = withOrigin(kind === 'sh' ? INSTALL_SH : INSTALL_PS1, origin);
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** GitHub 滚动发布产物的反向代理（文件名白名单）。 */
export async function handleAgentDownload(url: URL): Promise<Response> {
  const file = decodeURIComponent(url.pathname.slice('/api/agent/download/'.length));
  if (!AGENT_ASSET_PATTERN.test(file)) {
    return Response.json({ error: 'Unknown agent asset' }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${AGENT_RELEASE_BASE}/${file}`, { redirect: 'follow' });
  } catch {
    return Response.json({ error: 'Failed to reach release storage' }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: 'Agent build not found — release pipeline may not have run yet' },
      { status: upstream.status === 200 ? 404 : upstream.status }
    );
  }
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${file}"`,
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  return new Response(upstream.body, { headers });
}
