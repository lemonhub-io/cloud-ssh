import type { ShareAuditSink } from '../../src/worker/share-audit-writer';
import type { AgentConfig } from './config';
import type { Logger } from './log';

/**
 * Agent → Worker 的 HTTP 回传通道（ShareAuditSink + OS 持久化）。
 * 每个请求都带 Bearer Token；shareRef 定位 ShareDO。
 */

export function createHttpAuditSink(
  config: AgentConfig,
  shareRef: string,
  log: Logger
): ShareAuditSink {
  return {
    async appendEvent(eventType, occurredAt, details) {
      try {
        const res = await fetch(`${config.origin}/internal/agent/audit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({ shareRef, eventType, occurredAt, details }),
        });
        return res.ok;
      } catch (e) {
        log.debug(`audit appendEvent failed: ${errMsg(e)}`);
        return false;
      }
    },
    async notifyClosed(normal) {
      try {
        await fetch(`${config.origin}/internal/agent/audit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({ shareRef, closed: normal }),
        });
      } catch (e) {
        log.debug(`audit notifyClosed failed: ${errMsg(e)}`);
      }
    },
  };
}

export function createOsPersist(config: AgentConfig, serverId: number, log: Logger) {
  return async (os: string): Promise<void> => {
    const res = await fetch(`${config.origin}/internal/agent/os`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ serverId, os }),
    });
    if (!res.ok) {
      log.debug(`os report rejected: HTTP ${res.status}`);
    }
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
