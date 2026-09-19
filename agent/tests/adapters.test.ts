import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DataChannelSessionChannel, type DataChannelLike } from '../src/dc-channel';
import { createAgentSocket } from '../src/net-socket';
import { isHostAllowed, resolveConfig } from '../src/config';
import { CHANNEL_CLOSED, CHANNEL_OPEN } from '../../src/session-channel';

// ==================== DataChannelSessionChannel ====================

class FakeDC implements DataChannelLike {
  readyState = 'open';
  sent: Array<string | Buffer> = [];
  closed = false;
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 'closed';
  }
}

describe('DataChannelSessionChannel', () => {
  it('readyState 映射 open→1，其余→3', () => {
    const dc = new FakeDC();
    const ch = new DataChannelSessionChannel(dc);
    expect(ch.readyState).toBe(CHANNEL_OPEN);
    dc.readyState = 'connecting';
    expect(ch.readyState).toBe(CHANNEL_CLOSED);
    dc.readyState = 'closed';
    expect(ch.readyState).toBe(CHANNEL_CLOSED);
  });

  it('string 原样透传；Uint8Array/ArrayBuffer 转为 Buffer', () => {
    const dc = new FakeDC();
    const ch = new DataChannelSessionChannel(dc);
    ch.send('{"type":"ping"}');
    ch.send(new Uint8Array([1, 2, 3]));
    ch.send(new Uint8Array([9, 8]).buffer);
    expect(dc.sent[0]).toBe('{"type":"ping"}');
    expect(Buffer.isBuffer(dc.sent[1])).toBe(true);
    expect(Array.from(dc.sent[1] as Buffer)).toEqual([1, 2, 3]);
    expect(Array.from(dc.sent[2] as Buffer)).toEqual([9, 8]);
  });

  it('非 open 状态静默丢弃 send', () => {
    const dc = new FakeDC();
    dc.readyState = 'connecting';
    const ch = new DataChannelSessionChannel(dc);
    ch.send('dropped');
    expect(dc.sent).toHaveLength(0);
  });

  it('close 幂等且委托到底层 DC', () => {
    const dc = new FakeDC();
    const ch = new DataChannelSessionChannel(dc);
    ch.close(1000, 'done');
    ch.close();
    expect(dc.closed).toBe(true);
    expect(dc.readyState).toBe('closed');
  });
});

// ==================== createAgentSocket（net.Socket → web streams） ====================

describe('createAgentSocket', () => {
  let server: Server | undefined;
  let serverSocket: Socket | undefined;
  afterEach(async () => {
    serverSocket?.destroy();
    if (server?.listening) {
      server.close();
      await once(server, 'close').catch(() => undefined);
    }
    server = undefined;
    serverSocket = undefined;
  });

  function listen(handler: (sock: Socket) => void): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((sock) => {
        serverSocket = sock;
        handler(sock);
      });
      server.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
  }

  it('opened 在 TCP 连接建立后 resolve，双向透传字节', async () => {
    const port = await listen((sock) => {
      sock.on('data', (chunk) => sock.write(Buffer.concat([Buffer.from('echo:'), chunk])));
    });
    const sock = createAgentSocket('127.0.0.1', port);
    await sock.opened;

    const writer = sock.writable.getWriter();
    await writer.write(new Uint8Array([104, 105])); // "hi"

    const reader = sock.readable.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value!).toString()).toBe('echo:hi');
    writer.releaseLock();
    reader.releaseLock();
    sock.close();
  });

  it('opened 在连接拒绝时 reject', async () => {
    const sock = createAgentSocket('127.0.0.1', 1);
    await expect(sock.opened).rejects.toThrow();
    sock.close();
  });

  it('writable.write 在 socket 关闭后 reject', async () => {
    const port = await listen((sock) => sock.resume());
    const sock = createAgentSocket('127.0.0.1', port);
    await sock.opened;
    sock.close();
    const writer = sock.writable.getWriter();
    await expect(writer.write(new Uint8Array([1]))).rejects.toThrow('Socket closed');
  });

  it('远端 close 触发 readable 流关闭', async () => {
    const port = await listen((sock) => {
      sock.on('data', () => sock.end());
    });
    const sock = createAgentSocket('127.0.0.1', port);
    await sock.opened;
    const writer = sock.writable.getWriter();
    await writer.write(new Uint8Array([1]));
    const reader = sock.readable.getReader();
    await reader.read(); // 数据帧
    const tail = await reader.read();
    expect(tail.done).toBe(true);
    sock.close();
  });
});

// ==================== agent config ====================

describe('agent config', () => {
  const token = '424242:123e4567-e89b-42d3-a456-426614174000:s'.repeat(1).padEnd(43, 'x');

  it('resolveConfig 解析 token 三段并推导 signalUrl', () => {
    const cfg = resolveConfig({ server: 'https://example.com', token });
    expect(cfg.agentId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(cfg.signalUrl).toBe('wss://example.com/api/agent/ws');
    expect(cfg.origin).toBe('https://example.com');
    expect(cfg.maxSessions).toBe(8);
    expect(cfg.allowlist).toEqual([]);
  });

  it('畸形 token / 缺 token 抛 ConfigError', () => {
    expect(() => resolveConfig({ server: 'x', token: 'a:b' })).toThrow('Malformed');
    expect(() => resolveConfig({ server: 'x', token: 'a:b:' })).toThrow('Malformed');
  });

  it('allowlist/maxSessions 从 env 解析', () => {
    const cfg = resolveConfig({
      server: 'example.com',
      token,
      allowlist: 'A.example.com, *.corp.local',
      maxSessions: 4,
    });
    expect(cfg.allowlist).toEqual(['a.example.com', '*.corp.local']);
    expect(cfg.maxSessions).toBe(4);
  });

  it('isHostAllowed：空表放行全部；精确与 *. 通配', () => {
    expect(isHostAllowed([], 'anything.example.com')).toBe(true);
    expect(isHostAllowed(['a.com'], 'a.com')).toBe(true);
    expect(isHostAllowed(['a.com'], 'b.com')).toBe(false);
    expect(isHostAllowed(['*.corp.local'], 'host.corp.local')).toBe(true);
    expect(isHostAllowed(['*.corp.local'], 'corp.local')).toBe(true);
    expect(isHostAllowed(['*.corp.local'], 'other.local')).toBe(false);
    expect(isHostAllowed(['a.com'], 'a.com.')).toBe(true); // 尾点归一
  });
});
