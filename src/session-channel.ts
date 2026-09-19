/**
 * 浏览器 ↔ SSH 会话的会话通道抽象。
 *
 * 直连模式下该通道是 Cloudflare WebSocket；P2P 模式下它是 Agent 进程内的
 * RTCDataChannel。SSHSession 只依赖 send/close/readyState 三个成员，
 * 因此本接口对两侧实现结构等价（WebSocket 原生满足该形状）。
 */
export const CHANNEL_CONNECTING = 0;
export const CHANNEL_OPEN = 1;
export const CHANNEL_CLOSING = 2;
export const CHANNEL_CLOSED = 3;

export interface SessionChannel {
  /** 发送 JSON 控制帧（string）或二进制终端帧（Uint8Array/ArrayBuffer）。 */
  send(data: string | Uint8Array | ArrayBuffer): void;
  /** 关闭通道；code 沿用 WebSocket 关闭码语义（1000 正常 / 1011 异常）。 */
  close(code?: number, reason?: string): void;
  /** 与 WebSocket.readyState 相同的四态取值（见 CHANNEL_* 常量）。 */
  readonly readyState: number;
}
