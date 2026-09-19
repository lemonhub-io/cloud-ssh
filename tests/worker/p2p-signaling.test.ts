import { describe, expect, it } from 'vitest';
import {
  isSignalSizeOk,
  isValidAgentId,
  isValidSessionName,
  parseAgentSignal,
  parseBrowserSignal,
  parseIceServers,
  parseToAgentSignal,
  P2P_PROTO_VERSION,
} from '../../src/p2p-signaling';

describe('p2p-signaling 基础校验', () => {
  it('isValidSessionName 接受合法名、拒绝非法字符与超长', () => {
    expect(isValidSessionName('session:1:abc-def_2')).toBe(true);
    expect(isValidSessionName('share-session:uuid-1')).toBe(true);
    expect(isValidSessionName('')).toBe(false);
    expect(isValidSessionName('has space')).toBe(false);
    expect(isValidSessionName('has/slash')).toBe(false);
    expect(isValidSessionName('x'.repeat(129))).toBe(false);
    expect(isValidSessionName(42)).toBe(false);
  });

  it('isValidAgentId 仅接受 UUID 形态', () => {
    expect(isValidAgentId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isValidAgentId('not-a-uuid')).toBe(false);
    expect(isValidAgentId('123e4567-e89b-42d3-a456')).toBe(false);
    expect(isValidAgentId(null)).toBe(false);
  });

  it('isSignalSizeOk 以 96KB 为上限', () => {
    expect(isSignalSizeOk('x'.repeat(96 * 1024))).toBe(true);
    expect(isSignalSizeOk('x'.repeat(96 * 1024 + 1))).toBe(false);
  });
});

describe('parseBrowserSignal（浏览器→DO）', () => {
  it('接受 rtc_offer / rtc_ice / rtc_ready / rtc_failed', () => {
    expect(parseBrowserSignal({ type: 'rtc_offer', sdp: 'v=0...' })).toEqual({
      type: 'rtc_offer',
      sdp: 'v=0...',
    });
    expect(parseBrowserSignal({ type: 'rtc_ice', candidate: 'cand' })).toEqual({
      type: 'rtc_ice',
      candidate: 'cand',
    });
    expect(parseBrowserSignal({ type: 'rtc_ready' })).toEqual({ type: 'rtc_ready' });
    expect(parseBrowserSignal({ type: 'rtc_failed', reason: 'ice timeout' })).toEqual({
      type: 'rtc_failed',
      reason: 'ice timeout',
    });
  });

  it('拒绝缺字段/超大 SDP/未知类型', () => {
    expect(parseBrowserSignal({ type: 'rtc_offer' })).toBeNull();
    expect(parseBrowserSignal({ type: 'rtc_offer', sdp: '' })).toBeNull();
    expect(
      parseBrowserSignal({ type: 'rtc_offer', sdp: 'x'.repeat(64 * 1024 + 1) })
    ).toBeNull();
    expect(parseBrowserSignal({ type: 'rtc_ice', candidate: 7 })).toBeNull();
    expect(parseBrowserSignal({ type: 'bogus' })).toBeNull();
    expect(parseBrowserSignal('string')).toBeNull();
    expect(parseBrowserSignal(null)).toBeNull();
  });

  it('rtc_failed reason 超长截断至 256', () => {
    const msg = parseBrowserSignal({ type: 'rtc_failed', reason: 'r'.repeat(500) });
    expect(msg?.type).toBe('rtc_failed');
    expect((msg as { reason?: string }).reason).toHaveLength(256);
  });
});

describe('parseAgentSignal（Agent→DO）', () => {
  it('hello 校验 agentId/version/name', () => {
    expect(
      parseAgentSignal({ type: 'hello', agentId: 'a1', version: '1.0.0', name: 'box' })
    ).toEqual({ type: 'hello', agentId: 'a1', version: '1.0.0', name: 'box' });
    expect(parseAgentSignal({ type: 'hello', agentId: '', version: '1' })).toBeNull();
    expect(
      parseAgentSignal({ type: 'hello', agentId: 'a', version: 'v'.repeat(33) })
    ).toBeNull();
    // name 超长 → 丢弃 name 而非拒绝整条消息
    const longName = parseAgentSignal({
      type: 'hello',
      agentId: 'a',
      version: '1',
      name: 'n'.repeat(65),
    });
    expect(longName?.type).toBe('hello');
    expect((longName as { name?: string }).name).toBeUndefined();
  });

  it('会话级消息要求合法 session 名', () => {
    for (const t of ['rtc_answer', 'rtc_ice', 'rtc_ready', 'rtc_failed', 'session_error', 'session_ended']) {
      expect(parseAgentSignal({ type: t, session: 'bad name!' })).toBeNull();
    }
    expect(
      parseAgentSignal({ type: 'rtc_answer', session: 's:1:x', sdp: 'v=0' })
    ).toEqual({ type: 'rtc_answer', session: 's:1:x', sdp: 'v=0' });
    expect(
      parseAgentSignal({ type: 'session_error', session: 's:1:x', message: 'boom' })
    ).toEqual({ type: 'session_error', session: 's:1:x', message: 'boom' });
  });

  it('heartbeat / ping / session_error 边界', () => {
    expect(parseAgentSignal({ type: 'heartbeat', version: '1.0' })).toEqual({
      type: 'heartbeat',
      version: '1.0',
    });
    expect(parseAgentSignal({ type: 'heartbeat' })).toEqual({
      type: 'heartbeat',
      version: undefined,
    });
    expect(parseAgentSignal({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(parseAgentSignal({ type: 'session_error', session: 's:1:x' })).toBeNull();
    expect(parseAgentSignal({ type: 'nope' })).toBeNull();
  });
});

describe('parseToAgentSignal（DO→Agent）', () => {
  const config = { host: 'h', port: 22, username: 'u' };

  it('session_init 要求 session + config', () => {
    const msg = parseToAgentSignal({
      type: 'session_init',
      session: 'session:1:x',
      p2pProto: P2P_PROTO_VERSION,
      config,
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });
    expect(msg?.type).toBe('session_init');
    expect((msg as { config: unknown }).config).toEqual(config);
    expect(parseToAgentSignal({ type: 'session_init', session: 'session:1:x' })).toBeNull();
  });

  it('session_resume 校验 token 形态并透传 did* 字段', () => {
    const resumeToken = 'a'.repeat(43);
    const msg = parseToAgentSignal({
      type: 'session_resume',
      session: 'session:1:x',
      resumeToken,
      cols: 120,
      rows: 30,
      didNonce: 'n'.repeat(24),
      didTs: 1_700_000_000_000,
      didSig: 's'.repeat(96),
    });
    expect(msg?.type).toBe('session_resume');
    const r = msg as {
      cols?: number;
      didNonce?: string;
      didSig?: string;
    };
    expect(r.cols).toBe(120);
    expect(r.didNonce).toBe('n'.repeat(24));
    expect(r.didSig).toBe('s'.repeat(96));

    expect(
      parseToAgentSignal({ type: 'session_resume', session: 'session:1:x', resumeToken: '短' })
    ).toBeNull();
    expect(
      parseToAgentSignal({
        type: 'session_resume',
        session: 'session:1:x',
        resumeToken: 'has+invalid+chars+in+token+body+xxxxx',
      })
    ).toBeNull();
  });

  it('rtc_offer/rtc_ice/rtc_abort/session_close/pong', () => {
    expect(
      parseToAgentSignal({ type: 'rtc_offer', session: 's:1:x', sdp: 'v=0' })
    ).toEqual({ type: 'rtc_offer', session: 's:1:x', sdp: 'v=0' });
    expect(parseToAgentSignal({ type: 'rtc_abort', session: 's:1:x' })).toEqual({
      type: 'rtc_abort',
      session: 's:1:x',
    });
    expect(parseToAgentSignal({ type: 'session_close', session: 's:1:x' })).toEqual({
      type: 'session_close',
      session: 's:1:x',
      reason: undefined,
    });
    expect(parseToAgentSignal({ type: 'pong' })).toEqual({ type: 'pong' });
    expect(parseToAgentSignal({ type: 'rtc_offer', session: 'bad!', sdp: 'v' })).toBeNull();
  });
});

describe('parseIceServers', () => {
  it('透传合法条目、丢弃畸形项', () => {
    const out = parseIceServers([
      { urls: 'stun:s.example:3478' },
      { urls: ['turn:t.example:443'], username: 'u', credential: 'c' },
      { urls: 5 },
      'junk',
      { urls: 'x'.repeat(513) },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].username).toBe('u');
    expect(parseIceServers('not-array')).toEqual([]);
    expect(parseIceServers(undefined)).toEqual([]);
  });
});
