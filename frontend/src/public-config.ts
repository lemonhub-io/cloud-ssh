export interface PublicConfig {
  turnstileEnabled: boolean;
  sitekey: string;
  githubAuthEnabled: boolean;
  githubAuthRequired: boolean;
  sshSharingEnabled: boolean;
  p2pEnabled?: boolean;
  /** Agent 机端默认源（workers.dev，不经自定义域名挑战）；未配置为 null */
  workersDevOrigin?: string | null;
}

/**
 * /api/config 只随部署变化；同一页面生命周期内多个调用方共享一次请求，
 * 避免登录页与服务器列表各自重复拉取。
 */
let cachedConfig: Promise<PublicConfig | null> | null = null;

export function getPublicConfig(): Promise<PublicConfig | null> {
  if (!cachedConfig) {
    cachedConfig = fetch('/api/config')
      .then((response) => (response.ok ? (response.json() as Promise<PublicConfig>) : null))
      .catch(() => null);
  }
  return cachedConfig;
}
