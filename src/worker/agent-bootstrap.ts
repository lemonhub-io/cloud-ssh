/**
 * Agent 引导装载（bootstrap）远端命令构建与探测结果解析。
 *
 * 中继（DO）SSH 会话复用 exec 通道在目标机上探测/安装/启动 Agent：
 * - 探测：单行 `CS_PROBE ...` 标记输出（exec 不加载登录环境，输出中可能
 *   夹杂 profile 噪音，只认标记行）。
 * - 安装：`curl install.sh` 用户级安装；或下载后 `sudo -S` 跑 --system
 *   （sudo 密码只走 stdin，不进命令行参数/远端 ps）。
 * - 启动：按探测到的服务形态分别生成 systemctl user/system、launchd、
 *   nohup 兜底命令。
 *
 * 全部为纯函数，便于单测断言生成的脚本文本。
 */

export interface AgentProbeResult {
  installed: boolean;
  running: boolean;
  /** 服务形态：决定 agent_start 走哪条路径 */
  service: 'systemd-user' | 'systemd-system' | 'launchd' | 'manual' | 'none';
  /** 探测到的二进制路径（手动安装定位用） */
  bin: string;
  /**
   * env 文件里 AGENT_TOKEN 的第二段（agentId）。有值时前端应按此 ID 绑定
   * 服务器——远端正在跑的 Agent 只会以这个身份注册上线，猜别的会绑错。
   */
  agentId: string;
}

export const PROBE_MARKER = 'CS_PROBE';

/** POSIX 单引号转义：' → '\''。token/URL 等注入 exec 命令前必须过这层。 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 单行探测脚本。要点：
 * - 逐候选路径找二进制，再兜底 command -v；
 * - systemctl --user 在非登录 exec 下常缺 DBus，带 XDG_RUNTIME_DIR 兜底重试；
 * - `pgrep -x cloudssh-agent` 按进程名（comm）精确匹配——探测壳是
 *   sh/bash/node，不会误命中自身（pgrep -f 会命中 sh -c 的整段脚本）；
 * - launchd 判定看 plist 是否存在，运行态看 launchctl list。
 */
export function buildProbeCommand(): string {
  return [
    'cs_b=""; for p in "$HOME/.local/bin/cloudssh-agent" /usr/local/bin/cloudssh-agent /usr/bin/cloudssh-agent; do [ -x "$p" ] && { cs_b="$p"; break; }; done',
    '[ -z "$cs_b" ] && cs_b="$(command -v cloudssh-agent 2>/dev/null)"',
    'cs_svc=none',
    'if command -v systemctl >/dev/null 2>&1; then',
    ' if systemctl --user cat cloudssh-agent.service >/dev/null 2>&1 || DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" systemctl --user cat cloudssh-agent.service >/dev/null 2>&1; then cs_svc=systemd-user;',
    ' elif systemctl cat cloudssh-agent.service >/dev/null 2>&1; then cs_svc=systemd-system; fi',
    'fi',
    '[ "$cs_svc" = none ] && [ -f "$HOME/Library/LaunchAgents/online.lemonhub.cloudssh-agent.plist" ] && cs_svc=launchd',
    'cs_run=0',
    'case "$cs_svc" in',
    ' systemd-user) { systemctl --user is-active --quiet cloudssh-agent 2>/dev/null || DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" systemctl --user is-active --quiet cloudssh-agent 2>/dev/null; } && cs_run=1 ;;',
    ' systemd-system) systemctl is-active --quiet cloudssh-agent 2>/dev/null && cs_run=1 ;;',
    ' launchd) launchctl list 2>/dev/null | grep -q \'cloudssh-ag[e]nt\' && cs_run=1 ;;',
    'esac',
    // pgrep -x 精确匹配进程名（comm）：探测壳是 sh/bash/node，不可能命中自身；
    // SEA 单文件 Agent 的 comm 恒为 cloudssh-agent（14 字符 < 15 上限）。
    // node xxx.js 手动跑法 comm=node 探不到——可接受（一键安装只产 SEA 二进制）
    '[ "$cs_run" = 0 ] && pgrep -x cloudssh-agent >/dev/null 2>&1 && cs_run=1',
    'cs_aid=""; for f in "$HOME/.config/cloudssh-agent/agent.env" /etc/cloudssh-agent/agent.env; do',
    ' [ -r "$f" ] && cs_aid="$(sed -n \'s/^AGENT_TOKEN=[^:]*:\\([^:]*\\):.*/\\1/p\' "$f" 2>/dev/null | head -1)" && [ -n "$cs_aid" ] && break',
    'done',
    'printf \'%s\\n\' "CS_PROBE installed=$([ -n "$cs_b" ] && echo 1 || echo 0) running=$cs_run svc=$cs_svc aid=$cs_aid bin=$cs_b"',
    // 换行连接：if/for/case 的 then/do/in 后不允许直接跟 ';'，newline 恒合法
  ].join('\n');
}

/** 解析 exec 捕获输出中的 CS_PROBE 标记行；无标记（远端非 POSIX/被截断）返回 null。 */
export function parseProbeOutput(stdout: string): AgentProbeResult | null {
  for (const line of stdout.split('\n')) {
    const m = line.match(/^CS_PROBE installed=(\d) running=(\d) svc=(\S+) aid=(\S*) bin=(.*)$/);
    if (!m) continue;
    const svc = m[3];
    const bin = (m[5] ?? '').trim();
    const service: AgentProbeResult['service'] =
      svc === 'systemd-user' || svc === 'systemd-system' || svc === 'launchd'
        ? svc
        : bin
          ? 'manual'
          : 'none';
    return {
      installed: m[1] === '1',
      running: m[2] === '1',
      service: m[1] === '1' ? service : 'none',
      bin,
      agentId: m[4] ?? '',
    };
  }
  return null;
}

export interface InstallSpec {
  /** install.sh 的下载源（一般传 workers.dev 源，绕自定义域名机房挑战） */
  installBase: string;
  /** Agent 回连源（workers.dev），写入远端 agent.env */
  agentServer: string;
  /** true → sudo 系统级安装（/usr/local/bin + /etc env + system unit） */
  system: boolean;
}

export interface BootstrapCommand {
  command: string;
  /**
   * 调用方按序经 exec stdin 写入的行：
   * - 'token'：Agent 令牌（安装恒有——token 不落 argv/远端 ps，只进 600 临时文件）
   * - 'sudo' ：sudo 密码（systemd-system 启动/系统级安装时追加）
   * 空数组 = 不需要 stdin。
   */
  stdinLines: Array<'token' | 'sudo'>;
}

/**
 * 安装命令。
 * stdin 约定：第一行 token（`IFS= read` 读入 shell 变量 → printf 进 600 临时文件），
 * 系统级时第二行 sudo 密码（同样读入变量再经管道喂 `sudo -S`）。
 * 全程秘密不出现在远端命令行/ps——argv 里只有变量名与路径。
 * - 用户级：tmp 下载 install.sh + `--token-file` 读凭据；
 * - 系统级：额外 `sudo -S` 以 root 跑 --system。
 */
export function buildInstallCommand(spec: InstallSpec): BootstrapCommand {
  const inst = '/tmp/cloudssh-inst.$$.sh';
  const tok = '/tmp/cloudssh-tok.$$';
  const args = `--server ${shQuote(spec.agentServer)} --token-file ${tok}`;
  const fetchScript = `curl -fsSL ${shQuote(`${spec.installBase}/install.sh`)} -o ${inst}`;
  const cleanup = `rc=$?; rm -f ${inst} ${tok}; exit $rc`;
  if (!spec.system) {
    return {
      command:
        `IFS= read -r CS_TOK && umask 077 && printf '%s' "$CS_TOK" > ${tok} && ` +
        `${fetchScript} && sh ${inst} ${args}; ${cleanup}`,
      stdinLines: ['token'],
    };
  }
  return {
    command:
      `IFS= read -r CS_TOK && IFS= read -r CS_PW && umask 077 && ` +
      `printf '%s' "$CS_TOK" > ${tok} && ${fetchScript} && ` +
      `printf '%s\\n' "$CS_PW" | sudo -S -p '' sh ${inst} ${args} --system; ${cleanup}`,
    stdinLines: ['token', 'sudo'],
  };
}

/** 启动命令：按探测到的服务形态分发；无服务形态时回退 nohup + env 文件直跑。 */
export function buildStartCommand(probe: AgentProbeResult): BootstrapCommand {
  switch (probe.service) {
    case 'systemd-user':
      return {
        command:
          'systemctl --user start cloudssh-agent 2>/dev/null' +
          ' || DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" systemctl --user start cloudssh-agent',
        stdinLines: [],
      };
    case 'systemd-system':
      // 密码经 stdin 读入变量再 printf 进管道——argv 无秘密
      return {
        command:
          'IFS= read -r CS_PW && printf \'%s\\n\' "$CS_PW" | sudo -S -p \'\' systemctl start cloudssh-agent',
        stdinLines: ['sudo'],
      };
    case 'launchd':
      return {
        command:
          'launchctl kickstart "gui/$(id -u)/online.lemonhub.cloudssh-agent" 2>/dev/null' +
          ' || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/online.lemonhub.cloudssh-agent.plist"',
        stdinLines: [],
      };
    default: {
      const bin = probe.bin || '$HOME/.local/bin/cloudssh-agent';
      return {
        command:
          '( for f in "$HOME/.config/cloudssh-agent/agent.env" /etc/cloudssh-agent/agent.env;' +
          ' do [ -f "$f" ] && { set -a; . "$f"; set +a; break; }; done;' +
          ` nohup ${shQuote(bin)} >/dev/null 2>&1 & )`,
        stdinLines: [],
      };
    }
  }
}
