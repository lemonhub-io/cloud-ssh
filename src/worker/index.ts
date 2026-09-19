import { normalizeThemeData, THEME_MAX_BYTES } from '../theme-schema';
import { isValidAgentId } from '../p2p-signaling';
import { ALLOWED_LOCATION_HINTS, type Env, type SSHConnectionConfig } from '../types';
import { buildIceServers } from './turn-credentials';
import {
  getAuthenticatedUser,
  handleGetMe,
  handleGitHubAuth,
  handleGitHubCallback,
  handleLogout,
  isGitHubAuthRequired,
  isGitHubUserAllowed,
} from './auth';
import { HTML } from './html';
import { handleAgentDownload, installScriptResponse } from './install-scripts';

export { SSHSessionDO } from './durable-object';
export { SSHShareDO } from './share-do';
export { UserDBDO } from './user-db';

const RATE_LIMIT_MAX = 10; // max requests per window
const RATE_LIMIT_WINDOW = 60000; // 1 minute window
const RATE_LIMIT_MAX_ENTRIES = 10000;
const RATE_LIMIT_CLEANUP_INTERVAL = 256;

// Worker 实例级削峰；Turnstile 和一次性 token 仍负责实际连接鉴权。
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
let rateLimitChecks = 0;

function cleanExpiredRateLimits(now: number): void {
  for (const [ip, record] of rateLimitMap) {
    if (now >= record.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}

function getRateLimitRetryAfter(ip: string | null): number | null {
  if (!ip) return null;

  const now = Date.now();
  rateLimitChecks++;
  if (rateLimitChecks % RATE_LIMIT_CLEANUP_INTERVAL === 0) {
    cleanExpiredRateLimits(now);
  }

  let record = rateLimitMap.get(ip);

  if (!record || now >= record.resetAt) {
    if (!record && rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      const oldestIP = rateLimitMap.keys().next().value;
      if (oldestIP !== undefined) rateLimitMap.delete(oldestIP);
    }
    record = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, record);
    return null;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  }

  record.count++;
  return null;
}

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${secret}&response=${token}&remoteip=${ip}`,
    });
    const result = await response.json<{ success: boolean }>();
    return result.success === true;
  } catch {
    return false;
  }
}

// --- Simple token-based verification for session-level ---
const VERIFIED_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours (fallback for token validation)

async function generateVerifiedToken(secret: string): Promise<string> {
  const expires = Date.now() + VERIFIED_TOKEN_TTL;
  const payload = `${expires}`;

  // 使用 HMAC-SHA256 进行签名
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));

  // 转换为十六进制字符串
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `${payload}:${signatureHex}`;
}

async function isVerifiedTokenValid(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split(':');
    if (parts.length !== 2) return false;

    const [expiresStr, signature] = parts;
    if (!/^\d+$/.test(expiresStr) || !/^[0-9a-f]{64}$/i.test(signature)) return false;

    const expires = Number(expiresStr);
    if (!Number.isSafeInteger(expires) || Date.now() > expires) return false;

    // 使用 HMAC-SHA256 验证签名
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // 将十六进制签名转换回字节数组
    const signatureBytes = new Uint8Array(
      signature.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))
    );

    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(expiresStr)
    );
  } catch {
    return false;
  }
}

// --- UserDBDO helper ---
function getUserDBStub(env: Env, githubId: string | number): DurableObjectStub {
  const id = env.USER_DB.idFromName(githubId.toString());
  return env.USER_DB.get(id);
}

function isSSHSharingEnabled(env: Env): boolean {
  return env.ENABLE_SSH_SHARING === 'true';
}

function isP2PEnabled(env: Env): boolean {
  return env.ENABLE_P2P === 'true';
}

/** agent:<id> 命名的 SSHSessionDO 实例（与浏览器会话共用 DO 类）。 */
function getAgentStub(env: Env, agentId: string): DurableObjectStub {
  return env.SSH_SESSION.get(env.SSH_SESSION.idFromName(`agent:${agentId}`));
}

/** Agent 在线判定：agent:* DO 内持有存活信令 WS 即在线。 */
async function isAgentOnline(env: Env, agentId: string): Promise<boolean> {
  try {
    const res = await getAgentStub(env, agentId).fetch(
      new Request('http://internal/internal/agent-status')
    );
    if (!res.ok) return false;
    const body = await res.json<{ online?: boolean }>();
    return body.online === true;
  } catch {
    return false;
  }
}

/**
 * 校验 Agent Token 并返回归属身份。
 * Token 形态 <githubId>:<agentId>:<secret>：首段直接定位 UserDBDO，无需全局索引。
 */
async function validateAgentToken(
  env: Env,
  token: string
): Promise<{ agentId: string; userId: number; githubId: string } | null> {
  const [githubId, agentId] = token.split(':');
  if (!githubId || !isValidAgentId(agentId)) return null;
  try {
    const res = await getUserDBStub(env, githubId).fetch(
      new Request('http://internal/internal/agents/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    );
    if (!res.ok) return null;
    const body = await res.json<{ agentId?: string; userId?: number }>();
    if (!body.agentId || typeof body.userId !== 'number') return null;
    return { agentId: body.agentId, userId: body.userId, githubId };
  } catch {
    return null;
  }
}

async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * 校验 locationHint 值是否在 Cloudflare DO 允许的列表内（白名单）。
 * 返回符合规范的 hint 字符串；非法/空值返回 undefined（DO get() 退化为默认调度）。
 */
function validateRegion(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  return (ALLOWED_LOCATION_HINTS as readonly string[]).includes(v) ? v : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // ==================== Auth Routes ====================

      if (url.pathname === '/api/auth/github') {
        return handleGitHubAuth(request, env);
      }

      if (url.pathname === '/api/auth/callback') {
        return handleGitHubCallback(request, env);
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        return handleLogout(request, env);
      }

      if (url.pathname === '/api/auth/me') {
        return handleGetMe(request, env);
      }

      // ==================== 一次性 SSH 分享公开兑换 ====================

      if (url.pathname === '/api/share/claim' && request.method === 'POST') {
        return handleShareClaim(request, url, env);
      }

      // ==================== 分享管理与审计（需认证） ====================

      if (url.pathname.startsWith('/api/shares/')) {
        return handleShareOwnerRoute(request, url, env);
      }

      // ==================== Servers Routes (需认证) ====================

      if (url.pathname === '/api/servers' || url.pathname.startsWith('/api/servers/')) {
        return handleServersRoute(request, url, env);
      }

      // ==================== Theme Routes（登录用户跨环境同步） ====================

      if (url.pathname === '/api/user/theme') {
        return handleThemeRoute(request, env);
      }

      // ==================== known_hosts Routes (需认证) ====================

      if (url.pathname === '/api/known-hosts' || url.pathname.startsWith('/api/known-hosts/')) {
        return handleKnownHostsRoute(request, url, env);
      }

      // ==================== 命令片段 Routes (需认证) ====================

      if (url.pathname === '/api/snippets' || url.pathname.startsWith('/api/snippets/')) {
        return handleSnippetsRoute(request, url, env);
      }

      // ==================== Agent 管理（需认证，P2P 开关启用时可用） ====================

      if (url.pathname === '/api/agents' || url.pathname.startsWith('/api/agents/')) {
        return handleAgentsRoute(request, url, env);
      }

      // ==================== Agent 信令接入与回调（Bearer Token 认证） ====================

      if (url.pathname === '/api/agent/ws') {
        return handleAgentWebSocket(request, env);
      }
      if (url.pathname === '/internal/agent/audit' && request.method === 'POST') {
        return handleAgentAudit(request, env);
      }
      if (url.pathname === '/internal/agent/os' && request.method === 'POST') {
        return handleAgentOSReport(request, env);
      }

      // ==================== Turnstile Verify ====================

      if (url.pathname === '/api/verify' && request.method === 'POST') {
        if (!env.TURNSTILE_SECRET) {
          return Response.json({ success: true });
        }

        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
        const body = await request.json<{ token: string }>();

        if (!body.token) {
          return Response.json({ success: false, error: 'Missing token' }, { status: 400 });
        }

        const isValid = await verifyTurnstile(body.token, env.TURNSTILE_SECRET, clientIP);
        if (!isValid) {
          return Response.json({ success: false, error: 'Invalid token' }, { status: 403 });
        }

        // Issue a verified token as a session cookie (no Max-Age = session cookie, expires when browser closes)
        const verifiedToken = await generateVerifiedToken(env.TURNSTILE_SECRET);
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `cf_verified=${verifiedToken}; Path=/; HttpOnly; Secure; SameSite=Strict`,
          },
        });
      }

      // ==================== SSH WebSocket ====================

      if (url.pathname === '/api/ssh/sftp') {
        return handleSFTPAttachConnection(request, env);
      }

      if (url.pathname === '/api/ssh') {
        const clientIP = request.headers.get('CF-Connecting-IP');
        const retryAfter = getRateLimitRetryAfter(clientIP);
        if (retryAfter !== null) {
          return new Response('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': String(retryAfter) },
          });
        }

        // Check for resume-token (session re-attach)
        const resumeToken = url.searchParams.get('resume_token');
        const resumeSession = url.searchParams.get('session');
        if (resumeToken && resumeSession) {
          return handleResumeSSHConnection(request, env, resumeSession, resumeToken);
        }

        // Check for one-time-token (from server management connect)
        const connectToken = url.searchParams.get('token');
        if (connectToken) {
          return handleTokenSSHConnection(request, env, connectToken);
        }
        const shareRef = url.searchParams.get('share_ref');
        const shareTicket = url.searchParams.get('share_ticket');
        if (shareRef || shareTicket) {
          if (!shareRef || !shareTicket) {
            return Response.json({ error: 'Missing share connection ticket' }, { status: 403 });
          }
          return handleShareSSHConnection(request, env, shareRef, shareTicket);
        }

        // P2P 需要已保存服务器（凭据经服务端配置下发）或分享票据，匿名直连不可用
        if (url.searchParams.get('mode') === 'p2p') {
          return Response.json(
            { error: 'P2P mode requires a saved server or share ticket' },
            { status: 400 }
          );
        }

        // Verify Turnstile if secret is configured
        if (env.TURNSTILE_SECRET) {
          // Check if user has a valid verification cookie
          const cookies = request.headers.get('Cookie') || '';
          const verifiedCookie = cookies
            .split(';')
            .find((c) => c.trim().startsWith('cf_verified='));
          const verifiedToken = verifiedCookie?.split('=')[1];

          if (
            !verifiedToken ||
            !(await isVerifiedTokenValid(verifiedToken, env.TURNSTILE_SECRET))
          ) {
            // No valid cookie, check Turnstile token
            const turnstileToken = url.searchParams.get('turnstile_token');
            if (!turnstileToken) {
              return Response.json({ error: 'Missing Turnstile token' }, { status: 403 });
            }
            const isValid = await verifyTurnstile(
              turnstileToken,
              env.TURNSTILE_SECRET,
              clientIP || ''
            );
            if (!isValid) {
              return Response.json({ error: 'Turnstile verification failed' }, { status: 403 });
            }
          }
        }

        return handleSSHConnection(request, env);
      }

      if (url.pathname === '/api/health') {
        return Response.json({ status: 'ok', timestamp: Date.now() });
      }

      // Agent 一键安装脚本与免安装二进制分发（公开，无需登录）
      if (url.pathname === '/install.sh') {
        return installScriptResponse(request, 'sh', env);
      }
      if (url.pathname === '/install.ps1') {
        return installScriptResponse(request, 'ps1', env);
      }
      if (url.pathname.startsWith('/api/agent/download/')) {
        return handleAgentDownload(url);
      }

      // Return config info (includes GitHub auth availability)
      if (url.pathname === '/api/config') {
        return Response.json({
          turnstileEnabled: !!env.TURNSTILE_SECRET,
          sitekey: env.TURNSTILE_SITEKEY || '',
          githubAuthEnabled: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
          githubAuthRequired: isGitHubAuthRequired(env),
          sshSharingEnabled: isSSHSharingEnabled(env),
          p2pEnabled: isP2PEnabled(env),
          workersDevOrigin: env.WORKERS_DEV_ORIGIN?.trim() || null,
        });
      }

      return new Response(HTML, {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Unhandled error in fetch handler:', msg);
      return Response.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  },
};

// ==================== Server management routes ====================

async function handleServersRoute(request: Request, url: URL, env: Env): Promise<Response> {
  // 认证检查
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env, user.github_id);

  // GET /api/servers
  if (url.pathname === '/api/servers' && request.method === 'GET') {
    return stub.fetch(
      new Request(`http://internal/internal/servers?user_id=${user.id}`, {
        method: 'GET',
      })
    );
  }

  // POST /api/servers
  if (url.pathname === '/api/servers' && request.method === 'POST') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  // /api/servers/:id/connect
  const sharesMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/shares$/);
  if (sharesMatch) {
    if (!isSSHSharingEnabled(env)) {
      return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
    }
    const serverId = sharesMatch[1];
    if (request.method === 'GET') {
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/shares?user_id=${user.id}`, {
          method: 'GET',
        })
      );
    }
    if (request.method === 'POST') {
      const body = await request.json<{
        expiresInMinutes?: number;
        maxSessionMinutes?: number;
        auditRetentionDays?: number;
      }>();
      const expiresInMinutes = Number(body.expiresInMinutes);
      const maxSessionMinutes = Number(body.maxSessionMinutes);
      // 审计保留天数：缺省 90；白名单与前端选项一致
      const auditRetentionDays =
        body.auditRetentionDays === undefined ? 90 : Number(body.auditRetentionDays);
      if (![5, 15, 30, 60].includes(expiresInMinutes)) {
        return Response.json({ error: 'Invalid share expiry' }, { status: 400 });
      }
      if (![15, 30, 60, 120].includes(maxSessionMinutes)) {
        return Response.json({ error: 'Invalid maximum session duration' }, { status: 400 });
      }
      if (![7, 30, 90, 180, 365].includes(auditRetentionDays)) {
        return Response.json({ error: 'Invalid audit retention' }, { status: 400 });
      }

      const token = createShareToken();
      const shareRef = await hashShareToken(token);
      const shareId = crypto.randomUUID();
      const expiresAt = Date.now() + expiresInMinutes * 60_000;
      const metadataResponse = await stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/shares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: user.id,
            share_id: shareId,
            share_ref: shareRef,
            expires_at: expiresAt,
            max_session_seconds: maxSessionMinutes * 60,
          }),
        })
      );
      if (!metadataResponse.ok) return metadataResponse;
      const metadata = await metadataResponse.json<{
        serverName: string;
        expiresAt: number;
        maxSessionSeconds: number;
      }>();

      const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
      const initResponse = await shareStub.fetch(
        new Request('http://internal/internal/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shareId,
            tokenHash: shareRef,
            ownerUserId: user.id,
            ownerGithubId: String(user.github_id),
            serverId: Number(serverId),
            serverName: metadata.serverName,
            expiresAt,
            maxSessionSeconds: maxSessionMinutes * 60,
            auditRetentionDays,
          }),
        })
      );
      if (!initResponse.ok) {
        await stub
          .fetch(
            new Request(`http://internal/internal/shares/${shareId}/status`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: user.id, status: 'revoked', closed_at: Date.now() }),
            })
          )
          .catch(() => null);
        return Response.json({ error: 'Failed to initialize share link' }, { status: 500 });
      }
      return Response.json(
        {
          id: shareId,
          url: `${url.origin}/#/share/${token}`,
          expiresAt,
          maxSessionSeconds: maxSessionMinutes * 60,
        },
        { status: 201 }
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/agent —— 绑定/解绑前置 P2P Agent（agent_loopback 表示装在目标机上）
  const agentBindMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/agent$/);
  if (agentBindMatch) {
    if (!isP2PEnabled(env)) {
      return Response.json({ error: 'P2P mode is disabled' }, { status: 404 });
    }
    if (request.method !== 'PUT') return new Response('Method Not Allowed', { status: 405 });
    const body = await request.json<{ agent_id?: unknown; agent_loopback?: unknown }>();
    return stub.fetch(
      new Request(`http://internal/internal/servers/${agentBindMatch[1]}/agent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: user.id,
          agent_id: typeof body.agent_id === 'string' ? body.agent_id : null,
          agent_loopback: body.agent_loopback === true,
        }),
      })
    );
  }

  // /api/servers/:id/memory
  const memoryMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/memory$/);
  if (memoryMatch) {
    const serverId = memoryMatch[1];
    if (request.method === 'GET') {
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/memory?user_id=${user.id}`, {
          method: 'GET',
        })
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/work-logs/:logId
  const singleWorkLogMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/work-logs\/(\d+)$/);
  if (singleWorkLogMatch) {
    const serverId = singleWorkLogMatch[1];
    const logId = singleWorkLogMatch[2];
    if (request.method === 'DELETE') {
      return stub.fetch(
        new Request(
          `http://internal/internal/servers/${serverId}/work-logs/${logId}?user_id=${user.id}`,
          {
            method: 'DELETE',
          }
        )
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/work-logs
  const workLogsMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/work-logs$/);
  if (workLogsMatch) {
    const serverId = workLogsMatch[1];
    if (request.method === 'POST') {
      const body = await request.json<Record<string, unknown>>();
      body.user_id = user.id;
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/work-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/knowledge/batch
  const batchKnowledgeMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/knowledge\/batch$/);
  if (batchKnowledgeMatch) {
    const serverId = batchKnowledgeMatch[1];
    if (request.method === 'DELETE') {
      const body = await request.json<Record<string, unknown>>();
      body.user_id = user.id;
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/knowledge/batch`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/knowledge/:kId
  const singleKnowledgeMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/knowledge\/(\d+)$/);
  if (singleKnowledgeMatch) {
    const serverId = singleKnowledgeMatch[1];
    const kId = singleKnowledgeMatch[2];
    if (request.method === 'DELETE') {
      return stub.fetch(
        new Request(
          `http://internal/internal/servers/${serverId}/knowledge/${kId}?user_id=${user.id}`,
          {
            method: 'DELETE',
          }
        )
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/knowledge
  const knowledgeMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/knowledge$/);
  if (knowledgeMatch) {
    const serverId = knowledgeMatch[1];
    if (request.method === 'POST') {
      const body = await request.json<Record<string, unknown>>();
      body.user_id = user.id;
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/knowledge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/connect
  const connectMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/connect$/);
  if (connectMatch && request.method === 'POST') {
    const serverId = connectMatch[1];
    const tokenRes = await stub.fetch(
      new Request(`http://internal/internal/servers/${serverId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id }),
      })
    );

    if (!tokenRes.ok) return tokenRes;

    const { token } = await tokenRes.json<{ token: string }>();
    const wsUrl = `wss://${url.host}/api/ssh?token=${token}`;

    return Response.json({ wsUrl });
  }

  // /api/servers/:id
  const serverMatch = url.pathname.match(/^\/api\/servers\/(\d+)$/);
  if (serverMatch) {
    const serverId = serverMatch[1];

    // PUT /api/servers/:id
    if (request.method === 'PUT') {
      const body = await request.json<Record<string, unknown>>();
      body.user_id = user.id;
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }

    // DELETE /api/servers/:id
    if (request.method === 'DELETE') {
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: user.id }),
        })
      );
    }
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}

// ==================== Theme routes ====================

async function handleThemeRoute(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env, user.github_id);

  if (request.method === 'GET') {
    return stub.fetch(
      new Request(`http://internal/internal/theme?user_id=${user.id}`, {
        method: 'GET',
      })
    );
  }

  if (request.method === 'PUT') {
    let body: Record<string, unknown>;
    try {
      body = await request.json<Record<string, unknown>>();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const rawThemeData = body.theme_data;
    if (!rawThemeData || typeof rawThemeData !== 'object' || Array.isArray(rawThemeData)) {
      return Response.json({ error: 'Invalid theme data' }, { status: 400 });
    }
    const rawSerializedTheme = JSON.stringify(rawThemeData);
    if (new TextEncoder().encode(rawSerializedTheme).byteLength > THEME_MAX_BYTES) {
      return Response.json({ error: 'Theme data is too large' }, { status: 413 });
    }
    const themeData = normalizeThemeData(rawThemeData);
    if (!themeData) {
      return Response.json({ error: 'Invalid theme data' }, { status: 400 });
    }
    const serializedTheme = JSON.stringify(themeData);
    return stub.fetch(
      new Request('http://internal/internal/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id, theme_data: serializedTheme }),
      })
    );
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ==================== known_hosts routes ====================

async function handleKnownHostsRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env, user.github_id);

  // GET /api/known-hosts?host=X&port=Y  → 获取特定主机指纹
  // GET /api/known-hosts                 → 列出所有已知主机
  if (request.method === 'GET') {
    const host = url.searchParams.get('host');
    const port = url.searchParams.get('port');
    const qs = new URLSearchParams({ user_id: String(user.id) });
    if (host) qs.set('host', host);
    if (port) qs.set('port', port);
    return stub.fetch(
      new Request(`http://internal/internal/known-hosts?${qs}`, {
        method: 'GET',
      })
    );
  }

  // POST /api/known-hosts  → 存储/更新主机指纹
  if (request.method === 'POST') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/known-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  // DELETE /api/known-hosts  → 删除主机指纹
  if (request.method === 'DELETE') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/known-hosts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ==================== 命令片段 routes ====================

async function handleSnippetsRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  const stub = getUserDBStub(env, user.github_id);
  if (url.pathname === '/api/snippets' && request.method === 'GET') {
    return stub.fetch(
      new Request(`http://internal/internal/snippets?user_id=${user.id}`, { method: 'GET' })
    );
  }
  if (url.pathname === '/api/snippets' && request.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await request.json<Record<string, unknown>>();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }
  const snippetMatch = url.pathname.match(/^\/api\/snippets\/(\d+)$/);
  if (snippetMatch) {
    const snippetId = snippetMatch[1];
    if (request.method === 'PUT') {
      let body: Record<string, unknown>;
      try {
        body = await request.json<Record<string, unknown>>();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      body.user_id = user.id;
      return stub.fetch(
        new Request(`http://internal/internal/snippets/${snippetId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }
    if (request.method === 'DELETE') {
      return stub.fetch(
        new Request(`http://internal/internal/snippets/${snippetId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: user.id }),
        })
      );
    }
  }
  return Response.json({ error: 'Not Found' }, { status: 404 });
}

// ==================== SSH connection handlers ====================

function parseRequestUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function hasSameWebSocketOrigin(request: Request, url: URL): boolean {
  return request.headers.get('Origin') === url.origin;
}

async function handleSSHConnection(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });

  // Prevent Cross-Site WebSocket Hijacking / Quota Leeching
  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (isGitHubAuthRequired(env) && !(await getAuthenticatedUser(request, env))) {
    return Response.json({ error: 'GitHub authentication required' }, { status: 401 });
  }

  const sessionName = `session:${Date.now()}:${crypto.randomUUID()}`;
  const doId = env.SSH_SESSION.idFromName(sessionName);
  // 匿名路径不做自动推断（Worker 在 upgrade 时拿不到 host）；
  // 仅尊重用户通过前端下拉手动传入的 ?region= 覆盖值
  const region = validateRegion(url.searchParams.get('region'));
  const stub = region
    ? env.SSH_SESSION.get(doId, { locationHint: region } as any)
    : env.SSH_SESSION.get(doId);

  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.set('session', sessionName);

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.delete('x-ssh-config'); // 防御：禁止匿名连接通过 HTTP 头注入配置

  return stub.fetch(new Request(doUrl.toString(), { headers }));
}

/**
 * 处理会话秒级断线重连 (Session Re-attach)
 * 流程：通过 sessionName 路由至原 DO 实例，并附带 resumeToken 鉴权
 */
async function handleResumeSSHConnection(
  request: Request,
  env: Env,
  sessionName: string,
  resumeToken: string
): Promise<Response> {
  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });

  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  // 与 direct / one-time-token 升级路径保持一致的强制 GitHub 登录门禁：
  // REQUIRE_GITHUB_AUTH=true 时 resume 凭据不能替代有效会话。
  if (isGitHubAuthRequired(env) && !(await getAuthenticatedUser(request, env))) {
    return Response.json({ error: 'GitHub authentication required' }, { status: 401 });
  }

  const doId = env.SSH_SESSION.idFromName(sessionName);
  const stub = env.SSH_SESSION.get(doId);

  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.set('session', sessionName);
  doUrl.searchParams.set('resume_token', resumeToken);

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.delete('x-ssh-config');

  // P2P 恢复轮：下发新的 ICE 配置（原 TURN 凭据可能已过期）
  if (url.searchParams.get('mode') === 'p2p') {
    if (!isP2PEnabled(env)) {
      return Response.json({ error: 'P2P mode is disabled' }, { status: 404 });
    }
    headers.set('x-ice-servers', JSON.stringify(await buildIceServers(env)));
  }

  return stub.fetch(new Request(doUrl.toString(), { headers }));
}

async function handleShareClaim(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isSSHSharingEnabled(env)) {
    return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
  }
  const retryAfter = getRateLimitRetryAfter(request.headers.get('CF-Connecting-IP'));
  if (retryAfter !== null) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    });
  }
  let body: { token?: string; devicePubKey?: string };
  try {
    body = await request.json<{ token?: string; devicePubKey?: string }>();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(body.token)) {
    return Response.json({ error: 'Invalid share link' }, { status: 400 });
  }
  // 可选的设备绑定公钥（SPKI base64url）；格式非法时直接拒绝，避免静默降级。
  if (
    body.devicePubKey !== undefined &&
    (typeof body.devicePubKey !== 'string' || !/^[A-Za-z0-9_-]{80,600}$/.test(body.devicePubKey))
  ) {
    return Response.json({ error: 'Invalid device public key' }, { status: 400 });
  }
  const shareRef = await hashShareToken(body.token);
  const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
  const claimResponse = await shareStub.fetch(
    new Request('http://internal/internal/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: body.token, devicePubKey: body.devicePubKey }),
    })
  );
  if (!claimResponse.ok) return claimResponse;
  const claim = await claimResponse.json<{
    ticket: string;
    serverName: string;
    sessionExpiresAt: number;
  }>();
  return Response.json({
    wsUrl: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/ssh?share_ref=${encodeURIComponent(shareRef)}&share_ticket=${encodeURIComponent(claim.ticket)}`,
    serverName: claim.serverName,
    sessionExpiresAt: claim.sessionExpiresAt,
  });
}

async function handleShareOwnerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isSSHSharingEnabled(env)) {
    return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
  }
  const user = await getAuthenticatedUser(request, env);
  if (!user) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const match = url.pathname.match(/^\/api\/shares\/([^/]+)(?:\/audit)?$/);
  if (!match) return new Response('Not Found', { status: 404 });
  const shareId = decodeURIComponent(match[1]);
  const ownerStub = getUserDBStub(env, user.github_id);
  const metadataResponse = await ownerStub.fetch(
    new Request(
      `http://internal/internal/shares/${encodeURIComponent(shareId)}?user_id=${user.id}`,
      { method: 'GET' }
    )
  );
  if (!metadataResponse.ok) return metadataResponse;
  const metadata = await metadataResponse.json<{ shareRef: string }>();
  const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(metadata.shareRef));

  if (url.pathname.endsWith('/audit') && request.method === 'GET') {
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    return shareStub.fetch(
      new Request(
        `http://internal/internal/owner-view?owner_user_id=${user.id}&after=${after}&limit=${limit}`,
        { method: 'GET' }
      )
    );
  }
  if (url.pathname.endsWith('/audit') && request.method === 'DELETE') {
    return shareStub.fetch(
      new Request('http://internal/internal/audit/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerUserId: user.id }),
      })
    );
  }
  if (!url.pathname.endsWith('/audit') && request.method === 'DELETE') {
    return shareStub.fetch(new Request('http://internal/internal/revoke', { method: 'POST' }));
  }
  return new Response('Method Not Allowed', { status: 405 });
}

async function handleShareSSHConnection(
  request: Request,
  env: Env,
  shareRef: string,
  ticket: string
): Promise<Response> {
  if (!isSSHSharingEnabled(env)) {
    return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }
  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  if (!hasSameWebSocketOrigin(request, url)) return new Response('Forbidden', { status: 403 });
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(shareRef) || !/^[A-Za-z0-9_-]{40,128}$/.test(ticket)) {
    return Response.json({ error: 'Invalid share connection ticket' }, { status: 400 });
  }

  const sessionName = `share-session:${crypto.randomUUID()}`;
  const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
  const configResponse = await shareStub.fetch(
    new Request('http://internal/internal/connect/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, sessionName }),
    })
  );
  if (!configResponse.ok) return configResponse;
  const { config, devicePubKey } = await configResponse.json<{
    config: SSHConnectionConfig;
    serverName: string;
    devicePubKey?: string | null;
  }>();
  if (!config.sessionPolicy || config.sessionPolicy.shareRef !== shareRef) {
    return Response.json({ error: 'Invalid share session policy' }, { status: 500 });
  }
  if (!isGitHubUserAllowed(env, config.githubId ?? '')) {
    return Response.json({ error: 'Share owner is no longer allowed' }, { status: 403 });
  }

  // P2P 分享：优先定位分享所有者的在线 Agent；无在线 Agent 时透明回退中继
  if (url.searchParams.get('mode') === 'p2p' && isP2PEnabled(env)) {
    const agentId = await findOnlineAgentForOwner(env, config);
    if (agentId) {
      if (typeof devicePubKey === 'string' && devicePubKey) {
        config.sessionPolicy.devicePubKey = devicePubKey;
      }
      return forwardP2PSignalAttach(request, env, config, agentId, sessionName);
    }
  }

  const doId = env.SSH_SESSION.idFromName(sessionName);
  const hint = validateRegion(config.locationHint);
  const sessionStub = hint
    ? env.SSH_SESSION.get(doId, { locationHint: hint } as any)
    : env.SSH_SESSION.get(doId);
  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.delete('share_ref');
  doUrl.searchParams.delete('share_ticket');
  // Agent 离线时的透明中继回退：剥离 mode=p2p，前端 RtcTransport 检测到
  // 非信令首帧后会把同一 WS 收养为普通中继传输（票据已消费，不能重试）。
  doUrl.searchParams.delete('mode');
  doUrl.searchParams.set('session', sessionName);
  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.set('x-ssh-config', encodeURIComponent(JSON.stringify(config)));
  // 认领时绑定的设备公钥由服务端链路下发（claim → ShareDO → consume），
  // 客户端无法注入或替换，断线恢复时以此验签。
  if (typeof devicePubKey === 'string' && devicePubKey) {
    headers.set('x-share-device-key', devicePubKey);
  }
  return sessionStub.fetch(new Request(doUrl.toString(), { headers }));
}

/**
 * 处理通过 one-time-token 发起的 SSH 连接
 * 流程：从 UserDBDO 消费 token 获取凭据 → 传给 SSHSessionDO
 */
async function handleTokenSSHConnection(
  request: Request,
  env: Env,
  token: string
): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });

  // Prevent Cross-Site WebSocket Hijacking
  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  const githubAuthRequired = isGitHubAuthRequired(env);
  const authenticatedUser = githubAuthRequired ? await getAuthenticatedUser(request, env) : null;
  if (githubAuthRequired && !authenticatedUser) {
    return Response.json({ error: 'GitHub authentication required' }, { status: 401 });
  }

  // 从 UserDBDO 消费 token，获取连接配置
  const [githubId] = token.split(':');
  if (!githubId) {
    return Response.json({ error: 'Invalid token format' }, { status: 400 });
  }
  const stub = getUserDBStub(env, githubId);
  const tokenRes = await stub.fetch(
    new Request('http://internal/internal/connect-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  );

  if (!tokenRes.ok) {
    return Response.json({ error: 'Invalid or expired connection token' }, { status: 403 });
  }

  const config = await tokenRes.json<SSHConnectionConfig>();
  if (!isGitHubUserAllowed(env, config.githubId ?? '')) {
    return Response.json({ error: 'GitHub account is not allowed' }, { status: 403 });
  }
  if (authenticatedUser && String(authenticatedUser.github_id) !== String(config.githubId)) {
    return Response.json(
      { error: 'Connection token does not belong to this GitHub account' },
      { status: 403 }
    );
  }

  // P2P 模式：Agent 归属与在线校验通过后走信令挂载，由 DataChannel 承载会话。
  // agent_id 缺省时回落到服务器已绑定的 Agent（引导绑定后无需前端显式指定）。
  if (url.searchParams.get('mode') === 'p2p') {
    if (!isP2PEnabled(env)) {
      return Response.json({ error: 'P2P mode is disabled' }, { status: 404 });
    }
    const agentId = url.searchParams.get('agent_id') || config.agentId || '';
    if (!isValidAgentId(agentId)) {
      return Response.json({ error: 'Missing or invalid agent_id' }, { status: 400 });
    }
    const owned = await isAgentOwnedByUser(env, config, agentId);
    if (!owned) {
      return Response.json({ error: 'Agent not found' }, { status: 404 });
    }
    if (!(await isAgentOnline(env, agentId))) {
      return Response.json({ error: 'Agent is offline', agentOffline: true }, { status: 409 });
    }
    return forwardP2PSignalAttach(request, env, config, agentId);
  }

  const sessionName = `session:${Date.now()}:${crypto.randomUUID()}`;
  const doId = env.SSH_SESSION.idFromName(sessionName);
  // Token 路径：locationHint 由 user-db.handleConnectServer 按最外层直连节点计算并写入 config
  // （优先级：入口服务器手动 region → 入口 DB 持久化 inferred_hint → undefined）
  // 这里仅做白名单过滤，连接阶段不会再次调用 IPinfo
  const hint = validateRegion(config.locationHint);
  const doStub = hint
    ? env.SSH_SESSION.get(doId, { locationHint: hint } as any)
    : env.SSH_SESSION.get(doId);

  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.delete('token');
  doUrl.searchParams.set('session', sessionName);

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.set('x-ssh-config', encodeURIComponent(JSON.stringify(config)));

  const doRequest = new Request(doUrl.toString(), {
    headers: headers,
  });

  return doStub.fetch(doRequest);
}

async function handleSFTPAttachConnection(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  const sessionName = url.searchParams.get('session');
  const token = url.searchParams.get('token');
  if (!sessionName || !token) {
    return Response.json({ error: 'Missing SFTP attach token' }, { status: 403 });
  }

  const doId = env.SSH_SESSION.idFromName(sessionName);
  const stub = env.SSH_SESSION.get(doId);
  return stub.fetch(request);
}

// ==================== P2P：Agent 管理、信令接入与回调 ====================

function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/** Agent CRUD：登录用户代理到其 UserDBDO；仅 P2P 开关启用时开放。 */
async function handleAgentsRoute(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isP2PEnabled(env)) {
    return Response.json({ error: 'P2P mode is disabled' }, { status: 404 });
  }
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  const stub = getUserDBStub(env, user.github_id);

  if (url.pathname === '/api/agents') {
    if (request.method === 'GET') {
      return stub.fetch(
        new Request(`http://internal/internal/agents?user_id=${user.id}`, { method: 'GET' })
      );
    }
    if (request.method === 'POST') {
      const body = await request.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      body.user_id = user.id;
      return stub.fetch(
        new Request('http://internal/internal/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  const match = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (match) {
    const agentId = match[1];
    if (!isValidAgentId(agentId)) {
      return Response.json({ error: 'Invalid agent id' }, { status: 400 });
    }
    if (request.method === 'DELETE') {
      return stub.fetch(
        new Request(
          `http://internal/internal/agents/${agentId}?user_id=${user.id}`,
          { method: 'DELETE' }
        )
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  return new Response('Not Found', { status: 404 });
}

/**
 * Agent 常驻信令 WS：Bearer Token 认证 → 校验归属 → 以注入身份头的
 * 合成升级请求挂载到 agent:<id> DO。无 Cookie/Origin 语义，不做同源检查。
 */
async function handleAgentWebSocket(request: Request, env: Env): Promise<Response> {
  if (!isP2PEnabled(env)) {
    return Response.json({ error: 'P2P mode is disabled' }, { status: 404 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }
  const token = bearerToken(request);
  if (!token) {
    return Response.json({ error: 'Missing agent token' }, { status: 401 });
  }
  const identity = await validateAgentToken(env, token);
  if (!identity) {
    return Response.json({ error: 'Invalid agent token' }, { status: 403 });
  }

  const headers = new Headers();
  headers.set('Upgrade', 'websocket');
  headers.set('x-agent-id', identity.agentId);
  headers.set('x-agent-user-id', String(identity.userId));
  headers.set('x-agent-github-id', identity.githubId);
  return getAgentStub(env, identity.agentId).fetch(
    new Request('http://internal/api/agent/ws', { headers })
  );
}

/**
 * Agent 端分享审计回传：等价于 ShareAuditSink.appendEvent 的 HTTP 通道。
 * 仅转发已认证 Agent 上报的事件；shareRef 定位 ShareDO（不可猜测的能力散列）。
 */
async function handleAgentAudit(request: Request, env: Env): Promise<Response> {
  if (!isP2PEnabled(env)) {
    return Response.json({ error: 'P2P mode is disabled' }, { status: 404 });
  }
  const token = bearerToken(request);
  if (!token) return Response.json({ error: 'Missing agent token' }, { status: 401 });
  const identity = await validateAgentToken(env, token);
  if (!identity) return Response.json({ error: 'Invalid agent token' }, { status: 403 });

  const body = await request
    .json<{
      shareRef?: string;
      eventType?: string;
      occurredAt?: number;
      details?: Record<string, unknown>;
      closed?: boolean;
    }>()
    .catch(() => null);
  if (!body || typeof body.shareRef !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(body.shareRef)) {
    return Response.json({ error: 'Invalid audit event' }, { status: 400 });
  }
  const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(body.shareRef));

  // 会话关闭留痕（等价于 ShareAuditSink.notifyClosed 的 DO 直连路径）
  if (typeof body.closed === 'boolean') {
    return shareStub.fetch(
      new Request('http://internal/internal/session/closed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normal: body.closed }),
      })
    );
  }

  if (
    typeof body.eventType !== 'string' ||
    !/^[a-z_.]{1,64}$/.test(body.eventType) ||
    typeof body.occurredAt !== 'number' ||
    !Number.isFinite(body.occurredAt)
  ) {
    return Response.json({ error: 'Invalid audit event' }, { status: 400 });
  }
  if (JSON.stringify(body.details ?? {}).length > 64 * 1024) {
    return Response.json({ error: 'Audit details too large' }, { status: 413 });
  }

  return shareStub.fetch(
    new Request('http://internal/internal/audit/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: body.eventType,
        occurredAt: body.occurredAt,
        details: body.details ?? {},
      }),
    })
  );
}

/**
 * Agent 端 OS 检测回传：等价于 detectAndPersistRemoteOS 的 USER_DB 直连路径。
 * 归属校验在 UserDBDO 内完成（server_id 必须属于该用户）。
 */
async function handleAgentOSReport(request: Request, env: Env): Promise<Response> {
  if (!isP2PEnabled(env)) {
    return Response.json({ error: 'P2P mode is disabled' }, { status: 404 });
  }
  const token = bearerToken(request);
  if (!token) return Response.json({ error: 'Missing agent token' }, { status: 401 });
  const identity = await validateAgentToken(env, token);
  if (!identity) return Response.json({ error: 'Invalid agent token' }, { status: 403 });

  const body = await request
    .json<{ serverId?: number; os?: string }>()
    .catch(() => null);
  if (!body || !Number.isInteger(body.serverId) || typeof body.os !== 'string') {
    return Response.json({ error: 'Invalid OS report' }, { status: 400 });
  }

  return getUserDBStub(env, identity.githubId).fetch(
    new Request(`http://internal/internal/servers/${body.serverId}/os`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: identity.userId, os: body.os }),
    })
  );
}

/** Agent 归属校验：agent_id 必须登记在会话配置所属用户名下。 */
async function isAgentOwnedByUser(
  env: Env,
  config: SSHConnectionConfig,
  agentId: string
): Promise<boolean> {
  if (!config.githubId || !config.userId) return false;
  try {
    const res = await getUserDBStub(env, config.githubId).fetch(
      new Request(
        `http://internal/internal/agents/${agentId}?user_id=${config.userId}`,
        { method: 'GET' }
      )
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** 为分享会话在所有者名下挑选一个在线 Agent（last_seen 近者优先）。 */
async function findOnlineAgentForOwner(
  env: Env,
  config: SSHConnectionConfig
): Promise<string | null> {
  if (!config.githubId || !config.userId) return null;
  try {
    const res = await getUserDBStub(env, config.githubId).fetch(
      new Request(`http://internal/internal/agents?user_id=${config.userId}`, {
        method: 'GET',
      })
    );
    if (!res.ok) return null;
    const body = await res.json<{ agents?: Array<{ id: string; last_seen_at?: number }> }>();
    const agents = (body.agents ?? [])
      .slice()
      .sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0));
    for (const agent of agents) {
      if (await isAgentOnline(env, agent.id)) return agent.id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 将浏览器 WS 升级为 P2P 信令通道：session:* DO 进入信令模式，
 * 连接配置、目标 Agent 与本轮 ICE 服务器经内部头注入。
 */
async function forwardP2PSignalAttach(
  request: Request,
  env: Env,
  config: SSHConnectionConfig,
  agentId: string,
  sessionName?: string
): Promise<Response> {
  // Agent 就装在目标机上时，把 SSH 目标改写为回环地址——公网主机名在
  // NAT/发夹路由下可能无法从本机自连，127.0.0.1 恒可达。仅当请求的 Agent
  // 正是服务器绑定的回环 Agent 时才改写（用户改选其它在线 Agent 不适用）。
  // 跳板链同时失效：跳板是为「从 Cloudflare 到目标」铺路，Agent 已在目标上。
  if (config.agentLoopback && config.agentId === agentId) {
    config = { ...config, host: '127.0.0.1', jumpHosts: [] };
  }
  const name = sessionName ?? `session:${Date.now()}:${crypto.randomUUID()}`;
  const doId = env.SSH_SESSION.idFromName(name);
  const hint = validateRegion(config.locationHint);
  const stub = hint
    ? env.SSH_SESSION.get(doId, { locationHint: hint } as any)
    : env.SSH_SESSION.get(doId);

  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.delete('token');
  doUrl.searchParams.delete('share_ref');
  doUrl.searchParams.delete('share_ticket');
  doUrl.searchParams.set('session', name);
  doUrl.searchParams.set('mode', 'p2p');

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.set('x-ssh-config', encodeURIComponent(JSON.stringify(config)));
  headers.set('x-agent-id', agentId);
  headers.set('x-ice-servers', JSON.stringify(await buildIceServers(env)));

  return stub.fetch(new Request(doUrl.toString(), { headers }));
}
