#!/usr/bin/env node
import { AGENT_VERSION, ConfigError, resolveConfig, type AgentConfigInput } from './config';
import { Logger } from './log';
import { SessionRunner } from './session-runner';
import { SignalClient } from './signal-client';

const USAGE = `cloudssh-agent — CloudSSH P2P gateway

Usage:
  cloudssh-agent --server <https://host> --token <githubId:agentId:secret> [options]

Options:
  --server <url>        CloudSSH site origin (default: https://cloudssh.mzhub.workers.dev)
  --token <token>       Agent token (or AGENT_TOKEN env)
  --signal-url <url>    Override signaling WebSocket URL (or AGENT_SIGNAL_URL)
  --allowlist <hosts>   Comma-separated SSH target allowlist, *.domain.com wildcards (or AGENT_ALLOWLIST)
  --max-sessions <n>    Max concurrent sessions (default: 8, or AGENT_MAX_SESSIONS)
  --debug               Verbose logging (or AGENT_DEBUG=1)
  -v, --version         Show version
  -h, --help            Show this help
`;

function parseArgs(argv: string[]): AgentConfigInput | 'help' | 'version' {
  const input: AgentConfigInput = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '-v':
      case '--version':
        return 'version';
      case '--server':
        input.server = next();
        break;
      case '--token':
        input.token = next();
        break;
      case '--signal-url':
        input.signalUrl = next();
        break;
      case '--allowlist':
        input.allowlist = next();
        break;
      case '--max-sessions':
        input.maxSessions = Number(next());
        break;
      case '--debug':
        input.debug = true;
        break;
      default:
        if (arg.startsWith('--server=')) input.server = arg.slice(9);
        else if (arg.startsWith('--token=')) input.token = arg.slice(8);
        else if (arg.startsWith('--signal-url=')) input.signalUrl = arg.slice(13);
        else if (arg.startsWith('--allowlist=')) input.allowlist = arg.slice(12);
        else if (arg.startsWith('--max-sessions=')) input.maxSessions = Number(arg.slice(15));
        else throw new ConfigError(`Unknown argument: ${arg}`);
    }
  }
  return input;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  if (parsed === 'version') {
    console.log(`cloudssh-agent ${AGENT_VERSION}`);
    return;
  }
  const config = resolveConfig(parsed);
  const log = new Logger(config.debug);

  log.info(`agent ${config.agentId} → ${config.signalUrl}`);
  if (config.allowlist.length > 0) {
    log.info(`target allowlist: ${config.allowlist.join(', ')}`);
  }
  log.info(`max sessions: ${config.maxSessions}`);

  let client: SignalClient;
  const runner = new SessionRunner(config, log, (msg) => client.send(msg));
  client = new SignalClient(config, log, (msg) => runner.handle(msg));
  client.start();

  const shutdown = () => {
    log.info('shutting down');
    runner.destroyAll();
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    console.error(`[cloudssh-agent] ${e.message}\n`);
    console.log(USAGE);
    process.exit(2);
  }
  console.error(`[cloudssh-agent] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
