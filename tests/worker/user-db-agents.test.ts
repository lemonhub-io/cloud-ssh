import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));
vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import { UserDBDO } from '../../src/worker/user-db';

interface AgentRow {
  id: string;
  user_id: number;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  last_seen_version: string | null;
}

/** 面向 agents/users 两张表的最小 SQL 替身：按语句文本分发到内存存储。 */
class FakeSql {
  agents: AgentRow[] = [];
  users: Array<{ id: number; github_id: number }> = [{ id: 7, github_id: 424242 }];
  statements: Array<{ query: string; values: unknown[] }> = [];

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });

    if (query.includes('PRAGMA user_version')) {
      return { toArray: () => [{ user_version: 0 }] };
    }
    if (
      query.includes('CREATE TABLE') ||
      query.includes('CREATE INDEX') ||
      query.includes('PRAGMA table_info') ||
      query.startsWith('DROP TABLE') ||
      query.startsWith('ALTER TABLE')
    ) {
      if (query.includes('PRAGMA table_info(servers)')) {
        return { toArray: () => [{ name: 'region' }, { name: 'inferred_hint' }] as unknown[] };
      }
      return { toArray: () => [] };
    }

    if (query.startsWith('INSERT INTO agents')) {
      this.agents.push({
        id: values[0] as string,
        user_id: values[1] as number,
        name: values[2] as string,
        token_hash: values[3] as string,
        created_at: values[4] as number,
        last_seen_at: null,
        last_seen_version: null,
      });
      return { toArray: () => [] };
    }
    if (query.includes('COUNT(*) AS count FROM agents WHERE user_id = ?')) {
      const uid = values[0];
      return {
        toArray: () =>
          [{ count: this.agents.filter((a) => a.user_id === uid).length }] as unknown[],
      };
    }
    if (query.includes('FROM agents WHERE user_id = ? ORDER BY created_at DESC')) {
      const uid = values[0];
      return {
        toArray: () =>
          this.agents
            .filter((a) => a.user_id === uid)
            .sort((a, b) => b.created_at - a.created_at)
            .map(({ token_hash: _h, ...rest }) => rest) as unknown[],
      };
    }
    if (query.startsWith('DELETE FROM agents WHERE id = ? AND user_id = ?')) {
      const [id, uid] = values;
      this.agents = this.agents.filter((a) => !(a.id === id && a.user_id === uid));
      return { toArray: () => [] };
    }
    if (query.includes('FROM agents WHERE id = ? AND user_id = ?')) {
      const [id, uid] = values;
      return {
        toArray: () =>
          this.agents
            .filter((a) => a.id === id && a.user_id === uid)
            .map(({ token_hash: _h, ...rest }) => rest) as unknown[],
      };
    }
    if (query === 'SELECT user_id FROM agents WHERE id = ?') {
      const id = values[0];
      return {
        toArray: () =>
          this.agents.filter((a) => a.id === id).map((a) => ({ user_id: a.user_id })) as unknown[],
      };
    }
    if (query === 'SELECT user_id, name, token_hash FROM agents WHERE id = ?') {
      const id = values[0];
      return {
        toArray: () =>
          this.agents
            .filter((a) => a.id === id)
            .map((a) => ({ user_id: a.user_id, name: a.name, token_hash: a.token_hash })) as unknown[],
      };
    }
    if (query === 'SELECT github_id FROM users WHERE id = ?') {
      const id = values[0];
      return {
        toArray: () => this.users.filter((u) => u.id === id).map((u) => ({ github_id: u.github_id })) as unknown[],
      };
    }
    if (query.startsWith('UPDATE agents SET last_seen_at = ?')) {
      const [seenAt, version, id, uid] = values as [number, string | null, string, number];
      this.agents = this.agents.map((a) =>
        a.id === id && a.user_id === uid
          ? { ...a, last_seen_at: seenAt, last_seen_version: version }
          : a
      );
      return { toArray: () => [] };
    }
    return { toArray: () => [] };
  }
}

function createUserDB(sql: FakeSql): UserDBDO {
  return new UserDBDO(
    { storage: { sql } } as unknown as DurableObjectState,
    { DEBUG_MODE: 'false' } as never
  );
}

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

function json(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('UserDB agents 注册表', () => {
  beforeEach(() => inferLocationHintMock.mockReset());

  it('建表语句包含 agents 与索引', () => {
    const sql = new FakeSql();
    createUserDB(sql);
    expect(
      sql.statements.some((s) => s.query.includes('CREATE TABLE IF NOT EXISTS agents'))
    ).toBe(true);
    expect(sql.statements.some((s) => s.query.includes('idx_agents_user'))).toBe(true);
  });

  it('POST 创建 agent：返回一次性 token，持久层只存哈希', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);
    const res = await db.fetch(
      json('http://internal/internal/agents', { user_id: 7, name: 'home-box' })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; token: string };
    expect(body.name).toBe('home-box');

    const parts = body.token.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('424242');
    expect(parts[1]).toBe(body.id);
    expect(parts[2].length).toBeGreaterThanOrEqual(32);

    // 持久层只保存哈希，不能反推出明文 token
    expect(sql.agents).toHaveLength(1);
    expect(sql.agents[0].token_hash).toBeTruthy();
    expect(sql.agents[0].token_hash).not.toBe(body.token);
  });

  it('token 校验：正确 token 通过，篡改 secret / 非法格式拒绝', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);
    const created = (await (
      await db.fetch(json('http://internal/internal/agents', { user_id: 7, name: 'box' }))
    ).json()) as { id: string; token: string };

    const ok = await db.fetch(
      json('http://internal/internal/agents/validate', { token: created.token })
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { agentId: string; userId: number; name: string };
    expect(okBody).toEqual({ agentId: created.id, userId: 7, name: 'box' });

    const [gh, id, secret] = created.token.split(':');
    const badSecret = await db.fetch(
      json('http://internal/internal/agents/validate', {
        token: `${gh}:${id}:${secret.slice(0, -1)}X`,
      })
    );
    expect(badSecret.status).toBe(403);
    for (const bad of ['', 'a:b', `${gh}:${id}`, `${gh}:not-an-id:${secret}`]) {
      const r = await db.fetch(
        json('http://internal/internal/agents/validate', { token: bad })
      );
      expect(r.status).toBe(403);
    }
  });

  it('GET 列表按 user_id 隔离且不泄露 token_hash', async () => {
    const sql = new FakeSql();
    sql.agents.push(
      {
        id: '123e4567-e89b-42d3-a456-426614174001',
        user_id: 7,
        name: 'mine',
        token_hash: 'h1',
        created_at: 1,
        last_seen_at: null,
        last_seen_version: null,
      },
      {
        id: '123e4567-e89b-42d3-a456-426614174002',
        user_id: 8,
        name: 'theirs',
        token_hash: 'h2',
        created_at: 2,
        last_seen_at: null,
        last_seen_version: null,
      }
    );
    const db = createUserDB(sql);
    const res = await db.fetch(req('http://internal/internal/agents?user_id=7'));
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('mine');
    expect(body.agents[0].token_hash).toBeUndefined();
  });

  it('每用户上限 10 个', async () => {
    const sql = new FakeSql();
    for (let i = 0; i < 10; i++) {
      sql.agents.push({
        id: `123e4567-e89b-42d3-a456-4266141740${i.toString().padStart(2, '0')}`,
        user_id: 7,
        name: `a${i}`,
        token_hash: 'h',
        created_at: i,
        last_seen_at: null,
        last_seen_version: null,
      });
    }
    const db = createUserDB(sql);
    const res = await db.fetch(
      json('http://internal/internal/agents', { user_id: 7, name: 'eleventh' })
    );
    expect(res.status).toBe(409);
  });

  it('DELETE 校验归属：他人 agent 403，不存在 404', async () => {
    const sql = new FakeSql();
    sql.agents.push({
      id: '123e4567-e89b-42d3-a456-426614174001',
      user_id: 8,
      name: 'other-owner',
      token_hash: 'h',
      created_at: 1,
      last_seen_at: null,
      last_seen_version: null,
    });
    const db = createUserDB(sql);

    const forbidden = await db.fetch(
      req('http://internal/internal/agents/123e4567-e89b-42d3-a456-426614174001?user_id=7', {
        method: 'DELETE',
      })
    );
    expect(forbidden.status).toBe(403);

    const missing = await db.fetch(
      req('http://internal/internal/agents/123e4567-e89b-42d3-a456-426614179999?user_id=7', {
        method: 'DELETE',
      })
    );
    expect(missing.status).toBe(404);

    sql.agents[0].user_id = 7;
    const ok = await db.fetch(
      req('http://internal/internal/agents/123e4567-e89b-42d3-a456-426614174001?user_id=7', {
        method: 'DELETE',
      })
    );
    expect(ok.status).toBe(200);
    expect(sql.agents).toHaveLength(0);
  });

  it('heartbeat 更新 last_seen_* 并校验参数', async () => {
    const sql = new FakeSql();
    sql.agents.push({
      id: '123e4567-e89b-42d3-a456-426614174001',
      user_id: 7,
      name: 'box',
      token_hash: 'h',
      created_at: 1,
      last_seen_at: null,
      last_seen_version: null,
    });
    const db = createUserDB(sql);

    const res = await db.fetch(
      json('http://internal/internal/agents/heartbeat', {
        user_id: 7,
        agent_id: '123e4567-e89b-42d3-a456-426614174001',
        version: '0.1.0',
      })
    );
    expect(res.status).toBe(200);
    expect(sql.agents[0].last_seen_at).toBeTypeOf('number');
    expect(sql.agents[0].last_seen_version).toBe('0.1.0');

    const bad = await db.fetch(
      json('http://internal/internal/agents/heartbeat', { user_id: 7, agent_id: 'x' })
    );
    expect(bad.status).toBe(400);
  });

  it('创建参数校验：缺 user_id / 空 name / 用户不存在', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);
    expect(
      (await db.fetch(json('http://internal/internal/agents', { name: 'x' }))).status
    ).toBe(400);
    expect(
      (await db.fetch(json('http://internal/internal/agents', { user_id: 7, name: '  ' })))
        .status
    ).toBe(400);
    expect(
      (await db.fetch(json('http://internal/internal/agents', { user_id: 99, name: 'x' })))
        .status
    ).toBe(404);
  });
});
