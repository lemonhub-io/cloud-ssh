import { describe, expect, it } from 'vitest';
import {
  buildInstallCommand,
  buildProbeCommand,
  buildStartCommand,
  parseProbeOutput,
  shQuote,
  type AgentProbeResult,
} from '../../src/worker/agent-bootstrap';

describe('agent-bootstrap 命令构建', () => {
  it('shQuote 单引号转义', () => {
    expect(shQuote('abc')).toBe("'abc'");
    expect(shQuote("a'b")).toBe("'a'\\''b'");
    expect(shQuote("'; rm -rf /;'")).toBe("''\\''; rm -rf /;'\\'''");
  });

  it('probe 命令产出单行 CS_PROBE 标记且自匹配安全', () => {
    const cmd = buildProbeCommand();
    expect(cmd).toContain('CS_PROBE installed=');
    expect(cmd).toContain('aid=');
    expect(cmd).toContain('bin=');
    // pgrep -x 精确匹配进程名，避免 -f 命中 sh -c 整段脚本造成 running 误报
    expect(cmd).toContain('pgrep -x cloudssh-agent');
    // 探测常见安装路径与 env 文件
    expect(cmd).toContain('.local/bin/cloudssh-agent');
    expect(cmd).toContain('cloudssh-agent/agent.env');
  });

  it('parseProbeOutput 解析完整标记行', () => {
    const out =
      'noise from profile\n' +
      'CS_PROBE installed=1 running=0 svc=systemd-user aid=agent-42 bin=/home/u/.local/bin/cloudssh-agent\n';
    expect(parseProbeOutput(out)).toEqual({
      installed: true,
      running: false,
      service: 'systemd-user',
      bin: '/home/u/.local/bin/cloudssh-agent',
      agentId: 'agent-42',
    });
  });

  it('parseProbeOutput：未安装时 svc/bin 归一化为 none/空', () => {
    const r = parseProbeOutput('CS_PROBE installed=0 running=0 svc=none aid= bin=');
    expect(r).toEqual({
      installed: false,
      running: false,
      service: 'none',
      bin: '',
      agentId: '',
    });
  });

  it('parseProbeOutput：带空格的路径与手动安装形态', () => {
    const r = parseProbeOutput(
      'CS_PROBE installed=1 running=1 svc=none aid=ax bin=/home/my user/bin/cloudssh-agent'
    );
    expect(r?.service).toBe('manual');
    expect(r?.bin).toBe('/home/my user/bin/cloudssh-agent');
    expect(r?.running).toBe(true);
  });

  it('parseProbeOutput：无标记行返回 null（非 POSIX/被截断）', () => {
    expect(parseProbeOutput('')).toBeNull();
    expect(parseProbeOutput('bash: syntax error\n')).toBeNull();
    expect(parseProbeOutput('CS_PROBE installed=1 running=1')).toBeNull();
  });

  it('用户级安装命令：token 走 stdin，argv 无秘密', () => {
    const spec = buildInstallCommand({
      installBase: 'https://ssh.lemonhub.online',
      agentServer: 'https://ssh.lemonhub.online',
      system: false,
    });
    expect(spec.stdinLines).toEqual(['token']);
    expect(spec.command).toContain('install.sh');
    expect(spec.command).toContain('--token-file');
    expect(spec.command).toContain('--server');
    expect(spec.command).toContain('IFS= read -r CS_TOK');
    // token 值绝不出现在命令行
    expect(spec.command).not.toContain('secret-value');
    expect(spec.command).not.toContain('sudo');
  });

  it('系统级安装命令：token+sudo 双行 stdin + 清理', () => {
    const spec = buildInstallCommand({
      installBase: 'https://ssh.lemonhub.online',
      agentServer: 'https://ssh.lemonhub.online',
      system: true,
    });
    expect(spec.stdinLines).toEqual(['token', 'sudo']);
    expect(spec.command).toContain("sudo -S -p ''");
    expect(spec.command).toContain('--system');
    expect(spec.command).toContain('rm -f');
    expect(spec.command).toContain('umask 077');
    expect(spec.command).not.toContain('secret-value');
  });

  it('安装命令对恶意 server 输入做 shell 转义', () => {
    const spec = buildInstallCommand({
      installBase: 'https://x',
      agentServer: "https://x'; rm -rf /; '",
      system: false,
    });
    // 每个 ' 被 '\'' 包裹：整体仍是合法单引号串，注入文本不外溢
    expect(spec.command).toContain("'https://x'\\''; rm -rf /; '\\'''");
  });

  it('探测命令是合法 POSIX shell（sh -n 语法校验）', () => {
    // 回归护栏：多行结构（if/for/case）拼接必须用换行而非 ';'
    const { execFileSync } = require('node:child_process');
    execFileSync('sh', ['-n', '-c', buildProbeCommand()]);
    // 进程名精确匹配而非 -f（-f 会命中 sh -c 整段脚本造成 running 恒真）
    expect(buildProbeCommand()).toContain('pgrep -x cloudssh-agent');
    expect(buildProbeCommand()).not.toContain("pgrep -f 'cloudssh-ag");
  });

  it('start 命令按服务形态分发', () => {
    const base: AgentProbeResult = {
      installed: true,
      running: false,
      service: 'none',
      bin: '/usr/local/bin/cloudssh-agent',
      agentId: 'a1',
    };
    const user = buildStartCommand({ ...base, service: 'systemd-user' });
    expect(user.stdinLines).toEqual([]);
    expect(user.command).toContain('systemctl --user start');

    const system = buildStartCommand({ ...base, service: 'systemd-system' });
    expect(system.stdinLines).toEqual(['sudo']);
    expect(system.command).toContain("sudo -S -p '' systemctl start");
    expect(system.command).toContain('read -r CS_PW');

    const launchd = buildStartCommand({ ...base, service: 'launchd' });
    expect(launchd.stdinLines).toEqual([]);
    expect(launchd.command).toContain('launchctl');

    const manual = buildStartCommand({ ...base, service: 'manual' });
    expect(manual.stdinLines).toEqual([]);
    expect(manual.command).toContain('nohup');
    expect(manual.command).toContain('/usr/local/bin/cloudssh-agent');
    expect(manual.command).toContain('agent.env');
  });
});
