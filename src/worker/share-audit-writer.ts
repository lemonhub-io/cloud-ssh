import type { Env, SSHSessionPolicy } from '../types';

// 单条审计行体积：16KB 在审计可读性与写入行数/唤醒次数之间取折中；
// 每条 terminal.output 事件 = ShareDO 一次唤醒 + 一行写入，均计入计费。
export const SHARE_AUDIT_FLUSH_CHARS = 16 * 1024;
export const SHARE_AUDIT_FLUSH_MS = 1000;

/**
 * 审计投递通道抽象：默认实现走 env.SSH_SHARE DO 直连；
 * P2P 模式下由 Agent 注入 HTTP 回传实现（POST /internal/agent/audit）。
 */
export interface ShareAuditSink {
  appendEvent(
    eventType: string,
    occurredAt: number,
    details: Record<string, unknown>
  ): Promise<boolean>;
  notifyClosed(normal: boolean): Promise<void>;
}

/** DO 直连实现：与历史行为一致，通过 SSH_SHARE 绑定写入审计事件与关闭留痕。 */
export function createDOShareAuditSink(env: Env, shareRef: string): ShareAuditSink {
  return {
    async appendEvent(eventType, occurredAt, details) {
      try {
        const stub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
        const response = await stub.fetch(
          new Request('http://internal/internal/audit/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventType, occurredAt, details }),
          })
        );
        return response.ok;
      } catch {
        return false;
      }
    },
    async notifyClosed(normal) {
      try {
        const stub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
        await stub.fetch(
          new Request('http://internal/internal/session/closed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ normal }),
          })
        );
      } catch {
        /* 审计关闭通知失败不影响清理流程 */
      }
    },
  };
}

export interface ShareAuditWriterOptions {
  env?: Partial<Env>;
  /** 注入的审计通道；缺省时回退为 env.SSH_SHARE DO 直连。 */
  sink?: ShareAuditSink;
  sessionPolicy?: SSHSessionPolicy;
  waitUntil?: (promise: Promise<unknown>) => void;
  onFatalAuditFailure?: (message: string) => void;
}

export class ShareAuditWriter {
  private shareAuditWrite: Promise<boolean> = Promise.resolve(true);
  private shareAuditBuffer = '';
  private shareAuditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly auditTextDecoder = new TextDecoder();
  private started = false;
  private closed = false;
  private isFlushing: Promise<boolean> | null = null;
  private readonly sink?: ShareAuditSink;

  constructor(private readonly options: ShareAuditWriterOptions) {
    const policy = options.sessionPolicy;
    this.sink =
      options.sink ??
      (policy?.source === 'share' && options.env?.SSH_SHARE
        ? createDOShareAuditSink(options.env as Env, policy.shareRef)
        : undefined);
  }

  start(): void {
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  writeAudit(eventType: string, details: Record<string, unknown>): Promise<boolean> {
    const policy = this.options.sessionPolicy;
    if (policy?.source !== 'share' || !this.sink) return Promise.resolve(false);
    const sink = this.sink;
    const operation = this.shareAuditWrite.then(async () => {
      try {
        return await sink.appendEvent(eventType, Date.now(), details);
      } catch {
        return false;
      }
    });
    this.shareAuditWrite = operation.catch(() => false);
    return operation;
  }

  recordTerminalOutput(data: Uint8Array): void {
    if (
      !this.started ||
      this.options.sessionPolicy?.source !== 'share' ||
      data.length === 0
    ) {
      return;
    }
    this.shareAuditBuffer += this.auditTextDecoder.decode(data, { stream: true });
    if (this.shareAuditBuffer.length >= SHARE_AUDIT_FLUSH_CHARS) {
      this.runBackground(this.flushTerminalOutput());
      return;
    }
    if (!this.shareAuditFlushTimer) {
      this.shareAuditFlushTimer = setTimeout(() => {
        this.shareAuditFlushTimer = null;
        this.runBackground(this.flushTerminalOutput());
      }, SHARE_AUDIT_FLUSH_MS);
    }
  }

  async flushTerminalOutput(): Promise<boolean> {
    if (this.shareAuditFlushTimer) {
      clearTimeout(this.shareAuditFlushTimer);
      this.shareAuditFlushTimer = null;
    }
    if (this.isFlushing) {
      await this.isFlushing;
    }
    if (!this.shareAuditBuffer) {
      return this.shareAuditWrite;
    }
    const flushPromise = (async () => {
      let text = this.shareAuditBuffer;
      this.shareAuditBuffer = '';
      while (text.length > 0) {
        const chunk = text.slice(0, SHARE_AUDIT_FLUSH_CHARS);
        text = text.slice(SHARE_AUDIT_FLUSH_CHARS);
        const recorded = await this.writeAudit('terminal.output', { text: chunk });
        if (!recorded) {
          this.options.onFatalAuditFailure?.(
            '分享会话审计写入失败或已达到容量上限，连接已终止'
          );
          return false;
        }
      }
      return this.shareAuditWrite;
    })();

    this.isFlushing = flushPromise;
    try {
      return await flushPromise;
    } finally {
      if (this.isFlushing === flushPromise) {
        this.isFlushing = null;
      }
    }
  }

  notifySessionClosed(normal: boolean): void {
    const policy = this.options.sessionPolicy;
    if (policy?.source !== 'share' || !this.sink || this.closed) return;
    this.closed = true;
    const sink = this.sink;
    this.runBackground(
      this.flushTerminalOutput().finally(async () => {
        try {
          await sink.notifyClosed(normal);
        } catch {
          /* 审计关闭通知失败不影响清理流程 */
        }
      })
    );
  }

  private runBackground(promise: Promise<unknown>): void {
    const guarded = promise.catch(() => undefined);
    if (this.options.waitUntil) {
      this.options.waitUntil(guarded);
    }
  }

  dispose(): void {
    if (this.shareAuditFlushTimer) {
      clearTimeout(this.shareAuditFlushTimer);
      this.shareAuditFlushTimer = null;
    }
    this.shareAuditBuffer = '';
  }
}
