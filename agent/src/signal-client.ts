import WebSocket from 'ws';
import { parseToAgentSignal, type ToAgentMessage } from '../../src/p2p-signaling';
import type { AgentConfig } from './config';
import type { Logger } from './log';

const AGENT_VERSION = '0.1.0';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Agent ↔ agent:* DO 的常驻信令 WS 客户端。
 * - Bearer Token 认证；
 * - 指数退避自动重连（1s→30s 上限，±20% 抖动）；
 * - ping 由边缘自动应答不唤醒 DO；heartbeat 驱动 last_seen 粗粒度写库。
 */
export class SignalClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly log: Logger,
    private readonly onMessage: (msg: ToAgentMessage) => Promise<void>
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  /** 发送信令消息；WS 断开时丢弃（DO 侧 15s 超时兜底触发前端回退）。 */
  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.log.debug(`signal send failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.log.info(`connecting to ${this.config.signalUrl}`);
    const ws = new WebSocket(this.config.signalUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.log.info('signaling channel established');
      ws.send(
        JSON.stringify({ type: 'hello', agentId: this.config.agentId, version: AGENT_VERSION })
      );
      this.startTimers();
    });

    ws.on('message', (data) => {
      void this.handleMessage(data);
    });

    ws.on('close', (code, reason) => {
      this.log.warn(`signaling closed (${code} ${reason.toString()})`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log.debug(`signaling error: ${err.message}`);
      // close 事件随后触发重连
    });
  }

  private async handleMessage(data: WebSocket.RawData): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return;
    }
    const msg = parseToAgentSignal(raw);
    if (!msg) return;
    if (msg.type === 'pong') return;
    try {
      await this.onMessage(msg);
    } catch (e) {
      this.log.debug(`message handler error: ${e instanceof Error ? e.message : e}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.ws = null;
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** this.reconnectAttempts
    );
    this.reconnectAttempts += 1;
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    this.log.info(`reconnecting in ${Math.round(jitter / 1000)}s`);
    this.reconnectTimer = setTimeout(() => this.connect(), jitter);
  }

  private startTimers(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, this.config.pingIntervalMs);
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', version: AGENT_VERSION });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
