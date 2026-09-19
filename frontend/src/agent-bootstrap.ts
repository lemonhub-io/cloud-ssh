// Agent 远端引导编排器：复用已建立的中继 SSH 会话探测/安装/启动目标机上的
// Agent，随后把服务器绑定到该 Agent 并将会话升级为 P2P。
//
// 流程（用户规格）：
//   已安装+运行   → 直接绑定并升级 P2P（不打断用户）
//   已安装+未运行 → 询问是否启动（systemd-system 需要 sudo 密码）
//   未安装        → 询问是否安装（可选用户级/系统级，系统级需要 sudo 密码）
//   任一步拒绝/失败 → 保持中继；DO 中继此后只承担引导与兜底，不再是常规模式
//
// sudo 密码只经 SSH exec stdin 传输（sudo -S），不出现在远端命令行/ps/日志。
import { isAgentOnline, type AgentSummary } from './agent-manager';
import { t } from './i18n';
import { getPublicConfig } from './public-config';
import { notify } from './ui-feedback';
import type { ServerConfig } from './server-list';
import type { SSHTerminal } from './terminal';

/** 升级回调由 main.ts 注入：铸新 token → 信令 → 同标签页换 P2P 传输。 */
export type P2PUpgradeFn = (agentId: string) => Promise<boolean>;

const PROBE_TIMEOUT_MS = 40_000;
const START_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 320_000; // 远端需下载 ~100MB 二进制
const ONLINE_POLL_MS = 2_000;
const ONLINE_WAIT_MS = 90_000;

/** 用户拒绝引导后，同一浏览器会话内不再对同一服务器重复打扰。 */
const declinedKey = (serverId: number) => `cloudssh.p2p.bootDeclined.${serverId}`;

function isDeclined(serverId: number): boolean {
  try {
    return sessionStorage.getItem(declinedKey(serverId)) === '1';
  } catch {
    return false;
  }
}

function markDeclined(serverId: number): void {
  try {
    sessionStorage.setItem(declinedKey(serverId), '1');
  } catch {
    /* 忽略 */
  }
}

/** 同一 terminal 实例只跑一次（session_resumed 会重复触发 onSessionReady）。 */
const bootstrapped = new WeakSet<SSHTerminal>();

interface ProbeResultMsg {
  ok?: boolean;
  installed?: boolean;
  running?: boolean;
  service?: string;
  bin?: string;
  agentId?: string;
  error?: string;
}

/** 发一帧控制消息并等待对应结果帧；超时/通道关闭返回 null。 */
function sendAndAwait(
  terminal: SSHTerminal,
  send: Record<string, unknown>,
  resultType: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      terminal.setBootstrapHandler(undefined);
      resolve(null);
    }, timeoutMs);
    terminal.setBootstrapHandler((msg) => {
      if (msg.type !== resultType) return;
      clearTimeout(timer);
      terminal.setBootstrapHandler(undefined);
      resolve(msg);
    });
    if (!terminal.sendControlMessage(send)) {
      clearTimeout(timer);
      terminal.setBootstrapHandler(undefined);
      resolve(null);
    }
  });
}

async function fetchAgents(): Promise<AgentSummary[]> {
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) return [];
    const body = (await res.json()) as { agents?: AgentSummary[] };
    return Array.isArray(body.agents) ? body.agents : [];
  } catch {
    return [];
  }
}

/** 轮询等待目标 Agent 心跳上线（安装/启动后注册需要几秒）。 */
async function waitAgentOnline(agentId: string, timeoutMs = ONLINE_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agents = await fetchAgents();
    const target = agents.find((a) => a.id === agentId);
    if (target && isAgentOnline(target)) return true;
    await new Promise((r) => setTimeout(r, ONLINE_POLL_MS));
  }
  return false;
}

async function createAgent(name: string): Promise<{ id: string; token: string } | null> {
  try {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.slice(0, 64) || 'cloudssh-agent' }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      token?: string;
      error?: string;
    };
    if (!res.ok || !body.id || !body.token) {
      notify(body.error || t('agent.createFailed'), { variant: 'danger' });
      return null;
    }
    return { id: body.id, token: body.token };
  } catch {
    notify(t('agent.createFailed'), { variant: 'danger' });
    return null;
  }
}

/** 把服务器绑定到 Agent；引导安装的 Agent 就在目标机上 → loopback 恒为 true。 */
async function bindServerAgent(server: ServerConfig, agentId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/servers/${server.id}/agent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, agent_loopback: true }),
    });
    if (!res.ok) return false;
    server.agent_id = agentId;
    server.agent_loopback = 1;
    return true;
  } catch {
    return false;
  }
}

// ==================== 对话框 ====================

interface DialogResult {
  ok: boolean;
  system: boolean;
  sudo: string;
}

/**
 * 引导确认弹窗（安装/启动共用骨架）：
 * - showSystemChoice=true 时给出「用户级 / 系统级」安装选择，系统级才显示 sudo 密码框；
 * - sudoRequired=true（启动已存在的 systemd-system 服务）时直接显示密码框。
 * 返回 null 表示用户拒绝。
 */
function promptBootstrapDialog(opts: {
  title: string;
  desc: string;
  confirmText: string;
  showSystemChoice?: boolean;
  sudoRequired?: boolean;
}): Promise<DialogResult | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'responsive-modal fixed inset-0 z-[130] flex items-center justify-center';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const systemRow = opts.showSystemChoice
      ? `
        <div class="mb-4">
          <label class="flex items-center gap-2 text-xs text-muted mb-1.5 cursor-pointer">
            <input type="radio" name="cs-boot-mode" value="user" checked class="accent-[var(--color-primary)]" />
            ${t('agent.bootInstallUser')}
          </label>
          <label class="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input type="radio" name="cs-boot-mode" value="system" class="accent-[var(--color-primary)]" />
            ${t('agent.bootInstallSystem')}
          </label>
        </div>
        <div data-sudo-row class="hidden mb-4">
          <label class="block text-xs text-muted mb-1.5">${t('agent.bootSudoLabel')}</label>
          <input data-sudo-input type="password" autocomplete="off" class="terminal-input w-full" placeholder="${t('agent.bootSudoPlaceholder')}" />
          <p class="text-xs text-muted mt-1.5">${t('agent.bootSudoHint')}</p>
        </div>`
      : opts.sudoRequired
        ? `
        <div class="mb-4">
          <label class="block text-xs text-muted mb-1.5">${t('agent.bootSudoLabel')}</label>
          <input data-sudo-input type="password" autocomplete="off" class="terminal-input w-full" placeholder="${t('agent.bootSudoPlaceholder')}" />
          <p class="text-xs text-muted mt-1.5">${t('agent.bootSudoHint')}</p>
        </div>`
        : '';
    // pi-lens-ignore: no-inner-html
    overlay.innerHTML = `
      <div class="modal-overlay absolute inset-0"></div>
      <div class="cyber-box p-6 shadow-2xl relative z-10 w-full max-w-md mx-4">
        <h2 class="text-sm font-bold text-primary mb-2">${opts.title}</h2>
        <p class="text-xs text-muted leading-relaxed mb-5">${opts.desc}</p>
        ${systemRow}
        <div class="flex flex-col gap-2">
          <button type="button" data-confirm class="cyber-button text-primary px-4 py-2.5 text-xs font-bold w-full">${opts.confirmText}</button>
          <button type="button" data-skip class="cyber-button text-muted px-4 py-2 text-xs w-full">${t('agent.bootSkip')}</button>
        </div>
      </div>
    `;
    const sudoRow = overlay.querySelector('[data-sudo-row]') as HTMLElement | null;
    const sudoInput = overlay.querySelector('[data-sudo-input]') as HTMLInputElement | null;
    overlay.querySelectorAll('input[name="cs-boot-mode"]').forEach((el) => {
      el.addEventListener('change', () => {
        const system =
          (overlay.querySelector('input[name="cs-boot-mode"]:checked') as HTMLInputElement | null)
            ?.value === 'system';
        sudoRow?.classList.toggle('hidden', !system);
      });
    });
    const done = (result: DialogResult | null) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('[data-confirm]')?.addEventListener('click', () => {
      const system =
        (overlay.querySelector('input[name="cs-boot-mode"]:checked') as HTMLInputElement | null)
          ?.value === 'system';
      const needsSudo = opts.sudoRequired === true || (opts.showSystemChoice === true && system);
      const sudo = sudoInput?.value ?? '';
      if (needsSudo && !sudo) {
        if (sudoInput) {
          sudoInput.style.borderColor = 'var(--error)';
          sudoInput.focus();
        }
        return;
      }
      done({ ok: true, system, sudo });
    });
    overlay.querySelector('[data-skip]')?.addEventListener('click', () => done(null));
    sudoInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (overlay.querySelector('[data-confirm]') as HTMLButtonElement)?.click();
    });
    document.body.appendChild(overlay);
    (overlay.querySelector('[data-confirm]') as HTMLButtonElement | null)?.focus();
  });
}

// ==================== 主流程 ====================

/**
 * 会话就绪后在已保存服务器上执行 Agent 引导。
 * 只在：已登录 + P2P 开放 + 当前为中继传输 + 非 Windows 目标 + 未拒绝过时运行。
 */
export async function runAgentBootstrap(opts: {
  terminal: SSHTerminal;
  server: ServerConfig;
  upgrade: P2PUpgradeFn;
}): Promise<void> {
  const { terminal, server, upgrade } = opts;
  if (bootstrapped.has(terminal)) return;
  bootstrapped.add(terminal);
  try {
    await run(terminal, server, upgrade);
  } catch {
    /* 引导失败永远静默回落中继 */
  } finally {
    terminal.setBootstrapHandler(undefined);
  }
}

async function run(terminal: SSHTerminal, server: ServerConfig, upgrade: P2PUpgradeFn) {
  const config = await getPublicConfig();
  if (config?.p2pEnabled !== true) return;
  if (terminal.isP2P()) return;
  if (isDeclined(server.id)) return;
  // Windows 目标无法跑 POSIX 探测；os 未知时照常尝试（失败静默）
  if (server.os === 'windows') return;

  // 已绑定且在线 → 直接升级，连探测都省掉
  if (server.agent_id) {
    const bound = (await fetchAgents()).find((a) => a.id === server.agent_id);
    if (bound && isAgentOnline(bound)) {
      await upgradeAndReport(terminal, bound.id, upgrade);
      return;
    }
    // 绑定的是非回环「网关」Agent（装在其他机器上）且离线 → 目标机与该 Agent
    // 无关，不应再提示在目标机上安装；静默保持中继。
    if (server.agent_loopback !== 1) return;
    // 回环绑定 Agent 离线 → 继续探测远端，可能只是服务停了
  }

  terminal.writeBootstrapStatus(t('agent.bootProbing'));
  const probeMsg = (await sendAndAwait(
    terminal,
    { type: 'agent_probe' },
    'agent_probe_result',
    PROBE_TIMEOUT_MS
  )) as ProbeResultMsg | null;
  if (!probeMsg?.ok) {
    terminal.writeBootstrapStatus(t('agent.bootProbeFailed'));
    return;
  }

  // ---------- 已安装 + 运行中：直接绑定升级 ----------
  if (probeMsg.installed && probeMsg.running) {
    // probe 读不到 env 时只能信任「本机回环绑定」的旧值：网关 Agent 不在目标机上，
    // 绝不能把它错绑成 loopback。
    const aid =
      probeMsg.agentId || (server.agent_loopback === 1 ? server.agent_id || '' : '');
    if (!aid) {
      terminal.writeBootstrapStatus(t('agent.bootRunningForeign'));
      return;
    }
    if (!(await bindServerAgent(server, aid))) {
      terminal.writeBootstrapStatus(t('agent.bootBindFailed'));
      return;
    }
    // 进程在跑不代表已向本站注册（信令被墙/旧 token）——给 15s 等心跳，
    // 不上线仍绑定（下次直接用）但本次不白试升级
    if (!(await waitAgentOnline(aid, 15_000))) {
      terminal.writeBootstrapStatus(t('agent.bootOffline'));
      return;
    }
    await upgradeAndReport(terminal, aid, upgrade);
    return;
  }

  // ---------- 已安装 + 未运行：询问后启动 ----------
  if (probeMsg.installed && !probeMsg.running) {
    const needsSudo = probeMsg.service === 'systemd-system';
    const consent = await promptBootstrapDialog({
      title: t('agent.bootStartTitle'),
      desc: t('agent.bootStartDesc'),
      confirmText: t('agent.bootStartConfirm'),
      sudoRequired: needsSudo,
    });
    if (!consent) {
      markDeclined(server.id);
      return;
    }
    terminal.writeBootstrapStatus(t('agent.bootStarting'));
    const res = await sendAndAwait(
      terminal,
      { type: 'agent_start', sudo: consent.sudo || undefined },
      'agent_start_result',
      START_TIMEOUT_MS
    );
    if (!res?.ok) {
      terminal.writeBootstrapStatus(t('agent.bootStartFailed'));
      return;
    }
    const aid =
      probeMsg.agentId || (server.agent_loopback === 1 ? server.agent_id || '' : '');
    if (!aid) {
      // 无 env 文件 → 无法得知 Agent 注册身份，绑定无从谈起
      terminal.writeBootstrapStatus(t('agent.bootStartedNoBind'));
      return;
    }
    terminal.writeBootstrapStatus(t('agent.bootWaiting'));
    if (!(await waitAgentOnline(aid))) {
      terminal.writeBootstrapStatus(t('agent.bootOffline'));
      return;
    }
    if (!(await bindServerAgent(server, aid))) {
      terminal.writeBootstrapStatus(t('agent.bootBindFailed'));
      return;
    }
    await upgradeAndReport(terminal, aid, upgrade);
    return;
  }

  // ---------- 未安装：询问后安装 ----------
  const consent = await promptBootstrapDialog({
    title: t('agent.bootInstallTitle'),
    desc: t('agent.bootInstallDesc'),
    confirmText: t('agent.bootInstallConfirm'),
    showSystemChoice: true,
  });
  if (!consent) {
    markDeclined(server.id);
    return;
  }
  const agent = await createAgent(server.name || server.host || 'cloudssh-agent');
  if (!agent) return;

  const origin = window.location.origin;
  // Agent 回连源与站点同源（生产=自定义域名，workers.dev 不用于生产）
  const agentServer = origin;
  terminal.writeBootstrapStatus(t('agent.bootInstalling'));
  const res = await sendAndAwait(
    terminal,
    {
      type: 'agent_install',
      token: agent.token,
      installBase: agentServer,
      agentServer,
      system: consent.system,
      sudo: consent.sudo || undefined,
    },
    'agent_install_result',
    INSTALL_TIMEOUT_MS
  );
  if (!res?.ok) {
    const detail = typeof res?.logTail === 'string' ? res.logTail.slice(-300) : '';
    terminal.writeBootstrapStatus(
      `${t('agent.bootInstallFailed')}${detail ? ` — ${detail.split('\n').pop()}` : ''}`
    );
    return;
  }
  terminal.writeBootstrapStatus(t('agent.bootWaiting'));
  if (!(await waitAgentOnline(agent.id))) {
    terminal.writeBootstrapStatus(t('agent.bootOffline'));
    return;
  }
  if (!(await bindServerAgent(server, agent.id))) {
    terminal.writeBootstrapStatus(t('agent.bootBindFailed'));
    return;
  }
  await upgradeAndReport(terminal, agent.id, upgrade);
}

async function upgradeAndReport(
  terminal: SSHTerminal,
  agentId: string,
  upgrade: P2PUpgradeFn
): Promise<void> {
  terminal.writeBootstrapStatus(t('agent.bootUpgrading'));
  const ok = await upgrade(agentId);
  if (ok) {
    notify(t('agent.bootUpgraded'), { variant: 'success' });
  } else {
    terminal.writeBootstrapStatus(t('agent.bootUpgradeFailed'));
  }
}
