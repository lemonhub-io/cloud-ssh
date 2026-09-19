import {
  MAX_SERVER_KNOWLEDGE,
  MAX_SERVER_WORK_LOGS,
  normalizeBatchDeleteKnowledgeInput,
  normalizeKnowledgeInput,
  normalizeWorkLogInput,
  type ServerKnowledgeItem,
  type ServerWorkLog,
  type UnifiedServerMemory,
} from '../server-memory-schema';
import { normalizeSnippetInput, SNIPPET_MAX_COUNT } from '../snippet-schema';
import {
  ALLOWED_LOCATION_HINTS,
  type Env,
  type SSHConnectionConfig,
  type SSHJumpHostConfig,
} from '../types';
import { inferLocationHint } from './ip-geo';
import { isDetectedOS } from './os-detect';
import { deserializeServerRow, serializeServerTags } from './server-tags';

const AUTH_METHODS = new Set(['password', 'publickey']);
const MAX_JUMP_HOSTS = 3;

interface StoredServerRow {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  credential: string;
  auth_method: string;
  region: string | null;
  inferred_hint: string | null;
  os: string | null;
  jump_server_id: number | null;
  agent_id: string | null;
  agent_loopback: number;
}

// ====== 行形状帮助类型：与 UserDBDO 内各 SELECT 列一一对应（配合 query<T> 消除逐处 as unknown as） ======
type UserRow = { id: number; github_id: number; username: string; avatar_url: string };
type ServerRow = {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: string;
  region: string | null;
  inferred_hint: string | null;
  tags: string;
  os: string | null;
  jump_server_id: number | null;
  agent_id: string | null;
  agent_loopback: number;
  created_at: string;
  updated_at: string;
};
type UserIdRow = { user_id: number };
type JumpRow = { user_id: number; jump_server_id: number | null };
type ServerEditRow = {
  user_id: number;
  host: string;
  port: number;
  auth_method: string;
  region: string | null;
  inferred_hint: string | null;
  jump_server_id: number | null;
};
type ServerNameRow = { name: string };
type ShareMetaRow = { user_id: number; server_id: number; share_ref: string; status: string };
type ThemeRow = { theme_data: string };
type FingerprintRow = { fingerprint: string };
type WorkLogRow = ServerWorkLog;
type KnowledgeRow = ServerKnowledgeItem;

/**
 * UserDBDO — 按 GitHub 用户 ID 命名并隔离的用户数据库 Durable Object
 *
 * 职责：
 * - 用户管理（GitHub OAuth 登录后创建/更新）
 * - Session 管理（创建/验证/清除）
 * - 服务器配置 CRUD（含 AES-256-GCM 凭据加密）
 * - One-time-token 生成与消费（安全传递凭据）
 */
export class UserDBDO {
  private env: Env;
  private db: any; // SqlStorage (DO SQLite)
  // one-time-token 内存存储：token → { config, expiresAt }
  private connectTokens: Map<string, { config: SSHConnectionConfig; expiresAt: number }> =
    new Map();
  private static readonly MAX_CONNECT_TOKENS = 1000;
  private derivedKeyCache: Map<number, CryptoKey> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.db = (state.storage as any).sql;
    this.initSchema();
  }

  /**
   * SqlStorage 无类型句柄的薄封装：行形状由调用方按 SELECT 列声明（T），
   * 消除逐处 as unknown as。仅编译期 cast，运行时行为与 toArray() 完全一致。
   */
  private query<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.exec(sql, ...params).toArray() as T[];
  }

  private one<T>(sql: string, ...params: unknown[]): T | null {
    const rows = this.query<T>(sql, ...params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * 架构版本：新增/变更表结构时递增。DO 每次从休眠唤醒都会重跑构造函数，
   * 以 PRAGMA user_version 守卫可跳过全部幂等 DDL，把每次唤醒的初始化
   * 从二十余条 SQLite exec 降为一次读取（DO 唤醒与执行时长均计入计费）。
   */
  private static readonly SCHEMA_VERSION = 3;

  private initSchema(): void {
    try {
      const row = this.db.exec('PRAGMA user_version').toArray()[0] as
        | { user_version?: number }
        | undefined;
      if (Number(row?.user_version ?? 0) >= UserDBDO.SCHEMA_VERSION) return;
    } catch {
      /* user_version 不可读时按未初始化处理，保持原有全量初始化行为 */
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        github_id   INTEGER UNIQUE NOT NULL,
        username    TEXT NOT NULL,
        avatar_url  TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        expires_at  TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS servers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        name        TEXT NOT NULL,
        host        TEXT NOT NULL,
        port        INTEGER DEFAULT 22,
        username    TEXT NOT NULL,
        credential  TEXT NOT NULL,
        auth_method TEXT DEFAULT 'password',
        region      TEXT DEFAULT NULL,
        inferred_hint TEXT DEFAULT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        os          TEXT DEFAULT NULL,
        jump_server_id INTEGER DEFAULT NULL,
        agent_id    TEXT DEFAULT NULL,
        agent_loopback INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_servers_user ON servers(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS user_themes (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id),
        theme_data  TEXT NOT NULL,
        updated_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS known_hosts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        host        TEXT NOT NULL,
        port        INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, host, port)
      );

      CREATE INDEX IF NOT EXISTS idx_known_hosts_user ON known_hosts(user_id);

      CREATE TABLE IF NOT EXISTS command_snippets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        name        TEXT NOT NULL,
        command     TEXT NOT NULL,
        category    TEXT NOT NULL DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_command_snippets_user ON command_snippets(user_id);

      CREATE TABLE IF NOT EXISTS ssh_shares (
        id                  TEXT PRIMARY KEY,
        user_id             INTEGER NOT NULL REFERENCES users(id),
        -- 不与 servers 设外键：服务器删除后仍需保留已结束分享的审计索引。
        server_id           INTEGER NOT NULL,
        share_ref           TEXT NOT NULL,
        expires_at          INTEGER NOT NULL,
        max_session_seconds INTEGER NOT NULL,
        status              TEXT NOT NULL DEFAULT 'unused',
        claimed_at          INTEGER,
        active_at           INTEGER,
        closed_at           INTEGER,
        created_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ssh_shares_user_server
        ON ssh_shares(user_id, server_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS server_work_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        server_id   INTEGER NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_server_work_logs_user_server
        ON server_work_logs(user_id, server_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS server_knowledge (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        server_id   INTEGER NOT NULL,
        category    TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE(user_id, server_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_server_knowledge_user_server
        ON server_knowledge(user_id, server_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agents (
        id                TEXT PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id),
        name              TEXT NOT NULL,
        token_hash        TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        last_seen_at      INTEGER,
        last_seen_version TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
    `);

    // 清理已移除 AI 功能的遗留表（含加密存储的 API 密钥，幂等）
    this.db.exec('DROP TABLE IF EXISTS ai_configs');

    // === Migration: 给既有 servers 表追加 region / inferred_hint 列（幂等） ===
    // SQLite 没有 ADD COLUMN IF NOT EXISTS，用 PRAGMA table_info 守卫
    const serverCols = this.db.exec('PRAGMA table_info(servers)').toArray();
    if (!serverCols.some((c: any) => c.name === 'region')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN region TEXT DEFAULT NULL');
    }
    if (!serverCols.some((c: any) => c.name === 'inferred_hint')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN inferred_hint TEXT DEFAULT NULL');
    }
    if (!serverCols.some((c: any) => c.name === 'tags')) {
      this.db.exec("ALTER TABLE servers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    if (!serverCols.some((c: any) => c.name === 'os')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN os TEXT DEFAULT NULL');
    }
    if (!serverCols.some((c: any) => c.name === 'jump_server_id')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN jump_server_id INTEGER DEFAULT NULL');
    }
    if (!serverCols.some((c: any) => c.name === 'agent_id')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN agent_id TEXT DEFAULT NULL');
    }
    if (!serverCols.some((c: any) => c.name === 'agent_loopback')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN agent_loopback INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_servers_jump ON servers(jump_server_id)');

    // === Migration: 给既有 ssh_shares 表追加审计清理留痕列（幂等） ===
    // SSHShareDO 清理审计后同步写入；管理端据此隐藏查看入口并集中展示清理记录
    const shareCols = this.db.exec('PRAGMA table_info(ssh_shares)').toArray();
    if (!shareCols.some((c: any) => c.name === 'audit_purged_at')) {
      this.db.exec('ALTER TABLE ssh_shares ADD COLUMN audit_purged_at INTEGER DEFAULT NULL');
    }
    if (!shareCols.some((c: any) => c.name === 'audit_purge_type')) {
      this.db.exec('ALTER TABLE ssh_shares ADD COLUMN audit_purge_type TEXT DEFAULT NULL');
    }

    // === Migration: 给既有 command_snippets 表追加 category 列（幂等） ===
    const snippetCols = this.db.exec('PRAGMA table_info(command_snippets)').toArray();
    if (!snippetCols.some((c: any) => c.name === 'category')) {
      this.db.exec("ALTER TABLE command_snippets ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    }

    // === Migration: 彻底清理已废弃的旧版数据表（解除对 servers 的外键阻碍） ===
    this.db.exec('DROP TABLE IF EXISTS server_memories');
    this.db.exec('DROP TABLE IF EXISTS server_task_checkpoints');

    try {
      this.db.exec(`PRAGMA user_version = ${UserDBDO.SCHEMA_VERSION}`);
    } catch {
      /* pragma 不支持时退化为每次全量初始化 */
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // --- 用户管理 ---
      if (path === '/internal/oauth-user' && request.method === 'POST') {
        return this.handleOAuthUser(request);
      }

      // --- Session 管理 ---
      if (path === '/internal/session/create' && request.method === 'POST') {
        return this.handleSessionCreate(request);
      }
      if (path === '/internal/session/verify' && request.method === 'POST') {
        return this.handleSessionVerify(request);
      }
      if (path === '/internal/session/delete' && request.method === 'POST') {
        return this.handleSessionDelete(request);
      }

      // --- 服务器 CRUD ---
      if (path === '/internal/servers' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr, 10);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetServers(userId);
      }
      if (path === '/internal/servers' && request.method === 'POST') {
        return this.handleAddServer(request);
      }

      // /internal/servers/:id
      const serverMatch = path.match(/^\/internal\/servers\/(\d+)$/);
      if (serverMatch) {
        const serverId = parseInt(serverMatch[1], 10);
        if (request.method === 'PUT') return this.handleUpdateServer(serverId, request);
        if (request.method === 'DELETE') return this.handleDeleteServer(serverId, request);
      }

      // /internal/servers/:id/connect
      const connectMatch = path.match(/^\/internal\/servers\/(\d+)\/connect$/);
      if (connectMatch && request.method === 'POST') {
        return this.handleConnectServer(parseInt(connectMatch[1], 10), request);
      }

      // /internal/servers/:id/agent —— 绑定/解绑为该服务器前置 P2P 的 Agent
      const agentBindMatch = path.match(/^\/internal\/servers\/(\d+)\/agent$/);
      if (agentBindMatch && request.method === 'PUT') {
        return this.handleBindServerAgent(parseInt(agentBindMatch[1], 10), request);
      }

      // /internal/servers/:id/share-config —— 仅由 SSHShareDO 兑换一次性分享时调用
      const shareConfigMatch = path.match(/^\/internal\/servers\/(\d+)\/share-config$/);
      if (shareConfigMatch && request.method === 'POST') {
        return this.handleShareConnectionConfig(parseInt(shareConfigMatch[1], 10), request);
      }

      // /internal/servers/:id/shares —— 分享元数据归所有者 UserDBDO 管理
      const serverSharesMatch = path.match(/^\/internal\/servers\/(\d+)\/shares$/);
      if (serverSharesMatch) {
        const serverId = parseInt(serverSharesMatch[1], 10);
        if (request.method === 'GET') {
          const userId = Number(url.searchParams.get('user_id'));
          return this.handleListShares(serverId, userId);
        }
        if (request.method === 'POST') return this.handleCreateShare(serverId, request);
      }

      const shareMatch = path.match(/^\/internal\/shares\/([^/]+)$/);
      if (shareMatch && request.method === 'GET') {
        const userId = Number(url.searchParams.get('user_id'));
        return this.handleGetShare(shareMatch[1], userId);
      }
      const shareStatusMatch = path.match(/^\/internal\/shares\/([^/]+)\/status$/);
      if (shareStatusMatch && request.method === 'PUT') {
        return this.handleUpdateShareStatus(shareStatusMatch[1], request);
      }
      // /internal/shares/:id/audit-purged —— 仅由 SSHShareDO 清理审计后调用
      const sharePurgedMatch = path.match(/^\/internal\/shares\/([^/]+)\/audit-purged$/);
      if (sharePurgedMatch && request.method === 'POST') {
        return this.handleShareAuditPurged(sharePurgedMatch[1], request);
      }

      // /internal/servers/:id/os —— 仅由 SSHSession（可信会话）通过 DO stub 调用
      const osMatch = path.match(/^\/internal\/servers\/(\d+)\/os$/);
      if (osMatch && request.method === 'PUT') {
        return this.handleUpdateServerOS(parseInt(osMatch[1], 10), request);
      }

      // /internal/servers/:id/memory
      const memoryMatch = path.match(/^\/internal\/servers\/(\d+)\/memory$/);
      if (memoryMatch && request.method === 'GET') {
        const serverId = parseInt(memoryMatch[1], 10);
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        return this.handleGetServerMemory(serverId, parseInt(userIdStr, 10));
      }

      // /internal/servers/:id/work-logs/:logId
      const singleWorkLogMatch = path.match(/^\/internal\/servers\/(\d+)\/work-logs\/(\d+)$/);
      if (singleWorkLogMatch && request.method === 'DELETE') {
        const serverId = parseInt(singleWorkLogMatch[1], 10);
        const logId = parseInt(singleWorkLogMatch[2], 10);
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        return this.handleDeleteWorkLog(serverId, logId, parseInt(userIdStr, 10));
      }

      // /internal/servers/:id/work-logs
      const workLogsMatch = path.match(/^\/internal\/servers\/(\d+)\/work-logs$/);
      if (workLogsMatch && request.method === 'POST') {
        const serverId = parseInt(workLogsMatch[1], 10);
        return this.handleSaveWorkLog(serverId, request);
      }

      // /internal/servers/:id/knowledge/batch
      const batchKnowledgeMatch = path.match(/^\/internal\/servers\/(\d+)\/knowledge\/batch$/);
      if (batchKnowledgeMatch && request.method === 'DELETE') {
        const serverId = parseInt(batchKnowledgeMatch[1], 10);
        return this.handleBatchDeleteKnowledge(serverId, request);
      }

      // /internal/servers/:id/knowledge/:kId
      const singleKnowledgeMatch = path.match(/^\/internal\/servers\/(\d+)\/knowledge\/(\d+)$/);
      if (singleKnowledgeMatch && request.method === 'DELETE') {
        const serverId = parseInt(singleKnowledgeMatch[1], 10);
        const kId = parseInt(singleKnowledgeMatch[2], 10);
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        return this.handleDeleteKnowledge(serverId, kId, parseInt(userIdStr, 10));
      }

      // /internal/servers/:id/knowledge
      const knowledgeMatch = path.match(/^\/internal\/servers\/(\d+)\/knowledge$/);
      if (knowledgeMatch && request.method === 'POST') {
        const serverId = parseInt(knowledgeMatch[1], 10);
        return this.handleSaveKnowledge(serverId, request);
      }

      // --- 用户自定义主题 ---
      if (path === '/internal/theme' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr, 10);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetTheme(userId);
      }
      if (path === '/internal/theme' && request.method === 'PUT') {
        return this.handlePutTheme(request);
      }
      // --- One-time-token 消费 ---
      if (path === '/internal/connect-token/consume' && request.method === 'POST') {
        return this.handleConsumeToken(request);
      }

      // --- known_hosts 管理 ---
      if (path === '/internal/known-hosts' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr, 10);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetKnownHosts(
          userId,
          url.searchParams.get('host'),
          url.searchParams.get('port')
        );
      }
      if (path === '/internal/known-hosts' && request.method === 'POST') {
        return this.handleUpsertKnownHost(request);
      }
      if (path === '/internal/known-hosts' && request.method === 'DELETE') {
        return this.handleDeleteKnownHost(request);
      }

      // --- 命令片段管理 ---
      if (path === '/internal/snippets' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr, 10);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetSnippets(userId);
      }
      if (path === '/internal/snippets' && request.method === 'POST') {
        return this.handleCreateSnippet(request);
      }
      const snippetMatch = path.match(/^\/internal\/snippets\/(\d+)$/);
      if (snippetMatch) {
        const snippetId = parseInt(snippetMatch[1], 10);
        if (request.method === 'PUT') return this.handleUpdateSnippet(snippetId, request);
        if (request.method === 'DELETE') return this.handleDeleteSnippet(snippetId, request);
      }

      // --- P2P Agent 注册与管理 ---
      if (path === '/internal/agents' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr, 10);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleListAgents(userId);
      }
      if (path === '/internal/agents' && request.method === 'POST') {
        return this.handleCreateAgent(request);
      }
      const agentMatch = path.match(/^\/internal\/agents\/([^/]+)$/);
      if (agentMatch && request.method === 'DELETE') {
        const userId = Number(url.searchParams.get('user_id'));
        return this.handleDeleteAgent(agentMatch[1], userId);
      }
      if (agentMatch && request.method === 'GET') {
        const userId = Number(url.searchParams.get('user_id'));
        return this.handleGetAgent(agentMatch[1], userId);
      }
      // 仅由 Worker 在 agent token 校验时调用（/api/agent/ws 与 /internal/agent/*）
      if (path === '/internal/agents/validate' && request.method === 'POST') {
        return this.handleValidateAgentToken(request);
      }
      // 仅由 agent:* DO 在 agent 心跳/上线时调用
      if (path === '/internal/agents/heartbeat' && request.method === 'POST') {
        return this.handleAgentHeartbeat(request);
      }

      return Response.json({ error: 'Not Found' }, { status: 404 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[UserDB] Unhandled error:', msg);
      return Response.json({ error: '服务器内部错误' }, { status: 500 });
    }
  }

  // ==================== 用户管理 ====================

  private async handleOAuthUser(request: Request): Promise<Response> {
    const { github_id, username, avatar_url } = await request.json<{
      github_id: number;
      username: string;
      avatar_url: string;
    }>();

    // Upsert 用户（行形状：users 的 id/github_id/username/avatar_url 列）
    const existing = this.query<UserRow>(
      'SELECT id, github_id, username, avatar_url FROM users WHERE github_id = ?',
      github_id
    );

    if (existing.length > 0) {
      // 更新用户信息
      this.db.exec(
        "UPDATE users SET username = ?, avatar_url = ?, updated_at = datetime('now') WHERE github_id = ?",
        username,
        avatar_url,
        github_id
      );
      const user = existing[0];
      user.username = username;
      user.avatar_url = avatar_url;
      return Response.json(user);
    }

    // 新建用户
    this.db.exec(
      'INSERT INTO users (github_id, username, avatar_url) VALUES (?, ?, ?)',
      github_id,
      username,
      avatar_url
    );

    const newUser = this.query<UserRow>(
      'SELECT id, github_id, username, avatar_url FROM users WHERE github_id = ?',
      github_id
    )[0];

    return Response.json(newUser);
  }

  // ==================== Session 管理 ====================

  private async handleSessionCreate(request: Request): Promise<Response> {
    const { user_id } = await request.json<{ user_id: number }>();

    // 获取 github_id
    const userRows = this.db.exec('SELECT github_id FROM users WHERE id = ?', user_id).toArray();
    if (userRows.length === 0) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }
    const github_id = (userRows[0] as any).github_id;

    // 生成 token (github_id:randomHex)
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const randomHex = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const token = `${github_id}:${randomHex}`;

    // 7 天过期
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    this.db.exec(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
      token,
      user_id,
      expiresAt
    );

    // 清理该用户的过期 session
    this.db.exec(
      "DELETE FROM sessions WHERE user_id = ? AND expires_at < datetime('now')",
      user_id
    );

    return Response.json({ token, expires_at: expiresAt });
  }

  private async handleSessionVerify(request: Request): Promise<Response> {
    const { token } = await request.json<{ token: string }>();

    const rows = this.query<UserRow>(
      `SELECT u.id, u.github_id, u.username, u.avatar_url
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
      token
    );

    if (rows.length === 0) {
      return Response.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    return Response.json(rows[0]);
  }

  private async handleSessionDelete(request: Request): Promise<Response> {
    const { token } = await request.json<{ token: string }>();
    this.db.exec('DELETE FROM sessions WHERE token = ?', token);
    return Response.json({ success: true });
  }

  // ==================== 服务器 CRUD ====================

  private handleGetServers(userId: number): Response {
    const rows = this.query<ServerRow>(
      `SELECT id, user_id, name, host, port, username, auth_method, region, inferred_hint, tags, os, jump_server_id, agent_id, agent_loopback, created_at, updated_at
       FROM servers WHERE user_id = ? ORDER BY updated_at DESC`,
      userId
    );

    return Response.json(rows.map((row) => deserializeServerRow(row)));
  }

  private validateJumpChain(
    userId: number,
    targetServerId: number | null,
    jumpServerId: number | null
  ): string | null {
    if (jumpServerId === null) return null;
    if (!Number.isInteger(jumpServerId) || jumpServerId <= 0) return '无效的跳板服务器';

    const seen = new Set<number>();
    if (targetServerId !== null) seen.add(targetServerId);
    let currentId: number | null = jumpServerId;
    let depth = 0;

    while (currentId !== null) {
      if (seen.has(currentId)) return '跳板服务器关系不能形成循环';
      seen.add(currentId);
      depth++;
      if (depth > MAX_JUMP_HOSTS) return `最多允许 ${MAX_JUMP_HOSTS} 级 SSH 跳转`;

      const rows: JumpRow[] = this.query<JumpRow>(
        'SELECT user_id, jump_server_id FROM servers WHERE id = ?',
        currentId
      );
      if (rows.length === 0) return '所选跳板服务器不存在';
      const row = rows[0];
      if (row.user_id !== userId) return '不能使用其他用户的服务器作为跳板';
      currentId = row.jump_server_id ?? null;
    }
    return null;
  }

  private async handleAddServer(request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      name: string;
      host: string;
      port: number;
      username: string;
      credential: string;
      auth_method: string;
      region?: string;
      tags?: unknown;
      jump_server_id?: number | null;
    }>();

    const port = body.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Response.json({ error: '端口必须是 1-65535 之间的整数' }, { status: 400 });
    }
    if (!AUTH_METHODS.has(body.auth_method)) {
      return Response.json({ error: '不支持的认证方式' }, { status: 400 });
    }
    if (typeof body.credential !== 'string' || body.credential.length === 0) {
      return Response.json({ error: '认证凭据不能为空' }, { status: 400 });
    }
    const jumpServerId = body.jump_server_id ?? null;
    const jumpError = this.validateJumpChain(body.user_id, null, jumpServerId);
    if (jumpError) return Response.json({ error: jumpError }, { status: 400 });

    const requestedRegion = (ALLOWED_LOCATION_HINTS as readonly string[]).includes(
      body.region || ''
    )
      ? body.region || null
      : null;
    // 只有 Cloudflare 直接建立 TCP 连接的跳板链入口需要区域偏好。
    // 下游节点的区域由最外层入口决定，保存自身区域只会产生误导和无效查询。
    const region = jumpServerId === null ? requestedRegion : null;

    // 加密凭据
    const encrypted = await this.encryptCredential(body.credential, body.user_id);

    // Auto 模式保存时一次性推断 locationHint，结果持久化入 inferred_hint 列
    // 手动区域已经能够直接决定调度，无需向 IPinfo 发送主机信息
    // 失败时返回 null，连接时退化为 Auto
    let inferredHint: string | null = null;
    let inferDebug: string[] = [];
    if (jumpServerId !== null) {
      inferDebug.push('[IP-GEO] 当前服务器通过跳板连接，区域由最外层入口决定，跳过推断');
    } else if (region === null) {
      try {
        const result = await inferLocationHint(body.host);
        inferredHint = result.hint ?? null;
        inferDebug = result.debug;
      } catch (e) {
        inferDebug.push(`[IP-GEO] 异常: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      inferDebug.push('[IP-GEO] 已手动指定区域，跳过推断');
    }

    // Encryption and IP inference may yield; re-check the saved relation at
    // the write boundary to keep the maximum depth invariant.
    const currentJumpError = this.validateJumpChain(body.user_id, null, jumpServerId);
    if (currentJumpError) return Response.json({ error: currentJumpError }, { status: 400 });

    this.db.exec(
      'INSERT INTO servers (user_id, name, host, port, username, credential, auth_method, region, inferred_hint, tags, jump_server_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      body.user_id,
      body.name,
      body.host,
      port,
      body.username,
      encrypted,
      body.auth_method,
      region,
      inferredHint, // 系统推断值（可 NULL）
      serializeServerTags(body.tags),
      jumpServerId
    );

    // 获取新创建的记录
    const rows = this.query<ServerRow>(
      `SELECT id, user_id, name, host, port, username, auth_method, region, inferred_hint, tags, os, jump_server_id, agent_id, agent_loopback, created_at, updated_at
       FROM servers WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      body.user_id
    );

    // DEBUG_MODE 开启时，在响应中附带调试信息
    // 行形状由上方 SELECT 的 servers 全列定义；deserializeServerRow 归一化 tags 后直接序列化
    const server = deserializeServerRow(rows[0]);
    if (this.env.DEBUG_MODE === 'true') {
      return Response.json({ ...server, _debug: inferDebug }, { status: 201 });
    }
    return Response.json(server, { status: 201 });
  }

  private async handleUpdateServer(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      name?: string;
      host?: string;
      port?: number;
      username?: string;
      credential?: string;
      auth_method?: string;
      region?: string;
      tags?: unknown;
      jump_server_id?: number | null;
    }>();

    // 验证服务器属于该用户（行形状：user_id/host/port/auth_method/region/inferred_hint/jump_server_id）
    const existing = this.query<ServerEditRow>(
      'SELECT user_id, host, port, auth_method, region, inferred_hint, jump_server_id FROM servers WHERE id = ?',
      serverId
    );
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    const current = existing[0];
    if (current.user_id !== body.user_id)
      return Response.json({ error: 'Forbidden' }, { status: 403 });

    if (body.auth_method !== undefined && !AUTH_METHODS.has(body.auth_method)) {
      return Response.json({ error: '不支持的认证方式' }, { status: 400 });
    }
    const hasNewCredential = typeof body.credential === 'string' && body.credential.length > 0;
    if (body.credential !== undefined && !hasNewCredential) {
      return Response.json({ error: '认证凭据不能为空' }, { status: 400 });
    }
    if (
      body.auth_method !== undefined &&
      body.auth_method !== current.auth_method &&
      !hasNewCredential
    ) {
      return Response.json({ error: '切换认证方式时必须同时提供对应凭据' }, { status: 400 });
    }
    const nextJumpServerId =
      body.jump_server_id === undefined ? current.jump_server_id : body.jump_server_id;
    const jumpError = this.validateJumpChain(body.user_id, serverId, nextJumpServerId);
    if (jumpError) return Response.json({ error: jumpError }, { status: 400 });

    // 历史下游节点可能残留区域值；从跳板切回直连且请求未显式指定区域时，
    // 应回到 Auto，而不是复用一个此前从未参与连接调度的旧值。
    // 未提供且直连：沿用旧区域；跳板连接：清空；提供但非法：视为未提供（Auto）
    let requestedRegion: string | null = null;
    if (body.region !== undefined) {
      if ((ALLOWED_LOCATION_HINTS as readonly string[]).includes(body.region)) {
        requestedRegion = body.region;
      }
    } else if (current.jump_server_id === null) {
      requestedRegion = current.region;
    }
    const normalizedRegion = nextJumpServerId === null ? requestedRegion : null;
    const isDirect = nextJumpServerId === null;
    const becameDirect = current.jump_server_id !== null && isDirect;
    const hostChanged = body.host !== undefined && body.host !== current.host;
    const portChanged = body.port !== undefined && body.port !== current.port;
    const switchedToAuto =
      isDirect && body.region !== undefined && normalizedRegion === null && current.region !== null;

    // 构建更新语句
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.host !== undefined) {
      updates.push('host = ?');
      values.push(body.host);
    }
    const shouldInfer =
      isDirect &&
      normalizedRegion === null &&
      (hostChanged || becameDirect || (switchedToAuto && current.inferred_hint === null));
    if (shouldInfer) {
      let newInferred: string | null = null;
      try {
        const result = await inferLocationHint(body.host ?? current.host);
        newInferred = result.hint ?? null;
      } catch {
        newInferred = null;
      }
      updates.push('inferred_hint = ?');
      values.push(newInferred);
    } else if (!isDirect && current.inferred_hint !== null) {
      // 切换为跳板连接或编辑历史下游节点时，顺带清理不再生效的推断值。
      updates.push('inferred_hint = ?');
      values.push(null);
    } else if (isDirect && normalizedRegion !== null && (hostChanged || becameDirect)) {
      // 主机变化或从跳板切回手动直连时，旧推断值不能继续代表当前入口。
      updates.push('inferred_hint = ?');
      values.push(null);
    }
    if (body.port !== undefined) {
      if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
        return Response.json({ error: '端口必须是 1-65535 之间的整数' }, { status: 400 });
      }
      updates.push('port = ?');
      values.push(body.port);
    }
    if (hostChanged || portChanged) {
      // 主机地址或端口可能指向另一台 SSH 服务，旧 OS 结果与工作记忆不可继续复用。
      updates.push('os = NULL');
      try {
        this.db.exec('DELETE FROM server_memories WHERE server_id = ?', serverId);
      } catch {
        /* ignore */
      }
      try {
        this.db.exec('DELETE FROM server_task_checkpoints WHERE server_id = ?', serverId);
      } catch {
        /* ignore */
      }
      this.db.exec('DELETE FROM server_work_logs WHERE server_id = ?', serverId);
      this.db.exec('DELETE FROM server_knowledge WHERE server_id = ?', serverId);
    }
    if (body.username !== undefined) {
      updates.push('username = ?');
      values.push(body.username);
    }
    if (hasNewCredential) {
      const encrypted = await this.encryptCredential(body.credential!, body.user_id);
      updates.push('credential = ?');
      values.push(encrypted);
    }
    if (body.auth_method !== undefined) {
      updates.push('auth_method = ?');
      values.push(body.auth_method);
    }
    if (!isDirect && current.region !== null) {
      updates.push('region = ?');
      values.push(null);
    } else if (body.region !== undefined || becameDirect) {
      // 空字符串视为 Auto；下游节点始终清空区域，由跳板链入口统一决定。
      updates.push('region = ?');
      values.push(normalizedRegion);
    }
    if (body.tags !== undefined) {
      updates.push('tags = ?');
      values.push(serializeServerTags(body.tags));
    }
    if (body.jump_server_id !== undefined) {
      updates.push('jump_server_id = ?');
      values.push(body.jump_server_id);
    }

    if (updates.length > 0) {
      // Credential encryption and region inference may yield; validate again
      // immediately before the write so concurrent updates cannot create a cycle.
      const currentJumpError = this.validateJumpChain(body.user_id, serverId, nextJumpServerId);
      if (currentJumpError) return Response.json({ error: currentJumpError }, { status: 400 });
      updates.push("updated_at = datetime('now')");
      values.push(serverId);
      // SET 片段仅来自本函数硬编码白名单（列名 + '?' 或固定字面量），动态值全部经 values 参数绑定
      // pi-lens-ignore: sql-injection
      this.db.exec(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`, ...values);
    }

    const row = this.query<ServerRow>(
      `SELECT id, user_id, name, host, port, username, auth_method, region, inferred_hint, tags, os, jump_server_id, agent_id, agent_loopback, created_at, updated_at
       FROM servers WHERE id = ?`,
      serverId
    );

    return Response.json(deserializeServerRow(row[0]));
  }

  private async handleDeleteServer(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{ user_id: number }>();

    // 验证服务器属于该用户
    const existing = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    const ownerUserId = existing[0].user_id;
    if (ownerUserId !== body.user_id) return Response.json({ error: 'Forbidden' }, { status: 403 });

    const references = this.query<ServerNameRow>(
      'SELECT name FROM servers WHERE user_id = ? AND jump_server_id = ? ORDER BY name LIMIT 5',
      body.user_id,
      serverId
    );
    if (references.length > 0) {
      return Response.json(
        {
          error: `该服务器正被 ${references.map((row) => row.name).join('、')} 用作跳板，请先解除引用`,
        },
        { status: 409 }
      );
    }

    const activeShares = Number(
      (this.one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ssh_shares
       WHERE user_id = ? AND server_id = ? AND status IN ('unused', 'claimed', 'active')`,
        body.user_id,
        serverId
      ) ?? { count: 0 }).count
    );
    if (activeShares > 0) {
      return Response.json(
        { error: '该服务器仍有待使用或活动的分享，请先撤销分享' },
        { status: 409 }
      );
    }

    try {
      this.db.exec('DELETE FROM server_memories WHERE server_id = ?', serverId);
    } catch {
      /* ignore if legacy table was already dropped */
    }
    try {
      this.db.exec('DELETE FROM server_task_checkpoints WHERE server_id = ?', serverId);
    } catch {
      /* ignore */
    }
    this.db.exec('DELETE FROM server_work_logs WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM server_knowledge WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM servers WHERE id = ?', serverId);
    return Response.json({ success: true });
  }

  /**
   * 更新服务器检测到的操作系统标识。
   * 仅由 SSHSession（已认证会话）通过 DO stub 调用，不对外暴露公开路由。
   */
  private async handleUpdateServerOS(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{ user_id: number; os: string }>();

    // 验证服务器属于该用户
    const existing = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    const ownerUserId = existing[0].user_id;
    if (ownerUserId !== body.user_id) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!isDetectedOS(body.os)) {
      return Response.json({ error: 'Invalid os' }, { status: 400 });
    }

    this.db.exec('UPDATE servers SET os = ? WHERE id = ?', body.os, serverId);
    return Response.json({ success: true });
  }

  /**
   * 绑定/解绑服务器的前置 P2P Agent。
   * agent_id 为空表示解绑；agent_loopback=1 表示 Agent 就装在该服务器上
   * （P2P 会话把目标改写为 127.0.0.1，绕开公网回环与 NAT 不可达问题）。
   */
  private async handleBindServerAgent(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      agent_id: string | null;
      agent_loopback?: boolean;
    }>();
    if (!Number.isInteger(body.user_id) || body.user_id <= 0) {
      return Response.json({ error: 'Invalid user_id' }, { status: 400 });
    }
    const existing = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    if (existing[0].user_id !== body.user_id) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const agentId = typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : null;
    if (agentId !== null) {
      const agents = this.query<{ user_id: number }>(
        'SELECT user_id FROM agents WHERE id = ?',
        agentId
      );
      if (agents.length === 0 || agents[0].user_id !== body.user_id) {
        return Response.json({ error: 'Agent not found' }, { status: 404 });
      }
    }

    const loopback = agentId !== null && body.agent_loopback === true ? 1 : 0;
    this.db.exec(
      "UPDATE servers SET agent_id = ?, agent_loopback = ?, updated_at = datetime('now') WHERE id = ?",
      agentId,
      loopback,
      serverId
    );
    return Response.json({ success: true, agent_id: agentId, agent_loopback: loopback });
  }

  // ==================== 一次性 SSH 分享 ====================

  private handleListShares(serverId: number, userId: number): Response {
    if (!Number.isInteger(userId) || userId <= 0) {
      return Response.json({ error: 'Invalid user_id' }, { status: 400 });
    }
    const server = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (server.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    const ownerUserId = server[0].user_id;
    if (ownerUserId !== userId) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    const now = Date.now();
    this.db.exec(
      `UPDATE ssh_shares SET status = 'expired', closed_at = ?
       WHERE user_id = ? AND server_id = ? AND status = 'unused' AND expires_at <= ?`,
      now,
      userId,
      serverId,
      now
    );
    const rows = this.db
      .exec(
        `SELECT id, server_id, expires_at, max_session_seconds, status,
              claimed_at, active_at, closed_at, created_at,
              audit_purged_at, audit_purge_type
       FROM ssh_shares WHERE user_id = ? AND server_id = ?
       ORDER BY created_at DESC LIMIT 50`,
        userId,
        serverId
      )
      .toArray();
    return Response.json(
      rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        serverId: row.server_id,
        expiresAt: row.expires_at,
        maxSessionSeconds: row.max_session_seconds,
        status: row.status,
        claimedAt: row.claimed_at,
        activeAt: row.active_at,
        closedAt: row.closed_at,
        createdAt: row.created_at,
        auditPurgedAt: row.audit_purged_at ?? null,
        auditPurgeType: row.audit_purge_type ?? null,
      }))
    );
  }

  private async handleCreateShare(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      share_id: string;
      share_ref: string;
      expires_at: number;
      max_session_seconds: number;
    }>();
    return this.createShareRecord(serverId, body);
  }

  private async createShareRecord(
    serverId: number,
    body: {
      user_id: number;
      share_id: string;
      share_ref: string;
      expires_at: number;
      max_session_seconds: number;
    }
  ): Promise<Response> {
    if (!Number.isInteger(body.user_id) || !body.share_id || !body.share_ref) {
      return Response.json({ error: 'Invalid share request' }, { status: 400 });
    }
    const now = Date.now();
    if (
      !Number.isFinite(body.expires_at) ||
      body.expires_at < now + 60_000 ||
      body.expires_at > now + 60 * 60_000
    ) {
      return Response.json({ error: '分享链接有效期必须在 1-60 分钟之间' }, { status: 400 });
    }
    if (
      !Number.isInteger(body.max_session_seconds) ||
      body.max_session_seconds < 300 ||
      body.max_session_seconds > 7200
    ) {
      return Response.json({ error: '分享会话时长必须在 5-120 分钟之间' }, { status: 400 });
    }
    const validation = this.validateShareableServer(serverId, body.user_id);
    if (validation instanceof Response) return validation;
    const activeCount = Number(
      (this.one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ssh_shares
       WHERE user_id = ? AND status IN ('unused', 'claimed', 'active') AND expires_at > ?`,
        body.user_id,
        now
      ) ?? { count: 0 }).count
    );
    if (activeCount >= 10) {
      return Response.json(
        { error: '待使用或活动分享数量已达上限，请先撤销旧分享' },
        { status: 429 }
      );
    }
    this.db.exec(
      `INSERT INTO ssh_shares (
        id, user_id, server_id, share_ref, expires_at,
        max_session_seconds, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'unused', ?)`,
      body.share_id,
      body.user_id,
      serverId,
      body.share_ref,
      body.expires_at,
      body.max_session_seconds,
      now
    );
    return Response.json(
      {
        id: body.share_id,
        shareRef: body.share_ref,
        serverName: validation.serverName,
        expiresAt: body.expires_at,
        maxSessionSeconds: body.max_session_seconds,
      },
      { status: 201 }
    );
  }

  private validateShareableServer(
    serverId: number,
    userId: number
  ): { serverName: string } | Response {
    const seen = new Set<number>();
    const reversed: StoredServerRow[] = [];
    let currentId: number | null = serverId;
    while (currentId !== null) {
      if (seen.has(currentId)) {
        return Response.json({ error: '跳板服务器关系存在循环' }, { status: 400 });
      }
      seen.add(currentId);
      const rows: StoredServerRow[] = this.query<StoredServerRow>('SELECT * FROM servers WHERE id = ?', currentId);
      if (rows.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
      const row = rows[0];
      if (row.user_id !== userId) return Response.json({ error: 'Forbidden' }, { status: 403 });
      reversed.push(row);
      if (reversed.length > MAX_JUMP_HOSTS + 1) {
        return Response.json({ error: `最多允许 ${MAX_JUMP_HOSTS} 级 SSH 跳转` }, { status: 400 });
      }
      currentId = row.jump_server_id ?? null;
    }

    const chain = reversed.reverse();
    const pathSegments: string[] = [];
    for (let index = 0; index < chain.length; index++) {
      const server = chain[index];
      const identity = index === 0 ? server.host : `jump:${pathSegments.join('>')}|${server.host}`;
      pathSegments.push(`${server.id}@${server.host}:${server.port}`);
      const known = this.db
        .exec(
          'SELECT fingerprint FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?',
          userId,
          identity,
          server.port
        )
        .toArray();
      if (known.length === 0) {
        return Response.json(
          {
            error: '创建分享前，请先通过普通连接验证目标服务器及全部跳板节点的主机指纹',
          },
          { status: 409 }
        );
      }
    }
    return { serverName: chain[chain.length - 1].name };
  }

  private handleGetShare(shareId: string, userId: number): Response {
    if (!Number.isInteger(userId) || userId <= 0) {
      return Response.json({ error: 'Invalid user_id' }, { status: 400 });
    }
    const rows = this.db
      .exec(
        `SELECT id, user_id, server_id, share_ref, expires_at, max_session_seconds,
              status, claimed_at, active_at, closed_at, created_at
       FROM ssh_shares WHERE id = ?`,
        shareId
      )
      .toArray();
    if (rows.length === 0) return Response.json({ error: 'Share not found' }, { status: 404 });
    const row = rows[0] as Record<string, unknown>;
    if (Number(row.user_id) !== userId)
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    return Response.json({
      id: row.id,
      serverId: row.server_id,
      shareRef: row.share_ref,
      expiresAt: row.expires_at,
      maxSessionSeconds: row.max_session_seconds,
      status: row.status,
      claimedAt: row.claimed_at,
      activeAt: row.active_at,
      closedAt: row.closed_at,
      createdAt: row.created_at,
    });
  }

  private async handleUpdateShareStatus(shareId: string, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      status: string;
      claimed_at?: number;
      active_at?: number;
      closed_at?: number;
    }>();
    const allowed = new Set(['unused', 'claimed', 'active', 'closed', 'revoked', 'expired']);
    if (!Number.isInteger(body.user_id) || !allowed.has(body.status)) {
      return Response.json({ error: 'Invalid share status update' }, { status: 400 });
    }
    const rows = this.query<UserIdRow>('SELECT user_id FROM ssh_shares WHERE id = ?', shareId);
    if (rows.length === 0) return Response.json({ error: 'Share not found' }, { status: 404 });
    const ownerUserId = rows[0].user_id;
    if (ownerUserId !== body.user_id) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    this.db.exec(
      `UPDATE ssh_shares SET status = ?,
       claimed_at = COALESCE(?, claimed_at),
       active_at = COALESCE(?, active_at),
       closed_at = COALESCE(?, closed_at)
       WHERE id = ?`,
      body.status,
      body.claimed_at ?? null,
      body.active_at ?? null,
      body.closed_at ?? null,
      shareId
    );
    return Response.json({ success: true });
  }

  /** SSHShareDO 清理审计后同步留痕：记录清理时间与方式，供管理端集中展示。 */
  private async handleShareAuditPurged(shareId: string, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      purged_at: number;
      purge_type: string;
    }>();
    if (
      !Number.isInteger(body.user_id) ||
      !Number.isFinite(body.purged_at) ||
      (body.purge_type !== 'manual' && body.purge_type !== 'auto')
    ) {
      return Response.json({ error: 'Invalid audit purge update' }, { status: 400 });
    }
    const rows = this.query<UserIdRow>('SELECT user_id FROM ssh_shares WHERE id = ?', shareId);
    if (rows.length === 0) return Response.json({ error: 'Share not found' }, { status: 404 });
    const ownerUserId = rows[0].user_id;
    if (ownerUserId !== body.user_id) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    this.db.exec(
      'UPDATE ssh_shares SET audit_purged_at = ?, audit_purge_type = ? WHERE id = ?',
      body.purged_at,
      body.purge_type,
      shareId
    );
    return Response.json({ success: true });
  }

  private async handleShareConnectionConfig(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      share_id: string;
      share_ref: string;
      session_expires_at: number;
    }>();
    if (!body.share_id || !body.share_ref || !Number.isFinite(body.session_expires_at)) {
      return Response.json({ error: 'Invalid share session policy' }, { status: 400 });
    }
    const metadata = this.query<ShareMetaRow>(
      `SELECT user_id, server_id, share_ref, status FROM ssh_shares WHERE id = ?`,
      body.share_id
    );
    if (metadata.length === 0) return Response.json({ error: 'Share not found' }, { status: 404 });
    const row = metadata[0];
    if (
      row.user_id !== body.user_id ||
      row.server_id !== serverId ||
      row.share_ref !== body.share_ref
    ) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (row.status !== 'claimed' && row.status !== 'active') {
      return Response.json({ error: 'Share is no longer active' }, { status: 409 });
    }

    const tokenResponse = await this.handleConnectServer(
      serverId,
      new Request('http://internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: body.user_id }),
      })
    );
    if (!tokenResponse.ok) return tokenResponse;
    const { token } = await tokenResponse.json<{ token: string }>();
    const configResponse = await this.handleConsumeToken(
      new Request('http://internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    );
    if (!configResponse.ok) return configResponse;
    const config = await configResponse.json<SSHConnectionConfig>();
    if (
      !config.expectedFingerprint ||
      (config.jumpHosts || []).some((hop) => !hop.expectedFingerprint)
    ) {
      return Response.json(
        {
          error: '分享会话要求目标服务器及全部跳板节点已有可信主机指纹',
        },
        { status: 409 }
      );
    }
    config.sessionPolicy = {
      source: 'share',
      shareId: body.share_id,
      shareRef: body.share_ref,
      allowSftp: true,
      allowMetadataMutation: false,
      allowHostKeyMutation: false,
      allowReconnect: false,
      sessionExpiresAt: body.session_expires_at,
    };
    return Response.json(config);
  }

  // ==================== 用户自定义主题 ====================

  private handleGetTheme(userId: number): Response {
    const rows = this.query<ThemeRow>('SELECT theme_data FROM user_themes WHERE user_id = ?', userId);

    if (rows.length === 0) {
      return Response.json({ theme: null });
    }

    try {
      return Response.json({
        // 行形状由上方 SELECT('theme_data') 定义，非法 JSON 由 catch 兜底为 null
        theme: JSON.parse(rows[0].theme_data),
      });
    } catch {
      return Response.json({ theme: null });
    }
  }

  private async handlePutTheme(request: Request): Promise<Response> {
    const { user_id, theme_data } = await request.json<{ user_id: number; theme_data: string }>();

    this.db.exec(
      `INSERT INTO user_themes (user_id, theme_data, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET theme_data = excluded.theme_data, updated_at = excluded.updated_at`,
      user_id,
      theme_data
    );

    return Response.json({ success: true });
  }

  // ==================== One-time-token 连接 ====================

  private async handleConnectServer(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{ user_id: number }>();

    // Resolve the saved relation into one bounded, immutable outer-to-target chain.
    const reversed: StoredServerRow[] = [];
    const seen = new Set<number>();
    let currentId: number | null = serverId;
    while (currentId !== null) {
      if (seen.has(currentId)) {
        return Response.json({ error: '跳板服务器关系存在循环' }, { status: 400 });
      }
      seen.add(currentId);
      const rows: StoredServerRow[] = this.query<StoredServerRow>('SELECT * FROM servers WHERE id = ?', currentId);
      if (rows.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
      const row = rows[0];
      if (row.user_id !== body.user_id)
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      reversed.push(row);
      if (reversed.length > MAX_JUMP_HOSTS + 1) {
        return Response.json({ error: `最多允许 ${MAX_JUMP_HOSTS} 级 SSH 跳转` }, { status: 400 });
      }
      currentId = row.jump_server_id ?? null;
    }

    const chain = reversed.reverse();
    const target = chain[chain.length - 1];
    const pathSegments: string[] = [];
    const resolved = await Promise.all(
      chain.map(async (server, index) => {
        const identity =
          index === 0 ? server.host : `jump:${pathSegments.join('>')}|${server.host}`;
        pathSegments.push(`${server.id}@${server.host}:${server.port}`);
        const credential = await this.decryptCredential(server.credential, body.user_id);
        const khRows = this.query<FingerprintRow>(
          'SELECT fingerprint FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?',
          body.user_id,
          identity,
          server.port
        );
        return {
          server,
          identity,
          credential,
          expectedFingerprint:
            khRows.length > 0 ? khRows[0].fingerprint : undefined,
        };
      })
    );

    const outermost = chain[0];
    const locationHint = outermost.region || outermost.inferred_hint || undefined;

    const userRows = this.db
      .exec('SELECT github_id FROM users WHERE id = ?', body.user_id)
      .toArray();
    if (userRows.length === 0) return Response.json({ error: 'User not found' }, { status: 404 });
    const github_id = (userRows[0] as any).github_id;

    // 生成 one-time-token
    const token = `${github_id}:${crypto.randomUUID()}`;
    const jumpHosts: SSHJumpHostConfig[] = resolved.slice(0, -1).map((node) => ({
      serverId: node.server.id,
      name: node.server.name,
      host: node.server.host,
      port: node.server.port,
      username: node.server.username,
      password: node.server.auth_method === 'password' ? node.credential : '',
      authMethod: node.server.auth_method === 'publickey' ? 'publickey' : 'password',
      privateKey: node.server.auth_method === 'publickey' ? node.credential : '',
      expectedFingerprint: node.expectedFingerprint,
      knownHostIdentity: node.identity,
    }));
    const targetNode = resolved[resolved.length - 1];
    const config: SSHConnectionConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.auth_method === 'password' ? targetNode.credential : '',
      authMethod: target.auth_method === 'publickey' ? 'publickey' : 'password',
      privateKey: target.auth_method === 'publickey' ? targetNode.credential : '',
      expectedFingerprint: targetNode.expectedFingerprint,
      knownHostIdentity: targetNode.identity,
      userId: String(body.user_id),
      githubId: String(github_id),
      serverId: target.id,
      os: target.os,
      locationHint,
      jumpHosts,
      agentId: target.agent_id ?? null,
      agentLoopback: !!target.agent_loopback,
    };

    // 防止 token 数量无限增长
    if (this.connectTokens.size >= UserDBDO.MAX_CONNECT_TOKENS) {
      this.cleanExpiredTokens();
      if (this.connectTokens.size >= UserDBDO.MAX_CONNECT_TOKENS) {
        return Response.json({ error: 'Too many pending connections' }, { status: 429 });
      }
    }

    // 存入内存，60 秒过期
    this.connectTokens.set(token, {
      config,
      expiresAt: Date.now() + 60_000,
    });

    return Response.json({ token });
  }

  private async handleConsumeToken(request: Request): Promise<Response> {
    const { token } = await request.json<{ token: string }>();

    const entry = this.connectTokens.get(token);
    if (!entry) return Response.json({ error: 'Invalid or expired token' }, { status: 404 });

    // 立即删除（一次性）
    this.connectTokens.delete(token);

    if (Date.now() > entry.expiresAt) {
      return Response.json({ error: 'Token expired' }, { status: 410 });
    }

    return Response.json(entry.config);
  }

  private cleanExpiredTokens(): void {
    const now = Date.now();
    for (const [key, value] of this.connectTokens) {
      if (now > value.expiresAt) {
        this.connectTokens.delete(key);
      }
    }
  }

  // ==================== 凭据加密 ====================

  /**
   * AES-256-GCM 加密凭据
   * 密钥派生：PBKDF2(自动密钥, salt="cloudssh:userdb:" + user_id)
   * 存储格式：base64(iv + ciphertext + tag)
   */
  private async encryptCredential(plaintext: string, userId: number): Promise<string> {
    const key = await this.deriveEncryptionKey(userId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
    );

    // iv (12) + ciphertext+tag
    const combined = new Uint8Array(iv.length + ciphertext.length);
    combined.set(iv, 0);
    combined.set(ciphertext, iv.length);

    return btoa(String.fromCharCode(...combined));
  }

  private async decryptCredential(stored: string, userId: number): Promise<string> {
    const key = await this.deriveEncryptionKey(userId);
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const iv = raw.slice(0, 12);
    const ciphertext = raw.slice(12);

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  }

  private encryptionSecret: string | null = null;

  private async deriveEncryptionKey(userId: number): Promise<CryptoKey> {
    const cached = this.derivedKeyCache.get(userId);
    if (cached) return cached;

    if (!this.encryptionSecret) {
      const rows = this.db
        .exec("SELECT value FROM system_config WHERE key = 'encryption_secret'")
        .toArray();
      if (rows.length > 0) {
        this.encryptionSecret = rows[0].value as string;
      } else {
        // 兼容旧版：检查 session_secret 并迁移到 encryption_secret
        const oldRows = this.db
          .exec("SELECT value FROM system_config WHERE key = 'session_secret'")
          .toArray();
        if (oldRows.length > 0) {
          this.encryptionSecret = oldRows[0].value as string;
          this.db.exec(
            "INSERT INTO system_config (key, value) VALUES ('encryption_secret', ?)",
            this.encryptionSecret
          );
        } else {
          const bytes = new Uint8Array(32);
          crypto.getRandomValues(bytes);
          this.encryptionSecret = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          this.db.exec(
            "INSERT INTO system_config (key, value) VALUES ('encryption_secret', ?)",
            this.encryptionSecret
          );
        }
      }
    }

    const salt = new TextEncoder().encode(`cloudssh:userdb:${userId}`);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.encryptionSecret),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    const derived = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.derivedKeyCache.set(userId, derived);
    return derived;
  }

  // ==================== known_hosts 管理 ====================

  private handleGetKnownHosts(userId: number, host: string | null, port: string | null): Response {
    if (host && port) {
      // 查询特定 host:port 的指纹
      const rows = this.query<FingerprintRow>(
        'SELECT fingerprint FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?',
        userId,
        host,
        parseInt(port, 10)
      );
        if (rows.length === 0) {
          return Response.json({ fingerprint: null });
        }
        return Response.json({
          fingerprint: rows[0].fingerprint,
        });
    }

    // 列出所有已知主机
    const rows = this.db
      .exec(
        'SELECT id, host, port, fingerprint, created_at, updated_at FROM known_hosts WHERE user_id = ? ORDER BY updated_at DESC',
        userId
      )
      .toArray();
    return Response.json(rows);
  }

  private async handleUpsertKnownHost(request: Request): Promise<Response> {
    const { user_id, host, port, fingerprint } = await request.json<{
      user_id: number;
      host: string;
      port: number;
      fingerprint: string;
    }>();

    if (!host || !port || !fingerprint) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    this.db.exec(
      `INSERT INTO known_hosts (user_id, host, port, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id, host, port) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = datetime('now')`,
      user_id,
      host,
      port,
      fingerprint
    );

    return Response.json({ success: true });
  }

  private async handleDeleteKnownHost(request: Request): Promise<Response> {
    const { user_id, host, port } = await request.json<{
      user_id: number;
      host: string;
      port: number;
    }>();

    this.db.exec(
      'DELETE FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?',
      user_id,
      host,
      port
    );

    return Response.json({ success: true });
  }

  // ==================== 命令片段管理 ====================

  private handleGetSnippets(userId: number): Response {
    const rows = this.db
      .exec(
        'SELECT id, name, command, category, created_at, updated_at FROM command_snippets WHERE user_id = ? ORDER BY id ASC',
        userId
      )
      .toArray();
    return Response.json(rows);
  }

  private async handleCreateSnippet(request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      name?: unknown;
      command?: unknown;
      category?: unknown;
    }>();
    const normalized = normalizeSnippetInput(body.name, body.command, body.category);
    if (!normalized.ok) {
      return Response.json({ error: normalized.error }, { status: 400 });
    }
    const countRows = this.db
      .exec('SELECT COUNT(*) AS count FROM command_snippets WHERE user_id = ?', body.user_id)
      .toArray();
    const count = Number((countRows[0] as { count?: unknown } | undefined)?.count ?? 0);
    if (count >= SNIPPET_MAX_COUNT) {
      return Response.json({ error: 'limitReached' }, { status: 400 });
    }
    this.db.exec(
      `INSERT INTO command_snippets (user_id, name, command, category, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      body.user_id,
      normalized.value.name,
      normalized.value.command,
      normalized.value.category
    );
    const rows = this.db
      .exec(
        'SELECT id, name, command, category, created_at, updated_at FROM command_snippets WHERE user_id = ? ORDER BY id DESC LIMIT 1',
        body.user_id
      )
      .toArray();
    return Response.json(rows[0] ?? { success: true }, { status: 201 });
  }

  private async handleUpdateSnippet(snippetId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      name?: unknown;
      command?: unknown;
      category?: unknown;
    }>();
    const normalized = normalizeSnippetInput(body.name, body.command, body.category);
    if (!normalized.ok) {
      return Response.json({ error: normalized.error }, { status: 400 });
    }
    const existing = this.db
      .exec('SELECT id FROM command_snippets WHERE user_id = ? AND id = ?', body.user_id, snippetId)
      .toArray();
    if (existing.length === 0) {
      return Response.json({ error: 'notFound' }, { status: 404 });
    }
    this.db.exec(
      `UPDATE command_snippets SET name = ?, command = ?, category = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?`,
      normalized.value.name,
      normalized.value.command,
      normalized.value.category,
      body.user_id,
      snippetId
    );
    const rows = this.db
      .exec(
        'SELECT id, name, command, category, created_at, updated_at FROM command_snippets WHERE user_id = ? AND id = ?',
        body.user_id,
        snippetId
      )
      .toArray();
    return Response.json(rows[0] ?? { success: true });
  }

  private async handleDeleteSnippet(snippetId: number, request: Request): Promise<Response> {
    const { user_id } = await request.json<{ user_id: number }>();
    this.db.exec('DELETE FROM command_snippets WHERE user_id = ? AND id = ?', user_id, snippetId);
    return Response.json({ success: true });
  }

  // ==================== 服务器统一记忆 (Work Logs & Knowledge) ====================

  private handleGetServerMemory(serverId: number, userId: number): Response {
    const existing = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    if (existing[0].user_id !== userId) return Response.json({ error: 'Forbidden' }, { status: 403 });

    const workLogs = this.query<WorkLogRow>(
      `SELECT id, user_id, server_id, title, summary, created_at, updated_at
       FROM server_work_logs
       WHERE server_id = ? AND user_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      serverId,
      userId,
      MAX_SERVER_WORK_LOGS
    );

    const knowledge = this.query<KnowledgeRow>(
      `SELECT id, user_id, server_id, category, key, value, created_at, updated_at
       FROM server_knowledge
       WHERE server_id = ? AND user_id = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      serverId,
      userId,
      MAX_SERVER_KNOWLEDGE
    );

    const payload: UnifiedServerMemory = { workLogs, knowledge };
    return Response.json(payload);
  }

  private async handleSaveWorkLog(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      title?: unknown;
      summary?: unknown;
    }>();

    if (!body.user_id) return Response.json({ error: 'Missing user_id' }, { status: 400 });

    const existing = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    if (existing[0].user_id !== body.user_id) return Response.json({ error: 'Forbidden' }, { status: 403 });

    const normalized = normalizeWorkLogInput({
      title: body.title,
      summary: body.summary,
    });

    if (!normalized.ok) {
      return Response.json({ error: normalized.error }, { status: 400 });
    }

    const { title, summary } = normalized.value;
    const now = Date.now();

    this.db.exec(
      `INSERT INTO server_work_logs (user_id, server_id, title, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      body.user_id,
      serverId,
      title,
      summary,
      now,
      now
    );

    // 保持最多 MAX_SERVER_WORK_LOGS 条记录
    this.db.exec(
      `DELETE FROM server_work_logs
       WHERE server_id = ? AND user_id = ? AND id NOT IN (
         SELECT id FROM server_work_logs
         WHERE server_id = ? AND user_id = ?
         ORDER BY updated_at DESC LIMIT ?
       )`,
      serverId,
      body.user_id,
      serverId,
      body.user_id,
      MAX_SERVER_WORK_LOGS
    );

    const saved = this.query<WorkLogRow>(
      `SELECT id, user_id, server_id, title, summary, created_at, updated_at
       FROM server_work_logs
       WHERE server_id = ? AND user_id = ?
       ORDER BY updated_at DESC LIMIT 1`,
      serverId,
      body.user_id
    );

    return Response.json(saved[0] ?? { success: true }, { status: 201 });
  }

  private handleDeleteWorkLog(serverId: number, logId: number, userId: number): Response {
    const existing = this.query<UserIdRow>(
      'SELECT user_id FROM server_work_logs WHERE id = ? AND server_id = ?',
      logId,
      serverId
    );
    if (existing.length === 0) return Response.json({ error: 'Work log not found' }, { status: 404 });
    if (existing[0].user_id !== userId) return Response.json({ error: 'Forbidden' }, { status: 403 });

    this.db.exec(
      'DELETE FROM server_work_logs WHERE id = ? AND server_id = ? AND user_id = ?',
      logId,
      serverId,
      userId
    );
    return Response.json({ success: true });
  }

  private async handleSaveKnowledge(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      category?: unknown;
      key?: unknown;
      value?: unknown;
    }>();

    if (!body.user_id) return Response.json({ error: 'Missing user_id' }, { status: 400 });

    const existing = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    if (existing[0].user_id !== body.user_id) return Response.json({ error: 'Forbidden' }, { status: 403 });

    const normalized = normalizeKnowledgeInput({
      category: body.category,
      key: body.key,
      value: body.value,
    });

    if (!normalized.ok) {
      return Response.json({ error: normalized.error }, { status: 400 });
    }

    const { category, key, value } = normalized.value;
    const now = Date.now();

    this.db.exec(
      `INSERT INTO server_knowledge (user_id, server_id, category, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, server_id, key) DO UPDATE SET
         category = excluded.category,
         value = excluded.value,
         updated_at = excluded.updated_at`,
      body.user_id,
      serverId,
      category,
      key,
      value,
      now,
      now
    );

    // 保持最多 MAX_SERVER_KNOWLEDGE 条记录
    this.db.exec(
      `DELETE FROM server_knowledge
       WHERE server_id = ? AND user_id = ? AND id NOT IN (
         SELECT id FROM server_knowledge
         WHERE server_id = ? AND user_id = ?
         ORDER BY updated_at DESC LIMIT ?
       )`,
      serverId,
      body.user_id,
      serverId,
      body.user_id,
      MAX_SERVER_KNOWLEDGE
    );

    const saved = this.query<KnowledgeRow>(
      `SELECT id, user_id, server_id, category, key, value, created_at, updated_at
       FROM server_knowledge
       WHERE server_id = ? AND user_id = ? AND key = ?`,
      serverId,
      body.user_id,
      key
    );

    return Response.json(saved[0] ?? { success: true }, { status: 201 });
  }

  private handleDeleteKnowledge(serverId: number, kId: number, userId: number): Response {
    const existing = this.query<UserIdRow>(
      'SELECT user_id FROM server_knowledge WHERE id = ? AND server_id = ?',
      kId,
      serverId
    );
    if (existing.length === 0) return Response.json({ error: 'Knowledge item not found' }, { status: 404 });
    if (existing[0].user_id !== userId) return Response.json({ error: 'Forbidden' }, { status: 403 });

    this.db.exec(
      'DELETE FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?',
      kId,
      serverId,
      userId
    );
    return Response.json({ success: true });
  }

  private async handleBatchDeleteKnowledge(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{ user_id?: number; ids?: unknown }>();
    if (!body.user_id) return Response.json({ error: 'Missing user_id' }, { status: 400 });

    const norm = normalizeBatchDeleteKnowledgeInput(body);
    if (!norm.ok) {
      return Response.json({ error: norm.error }, { status: 400 });
    }

    const existing = this.query<UserIdRow>('SELECT user_id FROM servers WHERE id = ?', serverId);
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    if (existing[0].user_id !== body.user_id) return Response.json({ error: 'Forbidden' }, { status: 403 });

    const { ids } = norm.value;
    for (const id of ids) {
      this.db.exec(
        'DELETE FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?',
        id,
        serverId,
        body.user_id
      );
    }

    return Response.json({ success: true, count: ids.length });
  }

  // ==================== P2P Agent 管理 ====================

  /**
   * Agent 令牌格式：`<githubId>:<agentId>:<secret>`。
   * githubId 段让 Worker 无需全库扫描即可定位持有该 Agent 的 UserDBDO；
   * 持久层只保存令牌哈希（与分享 capability 同口径）。
   */
  private static readonly MAX_AGENTS_PER_USER = 10;
  private static readonly AGENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
  private static readonly AGENT_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

  private async sha256Base64Url(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    let binary = '';
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private createAgentSecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private handleListAgents(userId: number): Response {
    const rows = this.query<{
      id: string;
      name: string;
      created_at: number;
      last_seen_at: number | null;
      last_seen_version: string | null;
    }>(
      'SELECT id, name, created_at, last_seen_at, last_seen_version FROM agents WHERE user_id = ? ORDER BY created_at DESC',
      userId
    );
    return Response.json({ agents: rows });
  }

  private async handleCreateAgent(request: Request): Promise<Response> {
    const body = await request.json<{ user_id?: number; name?: string }>();
    const userId = Number(body.user_id);
    if (!Number.isInteger(userId)) {
      return Response.json({ error: 'Missing user_id' }, { status: 400 });
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
    if (!name) {
      return Response.json({ error: 'Invalid agent name' }, { status: 400 });
    }
    const count = this.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM agents WHERE user_id = ?',
      userId
    );
    if ((count?.count ?? 0) >= UserDBDO.MAX_AGENTS_PER_USER) {
      return Response.json({ error: 'Agent limit reached' }, { status: 409 });
    }
    const owner = this.one<{ github_id: number }>(
      'SELECT github_id FROM users WHERE id = ?',
      userId
    );
    if (!owner) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }
    const agentId = crypto.randomUUID();
    const secret = this.createAgentSecret();
    const token = `${owner.github_id}:${agentId}:${secret}`;
    const tokenHash = await this.sha256Base64Url(token);
    this.db.exec(
      'INSERT INTO agents (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      agentId,
      userId,
      name,
      tokenHash,
      Date.now()
    );
    return Response.json(
      {
        id: agentId,
        name,
        created_at: Date.now(),
        // 令牌只在创建响应中返回一次；持久层仅存哈希。
        token,
      },
      { status: 201 }
    );
  }

  private handleGetAgent(agentId: string, userId: number): Response {
    const row = this.one<{
      id: string;
      name: string;
      created_at: number;
      last_seen_at: number | null;
      last_seen_version: string | null;
    }>(
      'SELECT id, name, created_at, last_seen_at, last_seen_version FROM agents WHERE id = ? AND user_id = ?',
      agentId,
      userId
    );
    if (!row) return Response.json({ error: 'Agent not found' }, { status: 404 });
    return Response.json(row);
  }

  private handleDeleteAgent(agentId: string, userId: number): Response {
    if (!Number.isInteger(userId)) {
      return Response.json({ error: 'Missing user_id' }, { status: 400 });
    }
    const existing = this.one<{ user_id: number }>(
      'SELECT user_id FROM agents WHERE id = ?',
      agentId
    );
    if (!existing) return Response.json({ error: 'Agent not found' }, { status: 404 });
    if (existing.user_id !== userId) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    this.db.exec('DELETE FROM agents WHERE id = ? AND user_id = ?', agentId, userId);
    return Response.json({ success: true });
  }

  /**
   * 校验 `<githubId>:<agentId>:<secret>` 令牌。
   * UserDBDO 实例名即 githubId，因此令牌到达本 DO 时 owner 归属已确定；
   * 这里只需比对 agentId 段的哈希。
   */
  private async handleValidateAgentToken(request: Request): Promise<Response> {
    const body = await request.json<{ token?: string }>();
    const token = typeof body.token === 'string' ? body.token : '';
    const parts = token.split(':');
    if (parts.length !== 3) {
      return Response.json({ error: 'Invalid agent token' }, { status: 403 });
    }
    const [, agentId, secret] = parts;
    if (
      !UserDBDO.AGENT_ID_PATTERN.test(agentId) ||
      !UserDBDO.AGENT_SECRET_PATTERN.test(secret)
    ) {
      return Response.json({ error: 'Invalid agent token' }, { status: 403 });
    }
    const row = this.one<{ user_id: number; name: string; token_hash: string }>(
      'SELECT user_id, name, token_hash FROM agents WHERE id = ?',
      agentId
    );
    if (!row || (await this.sha256Base64Url(token)) !== row.token_hash) {
      return Response.json({ error: 'Invalid agent token' }, { status: 403 });
    }
    return Response.json({ agentId, userId: row.user_id, name: row.name });
  }

  private async handleAgentHeartbeat(request: Request): Promise<Response> {
    const body = await request.json<{
      user_id?: number;
      agent_id?: string;
      version?: string;
    }>();
    const userId = Number(body.user_id);
    const agentId = typeof body.agent_id === 'string' ? body.agent_id : '';
    if (!Number.isInteger(userId) || !UserDBDO.AGENT_ID_PATTERN.test(agentId)) {
      return Response.json({ error: 'Invalid heartbeat' }, { status: 400 });
    }
    const version =
      typeof body.version === 'string' && body.version.length <= 32 ? body.version : null;
    this.db.exec(
      'UPDATE agents SET last_seen_at = ?, last_seen_version = ? WHERE id = ? AND user_id = ?',
      Date.now(),
      version,
      agentId,
      userId
    );
    return Response.json({ success: true });
  }
}
