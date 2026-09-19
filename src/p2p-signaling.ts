import type { SSHConnectionConfig } from './types';

/**
 * P2P 信令协议（p2pProto = 1）。
 *
 * 拓扑：
 *   浏览器 ⇄ WS ⇄ session:* DO ⇄（DO→DO stub fetch /internal/deliver）⇄ agent:* DO ⇄ WS ⇄ Agent
 *
 * 浏览器侧信令消息经由 session DO 转发到 agent DO；Agent 侧消息经其常驻
 * 信令 WS 到达 agent DO，再按 `session` 字段路由回对应的 session DO。
 */

export const P2P_PROTO_VERSION = 1;

/** sessionName 长度上限（生成格式为 `session:<ts>:<uuid>` / `share-session:<uuid>`）。 */
const MAX_SESSION_NAME_LEN = 128;
const MAX_SDP_LEN = 64 * 1024;
const MAX_CANDIDATE_LEN = 4 * 1024;
const MAX_MESSAGE_LEN = 96 * 1024;
const MAX_AGENT_NAME_LEN = 64;

export interface RTCIceServerSpec {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ---------- 浏览器 → session DO ----------

export interface SignalRtcOffer {
  type: 'rtc_offer';
  sdp: string;
}

export interface SignalRtcIce {
  type: 'rtc_ice';
  candidate: string;
}

export interface SignalRtcReady {
  type: 'rtc_ready';
}

export interface SignalRtcFailed {
  type: 'rtc_failed';
  reason?: string;
}

export type BrowserSignalMessage = SignalRtcOffer | SignalRtcIce | SignalRtcReady | SignalRtcFailed;

// ---------- session DO → 浏览器 ----------

export interface SignalReadyMessage {
  type: 'signal_ready';
  session: string;
  p2pProto: number;
  iceServers: RTCIceServerSpec[];
}

export interface SignalErrorMessage {
  type: 'signal_error';
  message: string;
}

// ---------- DO ↔ Agent（经 agent:* DO 的常驻 WS） ----------

export interface AgentSessionInit {
  type: 'session_init';
  session: string;
  p2pProto: number;
  config: SSHConnectionConfig;
  iceServers: RTCIceServerSpec[];
}

export interface AgentSessionResume {
  type: 'session_resume';
  session: string;
  resumeToken: string;
  cols?: number;
  rows?: number;
  didNonce?: string;
  didTs?: number;
  didSig?: string;
  /** 恢复轮新签发的 ICE 配置（旧 TURN 凭据可能已过期）。 */
  iceServers?: RTCIceServerSpec[];
}

export interface AgentRtcOffer {
  type: 'rtc_offer';
  session: string;
  sdp: string;
}

export interface AgentRtcIce {
  type: 'rtc_ice';
  session: string;
  candidate: string;
}

export interface AgentRtcAbort {
  type: 'rtc_abort';
  session: string;
}

export interface AgentSessionClose {
  type: 'session_close';
  session: string;
  reason?: string;
}

export type ToAgentMessage =
  | AgentSessionInit
  | AgentSessionResume
  | AgentRtcOffer
  | AgentRtcIce
  | AgentRtcAbort
  | AgentSessionClose
  | { type: 'pong' };

// ---------- Agent → DO ----------

export interface AgentHello {
  type: 'hello';
  agentId: string;
  version: string;
  name?: string;
}

export interface AgentRtcAnswer {
  type: 'rtc_answer';
  session: string;
  sdp: string;
}

export interface AgentRtcReady {
  type: 'rtc_ready';
  session: string;
}

export interface AgentRtcFailed {
  type: 'rtc_failed';
  session: string;
  reason?: string;
}

export interface AgentSessionError {
  type: 'session_error';
  session: string;
  message: string;
}

/** Agent 会话终结通知（正常/异常关闭后上报），session DO 据此清理信令存档。 */
export interface AgentSessionEnded {
  type: 'session_ended';
  session: string;
}

export interface AgentHeartbeat {
  type: 'heartbeat';
  version?: string;
}

export interface AgentPing {
  type: 'ping';
}

export type FromAgentMessage =
  | AgentHello
  | AgentRtcAnswer
  | AgentRtcIce
  | AgentRtcReady
  | AgentRtcFailed
  | AgentSessionError
  | AgentSessionEnded
  | AgentHeartbeat
  | AgentPing;

// ---------- 校验 ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isValidSessionName(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_SESSION_NAME_LEN &&
    /^[A-Za-z0-9:_-]+$/.test(v)
  );
}

function isValidSdp(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP_LEN;
}

function isValidCandidate(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_CANDIDATE_LEN;
}

function isValidResumeToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9]{32,128}$/.test(v);
}

/** Agent ID 为创建时生成的 UUID（UserDBDO agents.id）。 */
export function isValidAgentId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)
  );
}

/** 解析浏览器信令消息；非法输入返回 null。 */
export function parseBrowserSignal(raw: unknown): BrowserSignalMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'rtc_offer': {
      if (!isValidSdp(raw.sdp)) return null;
      return { type: 'rtc_offer', sdp: raw.sdp };
    }
    case 'rtc_ice':
      return isValidCandidate(raw.candidate)
        ? { type: 'rtc_ice', candidate: raw.candidate }
        : null;
    case 'rtc_ready':
      return { type: 'rtc_ready' };
    case 'rtc_failed':
      return {
        type: 'rtc_failed',
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 256) : undefined,
      };
    default:
      return null;
  }
}

/** 解析 Agent 上行的信令消息；非法输入返回 null。 */
export function parseAgentSignal(raw: unknown): FromAgentMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'hello':
      if (typeof raw.agentId !== 'string' || raw.agentId.length === 0) return null;
      if (typeof raw.version !== 'string' || raw.version.length > 32) return null;
      return {
        type: 'hello',
        agentId: raw.agentId,
        version: raw.version,
        name:
          typeof raw.name === 'string' && raw.name.length <= MAX_AGENT_NAME_LEN
            ? raw.name
            : undefined,
      };
    case 'rtc_answer':
      return isValidSessionName(raw.session) && isValidSdp(raw.sdp)
        ? { type: 'rtc_answer', session: raw.session, sdp: raw.sdp }
        : null;
    case 'rtc_ice':
      return isValidSessionName(raw.session) && isValidCandidate(raw.candidate)
        ? { type: 'rtc_ice', session: raw.session, candidate: raw.candidate }
        : null;
    case 'rtc_ready':
      return isValidSessionName(raw.session)
        ? { type: 'rtc_ready', session: raw.session }
        : null;
    case 'rtc_failed':
      return isValidSessionName(raw.session)
        ? {
            type: 'rtc_failed',
            session: raw.session,
            reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 256) : undefined,
          }
        : null;
    case 'session_error':
      return isValidSessionName(raw.session) && typeof raw.message === 'string'
        ? { type: 'session_error', session: raw.session, message: raw.message.slice(0, 1024) }
        : null;
    case 'session_ended':
      return isValidSessionName(raw.session)
        ? { type: 'session_ended', session: raw.session }
        : null;
    case 'heartbeat':
      return {
        type: 'heartbeat',
        version:
          typeof raw.version === 'string' && raw.version.length <= 32 ? raw.version : undefined,
      };
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

/** 解析投递到 Agent 的信令消息（DO→Agent 方向）。 */
export function parseToAgentSignal(raw: unknown): ToAgentMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'session_init':
      if (!isValidSessionName(raw.session) || !isRecord(raw.config)) return null;
      return {
        type: 'session_init',
        session: raw.session,
        p2pProto: Number(raw.p2pProto) || P2P_PROTO_VERSION,
        config: raw.config as unknown as SSHConnectionConfig,
        iceServers: parseIceServers(raw.iceServers),
      };
    case 'session_resume':
      if (!isValidSessionName(raw.session) || !isValidResumeToken(raw.resumeToken)) return null;
      return {
        type: 'session_resume',
        session: raw.session,
        resumeToken: raw.resumeToken,
        cols: Number.isInteger(raw.cols) ? (raw.cols as number) : undefined,
        rows: Number.isInteger(raw.rows) ? (raw.rows as number) : undefined,
        didNonce:
          typeof raw.didNonce === 'string' && /^[A-Za-z0-9]{16,128}$/.test(raw.didNonce)
            ? raw.didNonce
            : undefined,
        didTs:
          typeof raw.didTs === 'number' && Number.isFinite(raw.didTs) ? raw.didTs : undefined,
        didSig:
          typeof raw.didSig === 'string' && /^[A-Za-z0-9_-]{64,1024}$/.test(raw.didSig)
            ? raw.didSig
            : undefined,
        iceServers: parseIceServers(raw.iceServers),
      };
    case 'rtc_offer':
      return isValidSessionName(raw.session) && isValidSdp(raw.sdp)
        ? { type: 'rtc_offer', session: raw.session, sdp: raw.sdp }
        : null;
    case 'rtc_ice':
      return isValidSessionName(raw.session) && isValidCandidate(raw.candidate)
        ? { type: 'rtc_ice', session: raw.session, candidate: raw.candidate }
        : null;
    case 'rtc_abort':
      return isValidSessionName(raw.session) ? { type: 'rtc_abort', session: raw.session } : null;
    case 'session_close':
      return isValidSessionName(raw.session)
        ? {
            type: 'session_close',
            session: raw.session,
            reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 256) : undefined,
          }
        : null;
    case 'pong':
      return { type: 'pong' };
    default:
      return null;
  }
}

export function parseIceServers(raw: unknown): RTCIceServerSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: RTCIceServerSpec[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const urls = item.urls;
    const urlsValid =
      (typeof urls === 'string' && urls.length <= 512) ||
      (Array.isArray(urls) && urls.every((u) => typeof u === 'string' && u.length <= 512));
    if (!urlsValid) continue;
    const spec: RTCIceServerSpec = { urls: urls as string | string[] };
    if (typeof item.username === 'string' && item.username.length <= 256) {
      spec.username = item.username;
    }
    if (typeof item.credential === 'string' && item.credential.length <= 512) {
      spec.credential = item.credential;
    }
    out.push(spec);
  }
  return out;
}

/** 信令帧体积上限（防止异常 SDP 泛洪）。 */
export function isSignalSizeOk(raw: string): boolean {
  return raw.length <= MAX_MESSAGE_LEN;
}
