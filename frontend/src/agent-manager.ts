// P2P Agent 管理面板与连接传输偏好。
// 模板 innerHTML 站点均带 pi-lens-ignore：动态值均经 escapeHtml 转义。
import { localizedApiError } from './api-errors';
import { copyTextToClipboard } from './clipboard';
import { t } from './i18n';
import { confirmAction, notify } from './ui-feedback';

export interface AgentSummary {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  last_seen_version: string | null;
}

export type ConnectMode = 'relay' | 'p2p';

const MODE_KEY = 'cloudssh.p2p.mode';
const AGENT_KEY = 'cloudssh.p2p.agentId';
/** Agent 上线后提示切换 P2P，用户拒绝过则不再打扰。 */
const SWITCH_DECLINED_KEY = 'cloudssh.p2p.switchDeclined';
/** Agent 心跳节流 60s：超过该窗口未见心跳视为离线（UI 提示口径）。 */
const ONLINE_WINDOW_MS = 150_000;

export interface P2PPreference {
  mode: ConnectMode;
  agentId: string | null;
}

export function getP2PPreference(): P2PPreference {
  try {
    const mode = localStorage.getItem(MODE_KEY) === 'p2p' ? 'p2p' : 'relay';
    const agentId = localStorage.getItem(AGENT_KEY);
    return { mode, agentId: agentId || null };
  } catch {
    return { mode: 'relay', agentId: null };
  }
}

export function setP2PPreference(pref: P2PPreference): void {
  try {
    localStorage.setItem(MODE_KEY, pref.mode);
    if (pref.agentId) {
      localStorage.setItem(AGENT_KEY, pref.agentId);
    } else {
      localStorage.removeItem(AGENT_KEY);
    }
  } catch {
    /* 隐私模式下偏好不持久化 */
  }
}

export function isAgentOnline(agent: AgentSummary): boolean {
  return typeof agent.last_seen_at === 'number' && Date.now() - agent.last_seen_at < ONLINE_WINDOW_MS;
}

function switchDeclined(): boolean {
  try {
    return localStorage.getItem(SWITCH_DECLINED_KEY) === '1';
  } catch {
    return true;
  }
}

function markSwitchDeclined(): void {
  try {
    localStorage.setItem(SWITCH_DECLINED_KEY, '1');
  } catch {
    /* 忽略 */
  }
}

/** 生成内嵌 token 与站点源的一键安装命令（Linux/macOS、Windows、手动 Node）。 */
function installCommands(token: string): { unix: string; windows: string; manual: string } {
  const base = window.location.origin;
  return {
    unix: `curl -fsSL ${base}/install.sh | sh -s -- --token ${token}`,
    windows: `iex "& { $(irm ${base}/install.ps1) } -Token '${token}'"`,
    manual: `node agent/dist/agent.js --token ${token}`,
  };
}

function escapeHtml(value: string): string {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function formatLastSeen(value: number | null): string {
  if (!value) return t('agent.neverSeen');
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 90) return t('agent.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('agent.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t('agent.hoursAgo', { count: hours });
  return new Date(value).toLocaleString();
}

/**
 * Agent 管理弹窗：列出已注册 Agent、创建新 Agent（令牌仅展示一次）、
 * 删除 Agent，并维护「中继 / P2P」连接传输偏好。
 */
export class AgentManager {
  private agents: AgentSummary[] = [];
  private pref: P2PPreference = getP2PPreference();

  async open(): Promise<void> {
    this.pref = getP2PPreference();
    this.ensureModal();
    const modal = document.getElementById('agent-manager-modal');
    modal?.classList.remove('hidden');
    modal?.classList.add('flex');
    this.renderPreference();
    await this.loadAgents();
  }

  private ensureModal(): void {
    if (document.getElementById('agent-manager-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'agent-manager-modal';
    modal.className = 'responsive-modal hidden fixed inset-0 z-[120] items-center justify-center';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    // pi-lens-ignore: no-inner-html
    modal.innerHTML = `
      <div class="modal-overlay absolute inset-0" data-agent-close></div>
      <div class="responsive-modal-panel cyber-box p-6 shadow-2xl relative z-10 w-full max-w-2xl mx-4 max-h-[85vh] overflow-y-auto custom-scrollbar">
        <div class="flex items-center justify-between mb-5 pb-4 border-b border-dim">
          <div>
            <h2 class="text-sm font-bold text-primary">${t('agent.manageTitle')}</h2>
            <p class="text-xs text-muted mt-1">${t('agent.manageHint')}</p>
          </div>
          <button type="button" data-agent-close class="panel-close-btn" aria-label="${t('common.close')}"><span class="material-symbols-outlined">close</span></button>
        </div>

        <div class="mb-5">
          <h3 class="text-xs font-bold text-on-surface mb-2">${t('agent.connectMode')}</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label class="text-xs text-muted">${t('agent.transport')}
              <select id="agent-mode-select" class="terminal-input w-full mt-1">
                <option value="relay">${t('agent.modeRelay')}</option>
                <option value="p2p">${t('agent.modeP2p')}</option>
              </select>
            </label>
            <label class="text-xs text-muted">${t('agent.preferredAgent')}
              <select id="agent-preferred-select" class="terminal-input w-full mt-1"></select>
            </label>
          </div>
        </div>

        <div class="mb-5">
          <h3 class="text-xs font-bold text-on-surface mb-2">${t('agent.createTitle')}</h3>
          <div class="flex gap-2">
            <input id="agent-name-input" type="text" maxlength="64" class="terminal-input flex-1" placeholder="${t('agent.namePlaceholder')}" />
            <button id="agent-create-btn" type="button" class="cyber-button text-primary px-4 py-2 text-xs font-bold">${t('agent.create')}</button>
          </div>
          <div id="agent-token-box" class="hidden mt-3 p-3 border border-dim rounded bg-black/20">
            <p class="text-xs text-warning mb-2">${t('agent.tokenNotice')}</p>
            <code id="agent-token-value" class="block text-xs break-all text-on-surface select-all"></code>
            <div class="flex gap-2 mt-2">
              <button id="agent-token-copy" type="button" class="cyber-button text-primary px-3 py-1.5 text-xs">${t('agent.copyToken')}</button>
            </div>
            <div class="mt-3">
              <p class="text-xs font-bold text-on-surface mb-1">${t('agent.installTitle')}</p>
              <p class="text-xs text-muted mb-2">${t('agent.installHint')}</p>
              <div class="space-y-2">
                <div>
                  <p class="text-xs text-muted mb-1">${t('agent.installUnix')}</p>
                  <div class="flex items-start gap-1.5">
                    <code id="agent-install-unix" class="flex-1 text-xs break-all text-on-surface bg-black/30 p-2 rounded select-all"></code>
                    <button type="button" data-copy-install="unix" class="panel-close-btn shrink-0" aria-label="${t('agent.copyInstall')}"><span class="material-symbols-outlined" style="font-size: 16px">content_copy</span></button>
                  </div>
                </div>
                <div>
                  <p class="text-xs text-muted mb-1">${t('agent.installWindows')}</p>
                  <div class="flex items-start gap-1.5">
                    <code id="agent-install-windows" class="flex-1 text-xs break-all text-on-surface bg-black/30 p-2 rounded select-all"></code>
                    <button type="button" data-copy-install="windows" class="panel-close-btn shrink-0" aria-label="${t('agent.copyInstall')}"><span class="material-symbols-outlined" style="font-size: 16px">content_copy</span></button>
                  </div>
                </div>
                <div>
                  <p class="text-xs text-muted mb-1">${t('agent.installManual')}</p>
                  <div class="flex items-start gap-1.5">
                    <code id="agent-install-manual" class="flex-1 text-xs break-all text-on-surface bg-black/30 p-2 rounded select-all"></code>
                    <button type="button" data-copy-install="manual" class="panel-close-btn shrink-0" aria-label="${t('agent.copyInstall')}"><span class="material-symbols-outlined" style="font-size: 16px">content_copy</span></button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <h3 class="text-xs font-bold text-on-surface mb-2">${t('agent.listTitle')}</h3>
          <div id="agent-list" class="space-y-2"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('[data-agent-close]').forEach((el) => {
      el.addEventListener('click', () => this.close());
    });
    document.getElementById('agent-create-btn')?.addEventListener('click', () => {
      void this.createAgent();
    });
    document.getElementById('agent-token-copy')?.addEventListener('click', () => {
      const value = document.getElementById('agent-token-value')?.textContent ?? '';
      void copyTextToClipboard(value).then((ok) => {
        if (ok) notify(t('agent.tokenCopied'), { variant: 'success' });
      });
    });
    modal.querySelectorAll('[data-copy-install]').forEach((el) => {
      el.addEventListener('click', () => {
        const kind = (el as HTMLElement).dataset.copyInstall ?? '';
        const value = document.getElementById(`agent-install-${kind}`)?.textContent ?? '';
        void copyTextToClipboard(value).then((ok) => {
          if (ok) notify(t('agent.installCopied'), { variant: 'success' });
        });
      });
    });
    document.getElementById('agent-mode-select')?.addEventListener('change', (e) => {
      this.pref.mode = (e.target as HTMLSelectElement).value === 'p2p' ? 'p2p' : 'relay';
      setP2PPreference(this.pref);
      this.renderPreference();
    });
    document.getElementById('agent-preferred-select')?.addEventListener('change', (e) => {
      this.pref.agentId = (e.target as HTMLSelectElement).value || null;
      setP2PPreference(this.pref);
    });
  }

  close(): void {
    const modal = document.getElementById('agent-manager-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
  }

  private renderPreference(): void {
    const modeSelect = document.getElementById('agent-mode-select') as HTMLSelectElement | null;
    if (modeSelect) modeSelect.value = this.pref.mode;
    const preferred = document.getElementById('agent-preferred-select') as HTMLSelectElement | null;
    if (!preferred) return;
    preferred.disabled = this.pref.mode !== 'p2p';
    // pi-lens-ignore: no-inner-html
    preferred.innerHTML =
      `<option value="">${t('agent.autoPick')}</option>` +
      this.agents
        .map(
          (a) =>
            `<option value="${escapeHtml(a.id)}"${a.id === this.pref.agentId ? ' selected' : ''}>${escapeHtml(a.name)}</option>`
        )
        .join('');
    if (this.pref.agentId && !this.agents.some((a) => a.id === this.pref.agentId)) {
      preferred.value = '';
    }
  }

  private async loadAgents(): Promise<void> {
    const list = document.getElementById('agent-list');
    if (list) {
      // pi-lens-ignore: no-inner-html
      list.innerHTML = `<p class="text-xs text-muted">${t('agent.loading')}</p>`;
    }
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`(${res.status})`);
      const body = (await res.json()) as { agents?: AgentSummary[] };
      this.agents = Array.isArray(body.agents) ? body.agents : [];
    } catch {
      this.agents = [];
      if (list) {
        // pi-lens-ignore: no-inner-html
        list.innerHTML = `<p class="text-xs text-error">${t('agent.loadFailed')}</p>`;
      }
      this.renderPreference();
      return;
    }
    this.renderAgents();
    this.renderPreference();
    this.maybePromptP2PSwitch();
  }

  /** Agent 首次上线时询问是否把连接方式切到 P2P；拒绝一次后不再打扰。 */
  private maybePromptP2PSwitch(): void {
    if (this.pref.mode !== 'relay' || switchDeclined()) return;
    const online = this.agents.find(isAgentOnline);
    if (!online) return;
    void confirmAction({
      title: t('agent.switchTitle'),
      message: t('agent.switchPrompt'),
      confirmText: t('agent.modeP2p'),
      variant: 'info',
    }).then((confirmed) => {
      if (confirmed) {
        this.pref = { mode: 'p2p', agentId: this.pref.agentId ?? online.id };
        setP2PPreference(this.pref);
        this.renderPreference();
        notify(t('agent.switched'), { variant: 'success' });
      } else {
        markSwitchDeclined();
      }
    });
  }

  private renderAgents(): void {
    const list = document.getElementById('agent-list');
    if (!list) return;
    if (this.agents.length === 0) {
      // pi-lens-ignore: no-inner-html
      list.innerHTML = `<p class="text-xs text-muted">${t('agent.empty')}</p>`;
      return;
    }
    // pi-lens-ignore: no-inner-html
    list.innerHTML = this.agents
      .map((agent) => {
        const online = isAgentOnline(agent);
        const dot = online
          ? '<span class="inline-block w-2 h-2 rounded-full bg-[var(--color-primary)]"></span>'
          : '<span class="inline-block w-2 h-2 rounded-full bg-surface-dot"></span>';
        const status = online ? t('agent.online') : t('agent.offline');
        const version = agent.last_seen_version ? ` · ${escapeHtml(agent.last_seen_version)}` : '';
        return `
        <div class="flex items-center justify-between p-3 border border-dim rounded">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-xs text-on-surface font-bold truncate">${dot}${escapeHtml(agent.name)}</div>
            <div class="text-xs text-muted mt-1">${status} · ${t('agent.lastSeen')}: ${formatLastSeen(agent.last_seen_at)}${version}</div>
          </div>
          <button type="button" data-agent-delete="${escapeHtml(agent.id)}" class="panel-close-btn" aria-label="${t('common.delete')}"><span class="material-symbols-outlined">delete</span></button>
        </div>`;
      })
      .join('');
    list.querySelectorAll('[data-agent-delete]').forEach((el) => {
      el.addEventListener('click', () => {
        void this.deleteAgent((el as HTMLElement).dataset.agentDelete ?? '');
      });
    });
  }

  private async createAgent(): Promise<void> {
    const input = document.getElementById('agent-name-input') as HTMLInputElement | null;
    const name = input?.value.trim() ?? '';
    if (!name) {
      notify(t('agent.nameRequired'), { variant: 'warning' });
      return;
    }
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        token?: string;
        error?: string;
      };
      if (!res.ok || !body.token) {
        throw new Error(localizedApiError(body, 'agent.createFailed'));
      }
      if (input) input.value = '';
      const tokenBox = document.getElementById('agent-token-box');
      const tokenValue = document.getElementById('agent-token-value');
      if (tokenValue) tokenValue.textContent = body.token;
      // 填充一键安装命令：token 与站点源已内嵌，用户复制粘贴一条即可
      const commands = installCommands(body.token);
      const unixEl = document.getElementById('agent-install-unix');
      const winEl = document.getElementById('agent-install-windows');
      const manEl = document.getElementById('agent-install-manual');
      if (unixEl) unixEl.textContent = commands.unix;
      if (winEl) winEl.textContent = commands.windows;
      if (manEl) manEl.textContent = commands.manual;
      tokenBox?.classList.remove('hidden');
      // 新建 Agent 自动成为首选（用户刚创建它就是要用）
      if (body.id) {
        this.pref.agentId = body.id;
        setP2PPreference(this.pref);
      }
      await this.loadAgents();
    } catch (e) {
      notify(e instanceof Error ? e.message : t('agent.createFailed'), { variant: 'danger' });
    }
  }

  private async deleteAgent(agentId: string): Promise<void> {
    if (!agentId) return;
    const confirmed = await confirmAction({
      title: t('agent.deleteTitle'),
      message: t('agent.deleteMessage'),
      confirmText: t('common.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(localizedApiError(body, 'agent.deleteFailed'));
      }
      if (this.pref.agentId === agentId) {
        this.pref.agentId = null;
        setP2PPreference(this.pref);
      }
      await this.loadAgents();
    } catch (e) {
      notify(e instanceof Error ? e.message : t('agent.deleteFailed'), { variant: 'danger' });
    }
  }
}
