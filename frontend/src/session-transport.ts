/**
 * 浏览器会话传输抽象。
 *
 * 直连模式下传输是 WebSocket；P2P 模式下是承载同一 JSON/二进制协议的
 * RTCDataChannel（'ssh' 标签）。两者在本接口下结构等价，
 * terminal.ts / sftp-panel.ts 只依赖该形状。
 */
export interface SessionTransportLike {
  /** 发送 JSON 控制帧或二进制终端帧（等同 WebSocket.send 的取值域）。 */
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  /** 关闭通道；code/reason 沿用 WebSocket 关闭码语义。 */
  close(code?: number, reason?: string): void;
  /** WebSocket.readyState 四态（CONNECTING=0/OPEN=1/CLOSING=2/CLOSED=3）。 */
  readonly readyState: number;
  /** 与 WebSocket.binaryType 语义一致；实现可忽略赋值。 */
  binaryType: string;
  /**
   * 处理器取宽松签名以兼容 DOM WebSocket 赋值；投递的事件对 onmessage 是
   * { data }（字符串或 ArrayBuffer），对 onclose 是 { code, reason, wasClean }。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((ev: any) => any) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: any) => any) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onclose: ((ev: any) => any) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => any) | null;
}

/** 关闭事件的最小结构面：CloseEvent 与 RTC 通道关闭映射共用。 */
export interface SessionCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export const RTC_SFTP_SCHEME = 'rtc+sftp://';

/** 信令面消息类型集合：首帧不属于此集合时，服务端已透明回退为中继会话。 */
const SIGNAL_MESSAGE_TYPES = new Set([
  'signal_ready',
  'rtc_offer',
  'rtc_answer',
  'rtc_ice',
  'rtc_ready',
  'rtc_failed',
  'rtc_abort',
  'signal_error',
  'session_error',
  'session_ended',
  'pong',
]);

const SIGNAL_TIMEOUT_MS = 15_000;
const RTC_OPEN_TIMEOUT_MS = 15_000;

/**
 * WebRTC DataChannel 传输：内部完成一次完整信令往返后对外暴露
 * 已打开的 'ssh' DataChannel 作为 WebSocket 等价面。
 *
 * 生命周期：
 *   connect(signalUrl)
 *     → 打开信令 WS（/api/ssh?...&mode=p2p）
 *     → 收 signal_ready（含本轮 iceServers）
 *     → RTCPeerConnection + createDataChannel('ssh') + offer/answer/ICE
 *     → DC open 后 resolve；同时发送 rtc_ready 通知 DO 释放信令 WS
 */
export class RtcTransport implements SessionTransportLike {
  binaryType = 'arraybuffer';
  onopen: SessionTransportLike['onopen'] = null;
  onmessage: SessionTransportLike['onmessage'] = null;
  onclose: SessionTransportLike['onclose'] = null;
  onerror: SessionTransportLike['onerror'] = null;

  private closed = false;
  private readonly signalWs: WebSocket;
  private readonly pc: RTCPeerConnection;
  private readonly dc: RTCDataChannel;

  private constructor(signalWs: WebSocket, pc: RTCPeerConnection, dc: RTCDataChannel) {
    this.signalWs = signalWs;
    this.pc = pc;
    this.dc = dc;
    this.wire();
  }

  get readyState(): number {
    if (this.closed) return WebSocket.CLOSED;
    switch (this.dc.readyState) {
      case 'open':
        return WebSocket.OPEN;
      case 'connecting':
        return WebSocket.CONNECTING;
      case 'closing':
        return WebSocket.CLOSING;
      default:
        return WebSocket.CLOSED;
    }
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.dc.readyState !== 'open') return;
    if (typeof data === 'string') {
      this.dc.send(data);
    } else if (ArrayBuffer.isView(data)) {
      this.dc.send(data);
    } else {
      this.dc.send(data as ArrayBuffer);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dc.close();
    } catch {
      /* already closed */
    }
    this.teardown(code ?? 1000, reason ?? '', true);
  }

  /** 打开会话内的 'sftp' DataChannel（等价于中继模式的第二条 SFTP WS）。 */
  openSFTPChannel(): Promise<SessionTransportLike> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.pc.connectionState === 'closed') {
        reject(new Error('P2P connection closed'));
        return;
      }
      let settled = false;
      const dc = this.pc.createDataChannel('sftp', { ordered: true });
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          dc.close();
        } catch {
          /* ignore */
        }
        reject(new Error('SFTP channel open timeout'));
      }, RTC_OPEN_TIMEOUT_MS);

      const transport = new DataChannelTransport(dc);
      dc.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(transport);
      };
      dc.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('SFTP channel failed'));
      };
    });
  }

  private wire(): void {
    this.dc.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      // DC 关闭无码语义：映射为 1006 异常关闭，驱动既有断线恢复管线
      this.teardown(1006, 'RTC channel closed', false);
    };
    this.dc.onerror = () => {
      this.onerror?.({ type: 'error' });
    };
    this.dc.onmessage = (event) => {
      this.onmessage?.({ data: event.data });
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        if (this.closed) return;
        this.closed = true;
        this.teardown(1006, `RTC ${state}`, false);
      }
    };
  }

  private teardown(code: number, reason: string, wasClean: boolean): void {
    try {
      this.signalWs.close(1000);
    } catch {
      /* ignore */
    }
    try {
      void this.pc.close();
    } catch {
      /* ignore */
    }
    this.onclose?.({ code, reason, wasClean });
  }

  /**
   * 执行一次完整 P2P 信令并返回已就绪的传输。
   * signalWsUrl 由调用方按现有规则构造（token/share/resume 参数 + mode=p2p）。
   *
   * 服务端可在升级前透明回退为中继会话（分享票据已消费时，Agent 离线仍须
   * 能建立会话）：首个非信令帧到达即把信令 WS 收养为普通中继传输。
   */
  static connect(signalWsUrl: string): Promise<SessionTransportLike> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let pc: RTCPeerConnection | null = null;
      let sshDc: RTCDataChannel | null = null;
      const pendingIce: string[] = [];
      let remoteDescSet = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          signalWs.close();
        } catch {
          /* ignore */
        }
        try {
          sshDc?.close();
        } catch {
          /* ignore */
        }
        try {
          void pc?.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      // 服务端未进入信令模式（透明中继回退）：把同一 WS 收养为会话传输，
      // 已到达的帧经缓冲回放，保证不丢失首个 status/session_created 消息。
      const adopt = (firstFrame: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          void pc?.close();
        } catch {
          /* ignore */
        }
        resolve(new AdoptedRelayTransport(signalWs, firstFrame));
      };

      const timeout = setTimeout(() => {
        fail(new Error('P2P signaling timeout'));
      }, SIGNAL_TIMEOUT_MS);

      const signalWs = new WebSocket(signalWsUrl);
      signalWs.binaryType = 'arraybuffer';
      signalWs.onerror = () => fail(new Error('Signaling channel failed'));
      signalWs.onclose = (ev) => {
        if (!settled) fail(new Error(`Signaling closed (${ev.code})`));
      };

      signalWs.onmessage = async (event) => {
        if (settled) return;
        if (typeof event.data !== 'string') {
          adopt(event.data);
          return;
        }
        let msg: { type?: string } & Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          // 非 JSON 帧在中继模式是终端输出：收养并回放
          adopt(event.data);
          return;
        }
        if (typeof msg.type !== 'string' || !SIGNAL_MESSAGE_TYPES.has(msg.type)) {
          adopt(event.data);
          return;
        }

        try {
          switch (msg.type) {
            case 'signal_ready': {
              pc = new RTCPeerConnection({
                iceServers: Array.isArray(msg.iceServers) ? msg.iceServers : [],
              });
              pc.onicecandidate = (e) => {
                if (e.candidate?.candidate && signalWs.readyState === WebSocket.OPEN) {
                  signalWs.send(
                    JSON.stringify({ type: 'rtc_ice', candidate: e.candidate.candidate })
                  );
                }
              };
              pc.onconnectionstatechange = () => {
                if (pc && pc.connectionState === 'failed') {
                  fail(new Error('ICE connection failed'));
                }
              };
              sshDc = pc.createDataChannel('ssh', { ordered: true });
              sshDc.onopen = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                // 通知 DO 信令使命完成，可释放信令 WS 进入空闲
                try {
                  signalWs.send(JSON.stringify({ type: 'rtc_ready' }));
                } catch {
                  /* ignore */
                }
                resolve(new RtcTransport(signalWs, pc!, sshDc!));
              };
              sshDc.onerror = () => fail(new Error('DataChannel failed'));
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              signalWs.send(
                JSON.stringify({ type: 'rtc_offer', sdp: pc.localDescription?.sdp ?? '' })
              );
              return;
            }
            case 'rtc_answer': {
              if (!pc || typeof msg.sdp !== 'string') return;
              await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
              remoteDescSet = true;
              for (const candidate of pendingIce.splice(0)) {
                void pc.addIceCandidate({ candidate });
              }
              return;
            }
            case 'rtc_ice': {
              if (!pc || typeof msg.candidate !== 'string') return;
              if (remoteDescSet) {
                void pc.addIceCandidate({ candidate: msg.candidate });
              } else {
                pendingIce.push(msg.candidate);
              }
              return;
            }
            case 'rtc_ready':
              // Agent 侧就绪确认：无需动作（本端以自身 DC open 为准）
              return;
            case 'rtc_failed':
            case 'rtc_abort':
            case 'signal_error':
            case 'session_error':
              fail(
                new Error(
                  typeof msg.message === 'string' ? msg.message : 'P2P signaling failed'
                )
              );
              return;
          }
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
        }
      };
    });
  }
}

/**
 * 裸 RTCDataChannel 的传输包装（用于会话内第二条 'sftp' 通道）。
 * 生命周期事件直接透传；关闭映射 1006 异常码。
 */
class DataChannelTransport implements SessionTransportLike {
  binaryType = 'arraybuffer';
  onopen: SessionTransportLike['onopen'] = null;
  onmessage: SessionTransportLike['onmessage'] = null;
  onclose: SessionTransportLike['onclose'] = null;
  onerror: SessionTransportLike['onerror'] = null;
  private closed = false;

  constructor(private readonly dc: RTCDataChannel) {
    dc.onmessage = (event) => this.onmessage?.({ data: event.data });
    dc.onerror = (ev) => this.onerror?.(ev);
    dc.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.({ code: 1006, reason: 'RTC channel closed', wasClean: false });
    };
    dc.onopen = () => this.onopen?.({});
  }

  get readyState(): number {
    if (this.closed) return WebSocket.CLOSED;
    switch (this.dc.readyState) {
      case 'open':
        return WebSocket.OPEN;
      case 'connecting':
        return WebSocket.CONNECTING;
      case 'closing':
        return WebSocket.CLOSING;
      default:
        return WebSocket.CLOSED;
    }
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.dc.readyState !== 'open') return;
    if (typeof data === 'string') {
      this.dc.send(data);
    } else if (ArrayBuffer.isView(data)) {
      this.dc.send(data);
    } else {
      this.dc.send(data as ArrayBuffer);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dc.close();
    } catch {
      /* ignore */
    }
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
  }
}

/**
 * 透明中继收养的传输包装。
 *
 * 场景：浏览器以 mode=p2p 打开 WS，但服务端把升级请求落成了普通中继会话
 * （分享票据一次性消费后 Agent 离线仍需可用）。此时信令 WS 即会话 WS，
 * 本类将首个非信令帧与后续 DOM 消息统一转交 SessionTransportLike 接口。
 */
class AdoptedRelayTransport implements SessionTransportLike {
  binaryType = 'arraybuffer';
  onopen: SessionTransportLike['onopen'] = null;
  onclose: SessionTransportLike['onclose'] = null;
  onerror: SessionTransportLike['onerror'] = null;
  private buffered: unknown[];
  private closed = false;
  private _onmessage: SessionTransportLike['onmessage'] = null;

  constructor(
    private readonly ws: WebSocket,
    firstFrame: unknown
  ) {
    this.buffered = [firstFrame];
    ws.onmessage = (event) => {
      if (this._onmessage) {
        this._onmessage({ data: event.data });
      } else {
        this.buffered.push(event.data);
      }
    };
    ws.onclose = (event) => {
      this.closed = true;
      this.onclose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    };
    ws.onerror = (event) => this.onerror?.(event);
  }

  get onmessage(): SessionTransportLike['onmessage'] {
    return this._onmessage;
  }

  set onmessage(fn: SessionTransportLike['onmessage']) {
    this._onmessage = fn;
    if (fn) {
      for (const frame of this.buffered.splice(0)) {
        fn({ data: frame });
      }
    }
  }

  get readyState(): number {
    if (this.closed) return WebSocket.CLOSED;
    return this.ws.readyState;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.ws.send(data as string | ArrayBuffer | ArrayBufferView);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close(code, reason);
  }
}

/** 判断会话 URL 是否为 P2P 信令地址（供上层在调用前做能力/回退判定）。 */
export function isP2PUrl(wsUrl: string): boolean {
  try {
    return new URL(wsUrl).searchParams.get('mode') === 'p2p';
  } catch {
    return wsUrl.includes('mode=p2p');
  }
}

/** 给既有会话 URL 追加 P2P 信令参数；agentId 为空时由服务端挑选在线 Agent。 */
export function appendP2PParams(wsUrl: string, agentId?: string | null): string {
  const url = new URL(wsUrl);
  url.searchParams.set('mode', 'p2p');
  if (agentId) url.searchParams.set('agent_id', agentId);
  return url.toString();
}

function openPlainWebSocket(wsUrl: string): WebSocket {
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  return socket;
}

/**
 * 打开会话传输：mode=p2p 地址先走 RTC 信令（含服务端透明中继收养）；
 * 信令失败时经 refetch 重新获取一次性连接 URL 回退中继——token/share ticket
 * 在首次升级时即被消费，同一 URL 不可重试。
 */
export async function openSessionChannel(
  wsUrl: string,
  refetch?: () => Promise<string>
): Promise<SessionTransportLike> {
  if (!isP2PUrl(wsUrl)) {
    return openPlainWebSocket(wsUrl);
  }
  try {
    return await RtcTransport.connect(wsUrl);
  } catch (e) {
    if (!refetch) throw e;
    return openPlainWebSocket(await refetch());
  }
}
