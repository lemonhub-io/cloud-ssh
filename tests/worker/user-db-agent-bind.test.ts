import { describe, expect, it, vi } from 'vitest';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));
vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import { UserDBDO } from '../../src/worker/user-db';

interface ServerRow {
  id: number;
  user_id: number;
  agent_id: string | null;
  agent_loopback: number;
}

/** servers + agents 两张表的最小替身：覆盖绑定路由的所有 SQL 分支。 */
class FakeSql {
  servers: ServerRow[] = [];
  agents: Array<{ id: string; user_id: number }> = [];
  statements: Array<{ query: string; values: unknown[] }> = [];

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });

    if (query.includes('PRAGMA user_version')) {
      return { toArray: () => [{ user_version: 0 }] };
    }
    if (query.includes('PRAGMA table_info(servers)')) {
      return { toArray: () => [{ name: 'region' }, { name: 'inferred_hint' }] as unknown[] };
    }
    if (
      query.includes('CREATE TABLE') ||
      query.includes('CREATE INDEX') ||
      query.startsWith('ALTER TABLE') ||
      query.startsWith('DROP TABLE')
    ) {
      return { toArray: () => [] };
    }

    if (query === 'SELECT user_id FROM servers WHERE id = ?') {
      const id = values[0];
      return {
        toArray: () =>
          this.servers.filter((s) => s.id === id).map((s) => ({ user_id: s.user_id })) as unknown[],
      };
    }
    if (query === 'SELECT user_id FROM agents WHERE id = ?') {
      const id = values[0];
      return {
        toArray: () =>
          this.agents.filter((a) => a.id === id).map((a) => ({ user_id: a.user_id })) as unknown[],
      };
    }
    if (query.startsWith('UPDATE servers SET agent_id')) {
      const [agentId, loopback, id] = values as [string | null, number, number];
      const row = this.servers.find((s) => s.id === id);
      if (row) {
        row.agent_id = agentId;
        row.agent_loopback = loopback;
      }
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

function bind(serverId: number, body: unknown): Request {
  return new Request(`http://internal/internal/servers/${serverId}/agent`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('UserDB 服务器 Agent 绑定路由', () => {
  it('绑定：归属校验通过 → 写入 agent_id 与 loopback', async () => {
    const sql = new FakeSql();
    sql.servers.push({ id: 5, user_id: 7, agent_id: null, agent_loopback: 0 });
    sql.agents.push({ id: 'agent-1', user_id: 7 });
    const db = createUserDB(sql);

    const res = await db.fetch(
      bind(5, { user_id: 7, agent_id: 'agent-1', agent_loopback: true })
    );
    expect(res.status).toBe(200);
    expect(sql.servers[0].agent_id).toBe('agent-1');
    expect(sql.servers[0].agent_loopback).toBe(1);
  });

  it('解绑：agent_id=null → 清空绑定且 loopback 归零', async () => {
    const sql = new FakeSql();
    sql.servers.push({ id: 5, user_id: 7, agent_id: 'agent-1', agent_loopback: 1 });
    const db = createUserDB(sql);

    const res = await db.fetch(bind(5, { user_id: 7, agent_id: null, agent_loopback: true }));
    expect(res.status).toBe(200);
    expect(sql.servers[0].agent_id).toBeNull();
    // loopback 只在绑定时才有意义，解绑必须归零
    expect(sql.servers[0].agent_loopback).toBe(0);
  });

  it('归属校验：他人的服务器 403，不存在的服务器 404', async () => {
    const sql = new FakeSql();
    sql.servers.push({ id: 5, user_id: 8, agent_id: null, agent_loopback: 0 });
    const db = createUserDB(sql);

    expect(
      (await db.fetch(bind(5, { user_id: 7, agent_id: null }))).status
    ).toBe(403);
    expect(
      (await db.fetch(bind(99, { user_id: 7, agent_id: null }))).status
    ).toBe(404);
  });

  it('Agent 归属校验：绑定他人的 Agent → 404', async () => {
    const sql = new FakeSql();
    sql.servers.push({ id: 5, user_id: 7, agent_id: null, agent_loopback: 0 });
    sql.agents.push({ id: 'agent-theirs', user_id: 8 });
    const db = createUserDB(sql);

    const res = await db.fetch(
      bind(5, { user_id: 7, agent_id: 'agent-theirs', agent_loopback: true })
    );
    expect(res.status).toBe(404);
    expect(sql.servers[0].agent_id).toBeNull();
  });

  it('绑定不存在的 Agent → 404', async () => {
    const sql = new FakeSql();
    sql.servers.push({ id: 5, user_id: 7, agent_id: null, agent_loopback: 0 });
    const db = createUserDB(sql);

    const res = await db.fetch(
      bind(5, { user_id: 7, agent_id: 'ghost', agent_loopback: false })
    );
    expect(res.status).toBe(404);
  });

  it('loopback 仅在绑定时生效：未传 loopback 绑定时为 0', async () => {
    const sql = new FakeSql();
    sql.servers.push({ id: 5, user_id: 7, agent_id: null, agent_loopback: 0 });
    sql.agents.push({ id: 'agent-1', user_id: 7 });
    const db = createUserDB(sql);

    const res = await db.fetch(bind(5, { user_id: 7, agent_id: 'agent-1' }));
    expect(res.status).toBe(200);
    expect(sql.servers[0].agent_id).toBe('agent-1');
    expect(sql.servers[0].agent_loopback).toBe(0);
  });

  it('schema v3：fresh 建表与迁移路径都带 agent 列', () => {
    const sql = new FakeSql();
    createUserDB(sql);
    const ddl = sql.statements.map((s) => s.query).join('\n');
    expect(ddl).toContain('agent_id');
    expect(ddl).toContain('agent_loopback');
  });
});
