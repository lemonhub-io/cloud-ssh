import { describe, expect, it } from 'vitest';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { DataChannelSessionChannel, type DataChannelLike } from '../src/dc-channel';
import { CHANNEL_OPEN } from '../../src/session-channel';

/**
 * werift 进程内环回：验证 agent 依赖的 RTC 栈在 Node 里能完成
 * ICE/DTLS/SCTP 握手并让 DataChannel 双向收发字节。
 * 使用本机 host candidate（无 STUN/TURN），即纯 UDP loopback。
 */
describe('werift loopback', () => {
  it(
    '两个 RTCPeerConnection 经 offer/answer + ICE trickle 打通 DataChannel',
    { timeout: 20_000 },
    async () => {
      const offerer = new RTCPeerConnection();
      const answerer = new RTCPeerConnection();
      try {
        offerer.onIceCandidate.subscribe((c) => {
          if (c) void answerer.addIceCandidate(c);
        });
        answerer.onIceCandidate.subscribe((c) => {
          if (c) void offerer.addIceCandidate(c);
        });

        const sshChannel = offerer.createDataChannel('ssh', { ordered: true });
        const inbound = new Promise<RTCDataChannel>((resolve) => {
          answerer.onDataChannel.subscribe((dc) => {
            if (dc.label === 'ssh') resolve(dc);
          });
        });

        const offer = await offerer.createOffer();
        await offerer.setLocalDescription(offer);
        await answerer.setRemoteDescription(offerer.localDescription!);
        const answer = await answerer.createAnswer();
        await answerer.setLocalDescription(answer);
        await offerer.setRemoteDescription(answerer.localDescription!);

        const remote = await inbound;
        await new Promise<void>((resolve) => {
          if (remote.readyState === 'open') return resolve();
          remote.stateChanged.subscribe((s) => {
            if (s === 'open') resolve();
          });
        });

        // 远端通道 → SessionChannel：SSHSession 消费侧的形状验证
        const channel = new DataChannelSessionChannel(remote as unknown as DataChannelLike);
        expect(channel.readyState).toBe(CHANNEL_OPEN);

        // 双向收发：本地 → 远端
        const fromLocal = new Promise<Buffer>((resolve) => {
          remote.onMessage.subscribe((data) => resolve(Buffer.from(data as Uint8Array)));
        });
        sshChannel.send(Buffer.from([0x53, 0x53, 0x48])); // "SSH"
        expect((await fromLocal).toString()).toBe('SSH');

        // 远端（经 SessionChannel）→ 本地
        const fromRemote = new Promise<Buffer>((resolve) => {
          sshChannel.onMessage.subscribe((data) => resolve(Buffer.from(data as Uint8Array)));
        });
        channel.send(new Uint8Array([0x4f, 0x4b])); // "OK"
        expect((await fromRemote).toString()).toBe('OK');
      } finally {
        await offerer.close();
        await answerer.close();
      }
    }
  );
});
