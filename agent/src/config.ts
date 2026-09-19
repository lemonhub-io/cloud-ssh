/**
 * Agent 运行配置：全部经环境变量/CLI 注入，不落盘任何凭据。
 * Token 形态 <githubId>:<agentId>:<secret>，由 Web 端创建时一次性返回。
 */
export interface AgentConfig {
  /** wss://<host>/api/agent/ws 信令地址（自动由 --server 推导） */
  signalUrl: string;
  /** https://<host> 站点源（审计/OS 回传走 /internal/agent/*） */
  origin: string;
  token: string;
  agentId: string;
  /** 允许的 SSH 目标 host 白名单（逗号分隔，支持 *.example.com 前缀通配）；空 = 不限制 */
  allowlist: string[];
  /** 并发会话上限 */
  maxSessions: number;
  debug: boolean;
  /** 信令 WS 心跳周期（边缘自动应答，不唤醒 DO） */
  pingIntervalMs: number;
}

export interface AgentConfigInput {
  server?: string;
  signalUrl?: string;
  token?: string;
  allowlist?: string;
  maxSessions?: number;
  debug?: boolean;
}

export class ConfigError extends Error {}

function normalizeOrigin(server: string): string {
  let url: URL;
  try {
    url = new URL(server.includes('://') ? server : `https://${server}`);
  } catch {
    throw new ConfigError(`Invalid --server value: ${server}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`--server must be http(s): ${server}`);
  }
  return url.origin;
}

export function resolveConfig(input: AgentConfigInput): AgentConfig {
  const token = (input.token ?? process.env.AGENT_TOKEN ?? '').trim();
  if (!token) {
    throw new ConfigError('Missing agent token (--token or AGENT_TOKEN)');
  }
  const parts = token.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ConfigError('Malformed agent token; expected <githubId>:<agentId>:<secret>');
  }

  const origin = normalizeOrigin(
    input.server ?? process.env.AGENT_SERVER ?? 'https://ssh.lemonhub.online'
  );
  const signalUrl =
    input.signalUrl ??
    process.env.AGENT_SIGNAL_URL ??
    `${origin.replace(/^http/, 'ws')}/api/agent/ws`;

  const allowlist = (input.allowlist ?? process.env.AGENT_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const maxSessionsRaw = input.maxSessions ?? Number(process.env.AGENT_MAX_SESSIONS ?? '8');
  const maxSessions =
    Number.isInteger(maxSessionsRaw) && maxSessionsRaw > 0 ? maxSessionsRaw : 8;

  const debug =
    input.debug ?? (process.env.AGENT_DEBUG === '1' || process.env.AGENT_DEBUG === 'true');

  return {
    signalUrl,
    origin,
    token,
    agentId: parts[1],
    allowlist,
    maxSessions,
    debug,
    pingIntervalMs: 20_000,
  };
}

/** 目标 host 白名单判定：大小写不敏感，*.example.com 匹配子域与根域。 */
export function isHostAllowed(allowlist: string[], host: string): boolean {
  if (allowlist.length === 0) return true;
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const rule of allowlist) {
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    } else if (h === rule) {
      return true;
    }
  }
  return false;
}
