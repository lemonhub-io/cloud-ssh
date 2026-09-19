import {
  CHANNEL_CLOSED,
  CHANNEL_OPEN,
  type SessionChannel,
} from '../../src/session-channel';

/**
 * werift RTCDataChannel 的最小结构契约（避免与包类型耦合，方便测试替身）。
 * werift 的 RTCDataChannel 原生满足该形状。
 */
export interface DataChannelLike {
  readonly readyState: string;
  /** werift RTCDataChannel.send 契约：Buffer 或 string（不接受裸 Uint8Array）。 */
  send(data: string | Buffer): void;
  close(): void;
}

/**
 * RTCDataChannel → SessionChannel 适配器。
 * 只实现 SSHSession 消费的三个成员；DC 生命周期由 session-runner 订阅
 * onMessage/stateChanged 另行处理。
 */
export class DataChannelSessionChannel implements SessionChannel {
  constructor(private readonly dc: DataChannelLike) {}

  get readyState(): number {
    return this.dc.readyState === 'open' ? CHANNEL_OPEN : CHANNEL_CLOSED;
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (this.dc.readyState !== 'open') return;
    if (typeof data === 'string') {
      this.dc.send(data);
    } else if (data instanceof Uint8Array) {
      this.dc.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    } else {
      this.dc.send(Buffer.from(data));
    }
  }

  close(_code?: number, _reason?: string): void {
    try {
      this.dc.close();
    } catch {
      /* already closed */
    }
  }
}
