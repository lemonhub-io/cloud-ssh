import type { RTCIceServerSpec } from '../p2p-signaling';
import type { Env } from '../types';

/** Cloudflare Realtime 短期凭据签发端点（服务端调用，凭据可下发浏览器/Agent）。 */
const TURN_CREDENTIALS_ENDPOINT =
  'https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers';
const CLOUDFLARE_STUN_URLS = ['stun:stun.cloudflare.com:3478'];
// 覆盖 SSH 长会话：超过 RTC 连接生命周期即由 ICE restart/重信令兜底；
// 取 Realtime 支持上限内的一天，避免会话中途过期。
const TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

/**
 * 组装本轮 P2P 会话可用的 ICE 服务器列表。
 * - 始终包含 Cloudflare 免费 STUN；
 * - 配置 TURN_KEY_ID/TURN_API_TOKEN 时代签 Cloudflare Realtime 短期凭据；
 * - TURN_EXTRA_URIS 允许追加自建 coturn 作为区域兜底。
 * 签发失败不阻断会话：直连 host candidate 仍可工作，仅失去中继兜底。
 */
export async function buildIceServers(env: Env): Promise<RTCIceServerSpec[]> {
  const iceServers: RTCIceServerSpec[] = [{ urls: CLOUDFLARE_STUN_URLS }];

  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    try {
      const response = await fetch(
        TURN_CREDENTIALS_ENDPOINT.replace('{keyId}', encodeURIComponent(env.TURN_KEY_ID)),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.TURN_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
        }
      );
      if (response.ok) {
        const body = await response.json<{ iceServers?: RTCIceServerSpec[] }>();
        if (Array.isArray(body.iceServers)) {
          for (const spec of body.iceServers) {
            if (spec && spec.urls) iceServers.push(spec);
          }
        }
      } else if (env.DEBUG_MODE === 'true') {
        console.error(`TURN credential request failed: ${response.status}`);
      }
    } catch (e) {
      if (env.DEBUG_MODE === 'true') {
        console.error(`TURN credential request error: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (env.TURN_EXTRA_URIS) {
    const urls = env.TURN_EXTRA_URIS.split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0 && u.length <= 512);
    if (urls.length > 0) {
      const spec: RTCIceServerSpec = { urls };
      if (env.TURN_EXTRA_USERNAME) spec.username = env.TURN_EXTRA_USERNAME;
      if (env.TURN_EXTRA_CREDENTIAL) spec.credential = env.TURN_EXTRA_CREDENTIAL;
      iceServers.push(spec);
    }
  }

  return iceServers;
}
