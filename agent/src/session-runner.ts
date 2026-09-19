import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { parseIdleTimeout } from '../../src/worker/idle-timeout';
import {
  buildResumeChallengeMessage,
  RESUME_CHALLENGE_MAX_CLOCK_SKEW_MS,
} from '../../src/share-resume-schema';
import {
  P2P_PROTO_VERSION,
  type AgentSessionInit,
  type AgentSessionResume,
  type RTCIceServerSpec,
  type ToAgentMessage,
} from '../../src/p2p-signaling';
import {
  normalizeTerminalSize,
  SESSION_GRACE_PERIOD_MS,
  type SSHConnectionConfig,
  type SSHJumpHostConfig,
} from '../../src/types';
import { SSHSession } from '../../src/worker/ssh-session';
import type { AgentConfig } from './config';
import { isHostAllowed } from './config';
import { createHttpAuditSink, createOsPersist } from './callbacks';
import { DataChannelSessionChannel } from './dc-channel';
import type { Logger } from './log';
import { createAgentSocket, type AgentSocket } from './net-socket';

/** 与 Worker DO 保持一致的高危端口黑名单（SSH 不应承载在这些端口上）。 */
const BLOCKED_PORTS = [
  23, 80, 443, 25, 465, 587, 110, 143, 993, 995, 3306, 5432, 6379, 9200, 11211, 27017, 5060,
];
const MAX_JUMP_HOSTS = 3;

interface DetachedState {
  resumeToken: string;
  previousResumeToken?: string;
  devicePubKey?: string;
  usedNonces: Set<string>;
  graceTimer: NodeJS.Timeout;
  sftpAttachUrl?: string;
}

interface AgentSession {
  name: string;
  pc?: RTCPeerConnection;
  config?: SSHConnectionConfig;
  ssh?: SSHSession;
  chain: SSHSession[];
  sshDc?: RTCDataChannel;
  ready: boolean;
  closed: boolean;
  detached: DetachedState | null;
  /** 会话创建时预置的恢复元数据；ssh DC 断开时提升为 detached。 */
  preDetached?: DetachedState;
  /** session_init 携带的 ICE 配置；resume 轮为空。 */
  iceServers: RTCIceServerSpec[];
  /** resume 校验通过后暂存的下一帧重连信息（新 DC open 后消费）。 */
  pendingResume: { size?: { cols: number; rows: number }; nextToken: string } | null;
  /** ssh DC open 前到达的 SFTP 通道（按到达顺序在会话创建后挂载）。 */
  pendingSftpChannels: RTCDataChannel[];
  sftpAttachUrl: string;
  baseline?: { latencyMs: number; colo: string };
}

/** 信令回传出口：runner 只产出消息对象，由 signal-client 负责投递。 */
export type SignalSender = (msg: Record<string, unknown>) => void;

export class SessionRunner {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly config: AgentConfig,
    private readonly log: Logger,
    private readonly sendSignal: SignalSender
  ) {}

  get activeCount(): number {
    return this.sessions.size;
  }

  /** 处理 DO 下发的 ToAgentMessage（已经过 parseToAgentSignal 校验）。 */
  async handle(msg: ToAgentMessage): Promise<void> {
    switch (msg.type) {
      case 'session_init':
        await this.handleSessionInit(msg);
        return;
      case 'session_resume':
        await this.handleSessionResume(msg);
        return;
      case 'rtc_offer':
        await this.handleRtcOffer(msg.session, msg.sdp);
        return;
      case 'rtc_ice':
        await this.handleRtcIce(msg.session, msg.candidate);
        return;
      case 'rtc_abort':
        await this.handleAbort(msg.session);
        return;
      case 'session_close':
        this.destroySession(msg.session, true);
        return;
      case 'pong':
        return;
    }
  }

  // ==================== session_init：新建会话 ====================

  private async handleSessionInit(msg: AgentSessionInit): Promise<void> {
    if (msg.p2pProto !== P2P_PROTO_VERSION) {
      this.sendSignal({
        type: 'session_error',
        session: msg.session,
        message: `Unsupported p2p protocol version ${msg.p2pProto}`,
      });
      return;
    }
    if (this.sessions.size >= this.config.maxSessions && !this.sessions.has(msg.session)) {
      this.sendSignal({
        type: 'session_error',
        session: msg.session,
        message: 'Agent session limit reached',
      });
      return;
    }

    const sess = this.getOrCreate(msg.session);
    sess.config = msg.config;
    sess.iceServers = msg.iceServers ?? [];

    // 目标白名单 + 端口黑名单：覆盖入口与全部跳板节点
    const nodes: Array<{ host: string; port: number }> = [
      ...(msg.config.jumpHosts ?? []),
      msg.config,
    ];
    for (const node of nodes) {
      if (!isHostAllowed(this.config.allowlist, node.host)) {
        this.sendSignal({
          type: 'session_error',
          session: msg.session,
          message: `Target host not in agent allowlist: ${node.host}`,
        });
        this.destroySession(msg.session, false);
        return;
      }
      if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
        this.failInit(sess, `Invalid port ${node.port}`);
        return;
      }
      if (BLOCKED_PORTS.includes(node.port)) {
        this.failInit(sess, `Port ${node.port} is blocked`);
        return;
      }
    }

    this.createPeerConnection(sess);
  }

  private failInit(sess: AgentSession, message: string): void {
    this.sendSignal({ type: 'session_error', session: sess.name, message });
    this.destroySession(sess.name, false);
  }

  // ==================== session_resume：断线恢复 ====================

  private async handleSessionResume(msg: AgentSessionResume): Promise<void> {
    const sess = this.sessions.get(msg.session);
    const detached = sess?.detached;
    if (!sess || !detached || !sess.ssh) {
      this.sendSignal({
        type: 'session_error',
        session: msg.session,
        message: 'Session expired or not found',
      });
      return;
    }

    const tokenIsCurrent = detached.resumeToken === msg.resumeToken;
    const tokenIsPrevious =
      !tokenIsCurrent &&
      detached.previousResumeToken !== undefined &&
      detached.previousResumeToken === msg.resumeToken;
    if (!tokenIsCurrent && !tokenIsPrevious) {
      this.sendSignal({
        type: 'session_error',
        session: msg.session,
        message: 'Invalid resume token',
      });
      return;
    }

    const policy = sess.ssh.getSessionPolicy();
    if (policy?.source === 'share') {
      if (Date.now() >= policy.sessionExpiresAt) {
        this.sendSignal({
          type: 'session_error',
          session: msg.session,
          message: 'Share session expired',
        });
        this.destroySession(msg.session, false);
        return;
      }
      if (!detached.devicePubKey) {
        this.sendSignal({
          type: 'session_error',
          session: msg.session,
          message: 'Device binding required',
        });
        return;
      }
      const verification = await this.verifyDeviceSignature(sess, detached, msg);
      if (!verification.ok) {
        this.sendSignal({
          type: 'session_error',
          session: msg.session,
          message: `Device verification failed: ${verification.reason}`,
        });
        return;
      }
    }

    // 轮换 token：上一代降级容忍一次，覆盖轮换帧丢失后的重试
    const nextToken = randomToken();
    detached.previousResumeToken = tokenIsPrevious
      ? detached.previousResumeToken
      : detached.resumeToken;
    detached.resumeToken = nextToken;

    clearTimeout(detached.graceTimer);
    const size = normalizeTerminalSize(msg.cols, msg.rows) || undefined;
    sess.pendingResume = { size, nextToken };
    // 恢复轮使用新签发的 ICE 配置（保留原值兜底）
    if (msg.iceServers?.length) {
      sess.iceServers = msg.iceServers;
    }
    this.createPeerConnection(sess);
  }

  private async verifyDeviceSignature(
    sess: AgentSession,
    detached: DetachedState,
    msg: AgentSessionResume
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { didNonce: nonce, didTs: ts, didSig: sig } = msg;
    if (!nonce || !/^[A-Za-z0-9]{16,128}$/.test(nonce)) {
      return { ok: false, reason: 'missing_nonce' };
    }
    if (!Number.isFinite(ts) || Math.abs(Date.now() - (ts ?? 0)) > RESUME_CHALLENGE_MAX_CLOCK_SKEW_MS) {
      return { ok: false, reason: 'timestamp_skew' };
    }
    if (!sig || !/^[A-Za-z0-9_-]{64,1024}$/.test(sig)) {
      return { ok: false, reason: 'missing_signature' };
    }
    if (detached.usedNonces.has(nonce)) {
      return { ok: false, reason: 'nonce_replayed' };
    }
    // 验签前先消费 nonce：异步验签期间的并发请求无法复用同一挑战。
    detached.usedNonces.add(nonce);
    try {
      const publicKey = await crypto.subtle.importKey(
        'spki',
        base64UrlDecode(detached.devicePubKey!),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
      const message = buildResumeChallengeMessage(sess.name, nonce, ts!);
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        base64UrlDecode(sig),
        new TextEncoder().encode(message)
      );
      if (!valid) return { ok: false, reason: 'signature_invalid' };
    } catch {
      return { ok: false, reason: 'verification_error' };
    }
    return { ok: true };
  }

  // ==================== RTC：offer/answer/ICE ====================

  private createPeerConnection(sess: AgentSession): void {
    if (sess.closed) return;
    const pc = new RTCPeerConnection({
      iceServers: sess.iceServers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
    });
    sess.pc = pc;

    pc.onDataChannel.subscribe((dc) => this.onDataChannel(sess, dc));
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate?.candidate) {
        this.sendSignal({
          type: 'rtc_ice',
          session: sess.name,
          candidate: candidate.candidate,
        });
      }
    });
    pc.iceConnectionStateChange.subscribe((state) => {
      this.log.debug(`ice ${state} session=${sess.name}`);
      if (state === 'failed' || state === 'closed') {
        this.onChannelLost(sess);
      }
    });
  }

  private async handleRtcOffer(sessionName: string, sdp: string): Promise<void> {
    const sess = this.sessions.get(sessionName);
    if (!sess?.pc || sess.closed) return;
    try {
      await sess.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await sess.pc.createAnswer();
      await sess.pc.setLocalDescription(answer);
      this.sendSignal({
        type: 'rtc_answer',
        session: sessionName,
        sdp: sess.pc.localDescription?.sdp ?? '',
      });
    } catch (e) {
      this.sendSignal({
        type: 'rtc_failed',
        session: sessionName,
        reason: `answer failed: ${errMsg(e)}`,
      });
    }
  }

  private async handleRtcIce(sessionName: string, candidate: string): Promise<void> {
    const sess = this.sessions.get(sessionName);
    if (!sess?.pc || sess.closed) return;
    try {
      await sess.pc.addIceCandidate({ candidate });
    } catch (e) {
      this.log.debug(`addIceCandidate failed: ${errMsg(e)}`);
    }
  }

  // ==================== DataChannel 生命周期 ====================

  private onDataChannel(sess: AgentSession, dc: RTCDataChannel): void {
    if (dc.label === 'sftp') {
      this.onSftpChannel(sess, dc);
      return;
    }
    if (dc.label !== 'ssh') {
      try {
        dc.close();
      } catch {
        /* ignore */
      }
      return;
    }
    sess.sshDc = dc;
    dc.onMessage.subscribe((data) => {
      const payload = typeof data === 'string' ? data : toArrayBuffer(data);
      void sess.ssh?.handleWebSocketMessage(payload).catch((e) => {
        this.log.debug(`handleWebSocketMessage error: ${errMsg(e)}`);
      });
    });
    dc.stateChanged.subscribe((state) => {
      if (state === 'open') {
        void this.onSshChannelOpen(sess, dc);
      } else if (state === 'closed' || state === 'closing') {
        if (sess.sshDc === dc) this.onChannelLost(sess);
      }
    });
    if (dc.readyState === 'open') {
      void this.onSshChannelOpen(sess, dc);
    }
  }

  private onSftpChannel(sess: AgentSession, dc: RTCDataChannel): void {
    dc.onMessage.subscribe((data) => {
      const payload = typeof data === 'string' ? data : toArrayBuffer(data);
      void sess.ssh?.handleWebSocketMessage(payload).catch(() => undefined);
    });
    if (sess.ssh) {
      sess.ssh.attachSFTPWebSocket(new DataChannelSessionChannel(dc));
    } else {
      sess.pendingSftpChannels.push(dc);
    }
  }

  /** ssh DataChannel 打开：新建会话或完成恢复。 */
  private async onSshChannelOpen(sess: AgentSession, dc: RTCDataChannel): Promise<void> {
    if (sess.closed || sess.sshDc !== dc) return;

    if (sess.detached && sess.ssh) {
      // 恢复路径：凭据已在 session_resume 校验并轮换
      const pending = sess.pendingResume;
      sess.pendingResume = null;
      const detached = sess.detached;
      sess.detached = null;
      try {
        await sess.ssh.reattachWebSocket(new DataChannelSessionChannel(dc), pending?.size, {
          resumeToken: pending?.nextToken,
          sftpAttachUrl: detached?.sftpAttachUrl,
          baseline: sess.baseline,
        });
        this.markReady(sess);
      } catch (e) {
        this.log.warn(`reattach failed session=${sess.name}: ${errMsg(e)}`);
        this.destroySession(sess.name, false);
      }
      return;
    }

    if (sess.ssh) return; // 重复 open 事件忽略
    if (!sess.config) {
      this.sendSignal({
        type: 'session_error',
        session: sess.name,
        message: 'Session config missing',
      });
      return;
    }

    const channel = new DataChannelSessionChannel(dc);
    try {
      await this.buildSshSession(sess, channel);
      this.markReady(sess);
    } catch (e) {
      const msg = errMsg(e);
      this.sendSignal({ type: 'session_error', session: sess.name, message: `连接失败: ${msg}` });
      this.destroySession(sess.name, false);
    }
  }

  private markReady(sess: AgentSession): void {
    sess.ready = true;
    this.sendSignal({ type: 'rtc_ready', session: sess.name });
  }

  // ==================== SSHSession 构建（镜像 DO initSSHSession） ====================

  private async buildSshSession(
    sess: AgentSession,
    channel: DataChannelSessionChannel
  ): Promise<void> {
    const config = sess.config!;
    const jumpHosts = (config.jumpHosts ?? []).slice(0, MAX_JUMP_HOSTS);

    const startTime = Date.now();
    let transport: AgentSocket | import('../../src/worker/direct-tcpip-stream').DirectTcpipStream =
      createAgentSocket(config.host, config.port);
    await (transport as AgentSocket).opened;
    const latency = Date.now() - startTime;
    sess.baseline = { latencyMs: latency, colo: 'agent' };

    // 分享会话强制严格主机密钥校验（同 DO 行为）
    const strictVerify =
      config.sessionPolicy?.source === 'share'
        ? true
        : process.env.STRICT_HOST_KEY_VERIFY !== 'false';

    const auditSink = config.sessionPolicy?.source === 'share'
      ? createHttpAuditSink(this.config, config.sessionPolicy.shareRef, this.log)
      : undefined;
    const persistOS =
      typeof config.serverId === 'number'
        ? createOsPersist(this.config, config.serverId, this.log)
        : undefined;

    const chainSessions: SSHSession[] = [];
    for (let index = 0; index < jumpHosts.length; index++) {
      const hop = jumpHosts[index];
      channel.send(
        JSON.stringify({
          type: 'status',
          event: 'jump_hop_connecting',
          message: `正在连接跳板服务器 ${hop.name}`,
          params: { index: index + 1, total: jumpHosts.length, name: hop.name, host: hop.host, port: hop.port },
        })
      );
      const hopSession: SSHSession = new SSHSession(
        channel,
        transport,
        { ...hop, sessionPolicy: undefined } as SSHConnectionConfig,
        strictVerify,
        this.config.debug,
        undefined,
        undefined,
        config.userId,
        config.githubId,
        { openShellOnAuth: false, ownsWebSocket: false, allowKeyboardInteractive: false }
      );
      chainSessions.push(hopSession);
      await hopSession.startHandshake();
      // 等待认证完成进入 tunnel-ready 后才能 openDirectTcpip
      await hopSession.waitUntilAuthenticated();
      const destination: SSHJumpHostConfig | SSHConnectionConfig = jumpHosts[index + 1] || config;
      transport = await hopSession.openDirectTcpip(destination.host, destination.port);
    }

    if (jumpHosts.length > 0) {
      channel.send(
        JSON.stringify({
          type: 'status',
          event: 'jump_target_connecting',
          message: `正在通过跳板连接目标服务器 ${config.host}:${config.port}`,
          params: { host: config.host, port: config.port },
        })
      );
    }

    const finalConfig = { ...config, jumpHosts: undefined };
    const session = new SSHSession(
      channel,
      transport,
      finalConfig,
      strictVerify,
      this.config.debug,
      sess.sftpAttachUrl,
      undefined,
      config.userId,
      config.githubId,
      {
        shareAuditSink: auditSink,
        persistOS,
        idleTimeoutMs: parseIdleTimeout(process.env.IDLE_TIMEOUT),
      }
    );
    chainSessions.push(session);
    sess.chain = chainSessions;
    sess.ssh = session;

    // session_created 凭据下发（镜像 DO 的消息格式）
    const policy = config.sessionPolicy;
    const deviceBound = policy?.source === 'share' ? Boolean(policy.devicePubKey) : false;
    const shareResumable = policy?.source === 'share' ? deviceBound : true;
    const resumeToken = shareResumable ? randomToken() : '';
    channel.send(JSON.stringify({ type: 'rtt', latency, colo: 'agent' }));
    channel.send(
      JSON.stringify({
        type: 'session_created',
        sessionId: sess.name,
        resumeToken,
        expiresIn: SESSION_GRACE_PERIOD_MS / 1000,
        deviceBound,
        resumeEnabled: shareResumable,
      })
    );

    // 预建 detached 元数据：断线时直接提升为宽限记录
    sess.preDetached = {
      resumeToken,
      devicePubKey: policy?.source === 'share' ? policy.devicePubKey : undefined,
      usedNonces: new Set(),
      graceTimer: undefined as unknown as NodeJS.Timeout,
      sftpAttachUrl: sess.sftpAttachUrl,
    };

    for (const dc of sess.pendingSftpChannels.splice(0)) {
      session.attachSFTPWebSocket(new DataChannelSessionChannel(dc));
    }

    await session.startHandshake();
  }

  // ==================== 断线保持与销毁 ====================

  /** ssh DC 关闭或 ICE 失败：就绪会话进入 60s 保持宽限，其余直接销毁。 */
  private onChannelLost(sess: AgentSession): void {
    if (sess.closed) return;
    const ssh = sess.ssh;
    const pre = sess.preDetached;
    if (ssh && ssh.isReady() && pre?.resumeToken) {
      if (sess.detached) return; // 已在宽限期
      ssh.setDetached(true);
      pre.graceTimer = setTimeout(() => {
        this.destroySession(sess.name, false);
      }, SESSION_GRACE_PERIOD_MS);
      sess.detached = pre;
      this.log.info(`session detached (grace ${SESSION_GRACE_PERIOD_MS / 1000}s): ${sess.name}`);
      return;
    }
    this.destroySession(sess.name, false);
  }

  private async handleAbort(sessionName: string): Promise<void> {
    const sess = this.sessions.get(sessionName);
    if (!sess) return;
    // 信令中止：已就绪会话保留可恢复窗口，未就绪直接销毁
    this.onChannelLost(sess);
  }

  private destroySession(sessionName: string, normal: boolean): void {
    const sess = this.sessions.get(sessionName);
    if (!sess || sess.closed) return;
    sess.closed = true;
    if (sess.detached) {
      clearTimeout(sess.detached.graceTimer);
      sess.detached = null;
    }
    for (const item of [...sess.chain].reverse()) {
      try {
        item.close(normal);
      } catch {
        /* ignore */
      }
    }
    try {
      void sess.pc?.close();
    } catch {
      /* ignore */
    }
    this.sessions.delete(sessionName);
    this.sendSignal({ type: 'session_ended', session: sessionName });
    this.log.info(`session ended: ${sessionName}`);
  }

  /** Agent 退出前的批量清理。 */
  destroyAll(): void {
    for (const name of [...this.sessions.keys()]) {
      this.destroySession(name, true);
    }
  }

  private getOrCreate(name: string): AgentSession {
    let sess = this.sessions.get(name);
    if (!sess) {
      sess = {
        name,
        chain: [],
        ready: false,
        closed: false,
        detached: null,
        iceServers: [],
        pendingResume: null,
        pendingSftpChannels: [],
        sftpAttachUrl: `rtc+sftp://${name}`,
      };
      this.sessions.set(name, sess);
    }
    return sess;
  }
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
