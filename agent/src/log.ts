/** 轻量分级日志：debug 仅在 --debug/AGENT_DEBUG 下输出；永不打印凭据字段。 */
export class Logger {
  constructor(private readonly debugEnabled: boolean) {}

  info(msg: string): void {
    console.log(`[cloudssh-agent] ${msg}`);
  }

  warn(msg: string): void {
    console.warn(`[cloudssh-agent] WARN ${msg}`);
  }

  error(msg: string): void {
    console.error(`[cloudssh-agent] ERROR ${msg}`);
  }

  debug(msg: string): void {
    if (this.debugEnabled) console.log(`[cloudssh-agent] DEBUG ${msg}`);
  }
}
