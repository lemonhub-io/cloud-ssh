import { getP2PPreference } from './agent-manager';
import { runAgentBootstrap } from './agent-bootstrap';
import { ConnectionForm } from './auth-form';
import { initI18n, onLocaleChange, t } from './i18n';
import { MobileTerminalController } from './mobile-terminal';
import { getPublicConfig } from './public-config';
import { ServerList } from './server-list';
import {
  appendP2PParams,
  openSessionChannel,
  type SessionTransportLike,
} from './session-transport';
import {
  type ClaimedShare,
  renderShareEnded,
  renderShareLanding,
  takeShareTokenFromLocation,
} from './share-session';
import { SnippetManager } from './snippet-manager';
import { TabManager } from './tab-manager';
import type { SSHHostInfo, SSHTerminal } from './terminal';
import {
  applyBuiltInTheme,
  applyImportedTheme,
  type BuiltInThemeName,
  isBuiltInTheme,
  normalizeImportedTheme,
  THEME_MAX_BYTES,
} from './theme';
import { LiquidSegmentedThemeControl } from './theme-segmented';
import { LiquidSegmentedDrawerControl } from './drawer-segmented';
import { notify } from './ui-feedback';

// ==================== 全局状态 ====================

let tabManager: TabManager | null = null;
let connectionForm: ConnectionForm | null = null;
let serverList: ServerList | null = null;
let isLoggedIn = false;
let sharedSessionMode = false;
const mobileTerminalController = new MobileTerminalController(
  () => tabManager?.getActiveTab()?.terminal ?? null
);
const snippetManager = new SnippetManager({
  getTerminal: () => tabManager?.getActiveTab()?.terminal ?? null,
  isAuthenticated: () => isLoggedIn && !sharedSessionMode,
  onStateChange: () => syncDrawerSegmentedControl(),
});

function setUserSpaceMenuOpen(open: boolean): void {
  document.getElementById('user-space-header-actions')?.classList.toggle('is-open', open);
  document.getElementById('user-space-more-btn')?.setAttribute('aria-expanded', String(open));
}

function initUserSpaceMobileMenu(): void {
  const button = document.getElementById('user-space-more-btn');
  const menu = document.getElementById('user-space-header-actions');
  if (!button || !menu) return;

  button.addEventListener('click', () => {
    setUserSpaceMenuOpen(!menu.classList.contains('is-open'));
  });
  menu.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) setUserSpaceMenuOpen(false);
  });
  menu.addEventListener('change', () => setUserSpaceMenuOpen(false));
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Node | null;
      if (target && (button.contains(target) || menu.contains(target))) return;
      setUserSpaceMenuOpen(false);
    },
    true
  );
}

function initServerPaginationBreakpoints(): void {
  const queries = [
    window.matchMedia('(max-width: 767px)'),
    window.matchMedia('(max-width: 1180px) and (pointer: coarse)'),
  ];
  for (const query of queries) {
    query.addEventListener('change', () => serverList?.refreshPageSize());
  }
}

/** 获取或初始化 TabManager 单例 */
function getTabManager(): TabManager {
  if (!tabManager) {
    tabManager = new TabManager('tab-bar', 'terminal-area');
    tabManager.setAllTabsClosedHandler(() => {
      showOfflineUI();
    });
    // 连接后检测到操作系统 → 即时更新服务器列表卡片图标
    tabManager.setOSDetectedHandler((serverId, os) => {
      serverList?.updateServerOS(serverId, os);
    });
    // 标签数量变化 → 同步“返回终端”按钮显隐
    tabManager.setTabsChangedHandler(() => {
      syncConnectionBackButtons();
    });
    // 右键标签页克隆会话
    tabManager.setDuplicateTabHandler(async (tab) => {
      const serverId = tab.hostInfo?.serverId;
      if (!serverId) {
        notify(t('terminal.duplicateAnonymousUnsupported'), { variant: 'warning' });
        return;
      }
      try {
        const ws = await requestSavedServerChannel(serverId);
        const { terminal } = showTerminalWithNewTab(tab.label, tab.hostInfo);
        terminal.mount();
        const reconnectFactory = () => requestSavedServerChannel(serverId);
        wireAgentBootstrap(terminal, serverId, tab.hostInfo, reconnectFactory);
        terminal.connectWithWebSocket(ws, tab.hostInfo, { reconnectFactory });
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), { variant: 'danger' });
      }
    });

    // 绑定 new-tab-btn
    bindNewTabButton();
  }
  return tabManager;
}

function bindNewTabButton(): void {
  // 使用事件委托，因为 TabManager.renderTabBar() 会重建按钮
  document.getElementById('tab-bar')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('#new-tab-btn');
    if (!btn) return;
    // 点击 + 按钮：回到连接页面以创建新连接
    showConnectionPage();
  });
}

function syncConnectionBackButtons(): void {
  const hasTabs = tabManager?.hasAnyTab() ?? false;
  document.getElementById('back-to-terminal-btn')?.classList.toggle('hidden', !hasTabs);
  document.getElementById('back-to-terminal-from-auth-btn')?.classList.toggle('hidden', !hasTabs);
}

function activateTerminalView(): void {
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('server-modal')?.classList.add('hidden');
  document.getElementById('server-modal')?.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.remove('hidden');
  document.getElementById('terminal-section')!.classList.add('flex');
  document.body.classList.add('terminal-active');
  requestAnimationFrame(() => {
    terminalDrawerControl?.refresh();
  });
}

function showTerminalSection(): void {
  if (!tabManager || !tabManager.hasAnyTab()) return;
  activateTerminalView();
  tabManager.getActiveTab()?.terminal.fit();
}

function bindBackToTerminalButtons(): void {
  document.getElementById('back-to-terminal-btn')?.addEventListener('click', () => {
    showTerminalSection();
  });
  document.getElementById('back-to-terminal-from-auth-btn')?.addEventListener('click', () => {
    showTerminalSection();
  });
  // 支持 Esc 快速返回已有的终端会话
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const terminalHidden =
      document.getElementById('terminal-section')?.classList.contains('hidden') ?? true;
    if (!terminalHidden) return;
    if (!tabManager?.hasAnyTab()) return;
    const activeModal = document.getElementById('server-modal');
    // 若服务器编辑弹窗打开，优先关闭弹窗而非返回终端
    if (activeModal && !activeModal.classList.contains('hidden')) return;
    event.preventDefault();
    showTerminalSection();
  });
}

// ==================== 独立终端标签页模式 ====================

function isTerminalTab(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('wsUrl');
}

function validateWsUrl(wsUrl: string): boolean {
  try {
    const url = new URL(wsUrl);
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return false;
    return (
      url.origin === window.location.origin ||
      url.origin === window.location.origin.replace(/^http/, 'ws')
    );
  } catch {
    return false;
  }
}

function initTerminalTab(): void {
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get('wsUrl')!;
  const serverName = params.get('name') || 'Server';
  const host = params.get('host') || '';
  const port = parseInt(params.get('port') || '0', 10) || 0;

  if (!validateWsUrl(wsUrl)) {
    const errorDiv = document.createElement('div');
    errorDiv.style.color = 'var(--error)';
    errorDiv.style.padding = '2em';
    errorDiv.style.fontFamily = 'monospace';
    errorDiv.textContent = t('terminal.invalidUrl');
    document.body.replaceChildren(errorDiv);
    return;
  }

  // 隐藏所有非终端元素
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.remove('hidden');
  document.getElementById('terminal-section')!.classList.add('flex');
  document.body.classList.add('terminal-active');

  // 隐藏标签栏（URL 直连模式只有一个标签，不需要标签栏）
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.display = 'none';

  const tm = getTabManager();
  const tab = tm.createTab(serverName, host && port ? { host, port } : undefined);

  const hostInfo = host && port ? { host, port } : undefined;
  void openSessionChannel(wsUrl)
    .then((transport) => tab.terminal.connectWithWebSocket(transport, hostInfo))
    .catch(() => {
      const errorDiv = document.createElement('div');
      errorDiv.style.color = 'var(--error)';
      errorDiv.style.padding = '2em';
      errorDiv.style.fontFamily = 'monospace';
      errorDiv.textContent = t('terminal.invalidUrl');
      document.body.replaceChildren(errorDiv);
    });
}

// ==================== 页面切换 ====================

function deactivateTerminalView(): void {
  mobileTerminalController.leaveTerminal();
  document.getElementById('terminal-section')!.classList.add('hidden');
  document.getElementById('terminal-section')!.classList.remove('flex');
  document.body.classList.remove('terminal-active');
}

function showAuthSection(): void {
  deactivateTerminalView();
  document.getElementById('auth-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('server-modal')!.classList.add('hidden');
  document.getElementById('server-modal')!.classList.remove('flex');

  if (!connectionForm) {
    connectionForm = new ConnectionForm({
      getTabManager,
    });
  }
  syncConnectionBackButtons();
}

function showUserSpace(user: {
  id: number;
  github_id: number;
  username: string;
  avatar_url: string;
}): void {
  deactivateTerminalView();
  isLoggedIn = true;
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('flex');
  requestAnimationFrame(() => {
    userThemeSegmentedControl?.refresh();
  });

  serverList = new ServerList(
    user,
    // onLogout 回调
    () => {
      isLoggedIn = false;
      serverList = null;
      if (tabManager) {
        tabManager.closeAllTabs();
      }
      showAuthSection();
    },
    // onConnect 回调 — 在当前页面创建新标签
    (wsUrl: string, serverName: string, hostInfo?: SSHHostInfo) => {
      showTerminalFromServer(wsUrl, serverName, hostInfo);
    }
  );
}

/** 显示连接页面（匿名 → auth-form，登录 → 服务器列表） */
function showConnectionPage(): void {
  // 如果还有活跃标签，不需要隐藏终端区域；只需要覆盖显示连接页面
  // 但为了简单起见，我们先切回对应的入口页面
  if (isLoggedIn) {
    deactivateTerminalView();
    document.getElementById('user-space-section')!.classList.remove('hidden');
    document.getElementById('user-space-section')!.classList.add('flex');
    requestAnimationFrame(() => {
      userThemeSegmentedControl?.refresh();
    });
  } else {
    showAuthSection();
  }
  syncConnectionBackButtons();
}

function showOfflineUI(): void {
  if (sharedSessionMode) {
    deactivateTerminalView();
    renderShareEnded();
    return;
  }
  if (isTerminalTab()) {
    mobileTerminalController.leaveTerminal();
    window.close();
    return;
  }

  // 如果还有其他标签，不回到连接页
  if (tabManager && tabManager.hasAnyTab()) {
    return;
  }

  deactivateTerminalView();

  if (isLoggedIn) {
    document.getElementById('user-space-section')?.classList.remove('hidden');
    document.getElementById('user-space-section')?.classList.add('flex');
  } else {
    showAuthSection();
  }

  const statusText = document.getElementById('status-text');
  if (statusText) {
    const dot = document.createElement('span');
    dot.className = 'w-2 h-2 bg-surface-dot inline-block';
    statusText.replaceChildren(dot, document.createTextNode(t('auth.statusOffline')));
  }
}

/** 在终端页面创建新标签并显示终端视图 */
function showTerminalWithNewTab(
  displayLabel: string,
  hostInfo?: SSHHostInfo
): { tab: ReturnType<TabManager['createTab']>; terminal: SSHTerminal } {
  activateTerminalView();

  const tm = getTabManager();
  const tab = tm.createTab(displayLabel, hostInfo);

  return { tab, terminal: tab.terminal };
}

async function showTerminalFromServer(
  wsUrl: string,
  serverName: string,
  hostInfo?: SSHHostInfo
): Promise<void> {
  if (!validateWsUrl(wsUrl)) {
    notify(t('server.invalidWs'), {
      title: t('server.connectFailed'),
      variant: 'danger',
    });
    return;
  }

  const { terminal } = showTerminalWithNewTab(serverName, hostInfo);

  terminal.mount();

  // 传输选择：服务器已绑定 Agent → 走 P2P（目标 Agent 即绑定 Agent）；
  // 未绑定但用户选了全局 P2P 偏好 → 走偏好 Agent；否则中继。
  // 信令失败经重新铸 token 回退中继。
  const serverId = hostInfo?.serverId;
  const server = serverId ? serverList?.getServer(serverId) : undefined;
  const p2pEnabled = (await getPublicConfig())?.p2pEnabled === true;
  const pref = getP2PPreference();
  const boundAgent = server?.agent_id || null;
  const wantP2P = p2pEnabled && (boundAgent !== null || pref.mode === 'p2p');
  const targetUrl = wantP2P ? appendP2PParams(wsUrl, boundAgent ?? pref.agentId) : wsUrl;

  let transport: SessionTransportLike;
  try {
    transport = await openSessionChannel(targetUrl, async () => {
      if (!serverId) throw new Error(t('server.invalidWs'));
      return fetchSavedServerWsUrl(serverId);
    });
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), {
      title: t('server.connectFailed'),
      variant: 'danger',
    });
    return;
  }

  const reconnectFactory = serverId
    ? () => requestSavedServerChannel(serverId)
    : undefined;
  wireAgentBootstrap(terminal, serverId, hostInfo, reconnectFactory);
  terminal.connectWithWebSocket(transport, hostInfo, { reconnectFactory });
}

async function showSharedTerminal(claim: ClaimedShare): Promise<void> {
  if (!validateWsUrl(claim.wsUrl)) {
    renderShareEnded();
    return;
  }
  sharedSessionMode = true;
  isLoggedIn = false;
  document.getElementById('snippet-toggle-btn')?.classList.add('hidden');
  document.getElementById('mobile-snippets-btn')?.classList.add('hidden');
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.display = 'none';
  const { terminal } = showTerminalWithNewTab(claim.serverName);
  terminal.mount();

  // 分享 P2P：owner 有在线 Agent 时经 DataChannel 直连；Agent 离线时服务端
  // 透明回退中继，RtcTransport 检测到非信令首帧后收养该 WS 为中继传输。
  // ticket 一次性消费，不可重铸——不提供 refetch 回退。
  const p2pEnabled = (await getPublicConfig())?.p2pEnabled === true;
  const targetUrl = p2pEnabled ? appendP2PParams(claim.wsUrl) : claim.wsUrl;
  let transport: SessionTransportLike;
  try {
    transport = await openSessionChannel(targetUrl);
  } catch {
    renderShareEnded();
    return;
  }
  // 分享会话：仅允许秒级恢复（ticket 已一次性消费，完整重连不可能），
  // 恢复彻底失败时在终端内宣告分享结束。
  terminal.connectWithWebSocket(transport, undefined, { resumeOnly: true });
}

/** 铸一次性连接 token 并换取会话 WebSocket URL（每次调用产生新 token）。 */
async function fetchSavedServerWsUrl(serverId: number): Promise<string> {
  const response = await fetch(`/api/servers/${serverId}/connect`, { method: 'POST' });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    const message = contentType.includes('application/json')
      ? ((await response.json()) as { error?: string }).error
      : null;
    throw new Error(message || `Connection failed (${response.status})`);
  }

  const { wsUrl } = (await response.json()) as { wsUrl?: unknown };
  if (typeof wsUrl !== 'string' || !validateWsUrl(wsUrl)) {
    throw new Error(t('server.invalidWs'));
  }
  return wsUrl;
}

/**
 * 打开已保存服务器的会话传输：已绑定 Agent 的服务器走 P2P 信令；
 * 未绑定但用户有全局 P2P 偏好时走偏好 Agent；其余中继。
 * token 在首次升级即被消费，信令失败时重新铸 token 回退中继。
 */
async function requestSavedServerChannel(serverId: number): Promise<SessionTransportLike> {
  const wsUrl = await fetchSavedServerWsUrl(serverId);
  const p2pEnabled = (await getPublicConfig())?.p2pEnabled === true;
  const pref = getP2PPreference();
  const boundAgent = serverList?.getServer(serverId)?.agent_id || null;
  const wantP2P = p2pEnabled && (boundAgent !== null || pref.mode === 'p2p');
  if (!wantP2P) {
    const socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';
    return socket;
  }
  return openSessionChannel(appendP2PParams(wsUrl, boundAgent ?? pref.agentId), () =>
    fetchSavedServerWsUrl(serverId)
  );
}

// ==================== Agent 引导（bootstrap） ====================

/**
 * 中继会话就绪后启动 Agent 引导：探测远端 → 询问安装/启动 → 绑定 →
 * 自动升级为 P2P 会话。仅登录用户的已保存服务器参与；匿名/分享/P2P 会话跳过。
 */
function wireAgentBootstrap(
  terminal: SSHTerminal,
  serverId: number | undefined,
  hostInfo: SSHHostInfo | undefined,
  reconnectFactory?: () => Promise<SessionTransportLike>
): void {
  if (!serverId || !isLoggedIn) return;
  const server = serverList?.getServer(serverId);
  if (!server) return;
  terminal.setAgentBootstrapReadyHandler(() => {
    void runAgentBootstrap({
      terminal,
      server,
      upgrade: (agentId) => upgradeSessionToP2P(serverId, agentId, terminal, hostInfo, reconnectFactory),
    });
  });
}

/**
 * 同标签页把当前会话换成 P2P：铸一次性 token → RTC 信令 → connectWithWebSocket
 * 关闭旧中继传输并在原 SSH 目标上开新会话（服务端凭据下发，用户无感重认证）。
 * 信令失败经 refetch 回退中继，绝不把用户留在断线态。
 */
async function upgradeSessionToP2P(
  serverId: number,
  agentId: string,
  terminal: SSHTerminal,
  hostInfo: SSHHostInfo | undefined,
  reconnectFactory?: () => Promise<SessionTransportLike>
): Promise<boolean> {
  try {
    const wsUrl = await fetchSavedServerWsUrl(serverId);
    const transport = await openSessionChannel(appendP2PParams(wsUrl, agentId), () =>
      fetchSavedServerWsUrl(serverId)
    );
    if (transport instanceof WebSocket) {
      // 信令失败已回退出一条新中继通道——升级无收益，关掉它、保留现有会话。
      try {
        transport.close();
      } catch {
        /* 已关闭 */
      }
      return false;
    }
    terminal.connectWithWebSocket(transport, hostInfo, { reconnectFactory });
    return true;
  } catch {
    return false;
  }
}

// ==================== 断开连接处理 ====================

document.getElementById('disconnect-btn')?.addEventListener('click', () => {
  const tm = tabManager;
  if (!tm) return;

  const tab = tm.getActiveTab();
  if (!tab) return;

  tab.sftpPanel?.hide();
  tab.terminal.disconnect();
  tm.closeActiveTab();
});

// ==================== 抽屉分段控制条与互斥联动 ====================

let terminalDrawerControl: LiquidSegmentedDrawerControl | null = null;

function syncDrawerSegmentedControl(): void {
  const tab = tabManager?.getActiveTab();
  if (snippetManager.isOpen()) {
    terminalDrawerControl?.setActive('snippet');
  } else if (tab?.sftpPanel?.isVisible()) {
    terminalDrawerControl?.setActive('sftp');
  } else {
    terminalDrawerControl?.setActive(null);
  }
}

/**
 * 抽屉互斥开关的唯一入口（桌面分段条与移动端菜单按钮共用）。
 * 返回是否真的发生了状态变化（SFTP 未就绪时为 false）。
 */
function applyDrawerToggle(drawer: 'sftp' | 'snippet', open: boolean): boolean {
  const tab = tabManager?.getActiveTab();
  if (drawer === 'sftp') {
    if (open) {
      // SFTP 面板由 TabManager 的 sessionReady 回调初始化，未就绪时不可打开
      if (!tab?.sftpPanel) return false;
      snippetManager.close();
      tab.sftpPanel.show();
    } else {
      tab?.sftpPanel?.hide();
    }
  } else if (drawer === 'snippet') {
    if (open) {
      tab?.sftpPanel?.hide();
      void snippetManager.open();
    } else {
      snippetManager.close();
    }
  }
  syncDrawerSegmentedControl();
  return true;
}

function initTerminalDrawerControl(): void {
  const drawerBar = document.getElementById('terminal-drawer-segmented-bar');
  if (!drawerBar) return;

  terminalDrawerControl = new LiquidSegmentedDrawerControl(drawerBar, (drawer, open) => {
    if (!applyDrawerToggle(drawer as 'sftp' | 'snippet', open)) {
      // 抽屉不可用：回退透镜的激活态
      terminalDrawerControl?.setActive(null);
    }
  });
}

/**
 * 移动端抽屉入口（#mobile-more-menu 内的 SFTP）。
 * 分段切换器在移动端整体隐藏（.desktop-terminal-action），因此这个抽屉
 * 必须在移动端菜单里保留平行入口，否则移动端用户将无法使用 SFTP。
 */
function initMobileDrawerButtons(): void {
  const closeMenu = () => mobileTerminalController.hideMoreMenu();

  document.getElementById('mobile-sftp-btn')?.addEventListener('click', () => {
    const tab = tabManager?.getActiveTab();
    applyDrawerToggle('sftp', !(tab?.sftpPanel?.isVisible() ?? false));
    closeMenu();
  });
}

// 移动端命令片段按钮
function toggleSnippetManager(): void {
  const tab = tabManager?.getActiveTab();
  if (!snippetManager.isOpen()) {
    tab?.sftpPanel?.hide();
  }
  snippetManager.toggle();
  syncDrawerSegmentedControl();
}

document.getElementById('mobile-snippets-btn')?.addEventListener('click', toggleSnippetManager);

// ==================== 终端搜索 ====================

document.getElementById('search-btn')?.addEventListener('click', () => {
  tabManager?.getActiveTab()?.terminal.toggleSearch();
});

// ==================== 导出终端日志 ====================

document.getElementById('export-btn')?.addEventListener('click', () => {
  tabManager?.getActiveTab()?.terminal.exportToFile();
});

// ==================== 主题切换 ====================

const CUSTOM_THEME_VALUE = '__custom__';
let themeSelectionRevision = 0;
let userThemeSegmentedControl: LiquidSegmentedThemeControl | null = null;
const themeSelectors = Array.from(
  document.querySelectorAll<HTMLSelectElement>('[data-theme-selector]')
);

for (const selector of themeSelectors) {
  selector.addEventListener('change', (e) => {
    themeSelectionRevision++;
    const value = (e.target as HTMLSelectElement).value;
    if (value === CUSTOM_THEME_VALUE) {
      const importedRaw = localStorage.getItem('cloudssh_imported_theme');
      if (importedRaw) {
        try {
          const imported = normalizeImportedTheme(JSON.parse(importedRaw));
          if (imported) applyImportedTheme(imported);
        } catch {
          /* ignore */
        }
      }
    } else if (isBuiltInTheme(value)) {
      applyBuiltInTheme(value);
    }
    syncThemeSelectors(value);
    localStorage.setItem('cloudssh_theme_selection', value);
  });
}

function ensureCustomOption(): void {
  for (const selector of themeSelectors) {
    let option = selector.querySelector<HTMLOptionElement>(`option[value="${CUSTOM_THEME_VALUE}"]`);
    if (!option) {
      option = document.createElement('option');
      option.value = CUSTOM_THEME_VALUE;
      selector.insertBefore(option, selector.firstChild);
    }
    option.textContent = t('theme.custom');
  }
  userThemeSegmentedControl?.ensureCustomButton();
}

function syncThemeSelectors(value: string): void {
  for (const selector of themeSelectors) {
    selector.value = value;
  }
  userThemeSegmentedControl?.syncFromSelect(value, true);
}

// ==================== 主题导入 ====================

const importThemeButtons = document.querySelectorAll<HTMLElement>('[data-theme-import]');
const importThemeInput = document.getElementById('import-theme-input') as HTMLInputElement | null;

for (const button of importThemeButtons) {
  button.addEventListener('click', () => importThemeInput?.click());
}

importThemeInput?.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > THEME_MAX_BYTES) {
    notify(t('theme.importFailed'), { title: t('theme.importTitle'), variant: 'danger' });
    importThemeInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = normalizeImportedTheme(JSON.parse(ev.target!.result as string));
      if (!data) {
        notify(t('theme.importFailed'), { title: t('theme.importTitle'), variant: 'danger' });
        return;
      }

      localStorage.setItem('cloudssh_imported_theme', JSON.stringify(data));
      themeSelectionRevision++;
      ensureCustomOption();
      syncThemeSelectors(CUSTOM_THEME_VALUE);
      localStorage.setItem('cloudssh_theme_selection', CUSTOM_THEME_VALUE);

      applyImportedTheme(data);
      notify(t('theme.importSuccess'), { variant: 'success' });
      if (isLoggedIn && !(await saveThemeToCloud(data))) {
        notify(t('theme.syncFailed'), { title: t('feedback.warning'), variant: 'warning' });
      }
    } catch {
      notify(t('theme.invalidJson'), { title: t('theme.importTitle'), variant: 'danger' });
    }
  };
  reader.readAsText(file);
  importThemeInput.value = '';
});

// ==================== 主题恢复 ====================

const LEGACY_THEME_MIGRATION: Record<string, BuiltInThemeName> = {
  glacier: 'standard-dark',
  apple: 'liquid-glass',
  gruvbox: 'standard-dark',
  crt: 'cyberpunk',
  glass: 'liquid-glass',
};

/** 恢复主题（在 init 时调用，此时还没有终端实例，只设置 UI 变量） */
function restoreTheme(): void {
  const selection = localStorage.getItem('cloudssh_theme_selection');
  localStorage.removeItem('cloudssh_theme');

  // 旧版内置主题平滑迁移到当前最契合的内置主题
  if (selection && selection in LEGACY_THEME_MIGRATION) {
    const migrated = LEGACY_THEME_MIGRATION[selection];
    localStorage.setItem('cloudssh_theme_selection', migrated);
    applyBuiltInTheme(migrated);
    syncThemeSelectors(migrated);
    return;
  }

  if (isBuiltInTheme(selection)) {
    applyBuiltInTheme(selection);
    syncThemeSelectors(selection);
    return;
  }

  const raw = localStorage.getItem('cloudssh_imported_theme');
  if (raw) {
    try {
      const theme = normalizeImportedTheme(JSON.parse(raw));
      if (!theme) throw new Error('Invalid theme');
      localStorage.setItem('cloudssh_imported_theme', JSON.stringify(theme));
      ensureCustomOption();
      if (selection === CUSTOM_THEME_VALUE) {
        applyImportedTheme(theme);
        syncThemeSelectors(CUSTOM_THEME_VALUE);
        return;
      }
    } catch {
      localStorage.removeItem('cloudssh_imported_theme');
    }
  }

  localStorage.setItem('cloudssh_theme_selection', 'cyberpunk');
  applyBuiltInTheme('cyberpunk');
  syncThemeSelectors('cyberpunk');
}

async function saveThemeToCloud(
  theme: ReturnType<typeof normalizeImportedTheme>
): Promise<boolean> {
  if (!theme) return false;
  try {
    const response = await fetch('/api/user/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme_data: theme }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 登录后恢复账号主题。新浏览器没有本地选择时自动启用云端主题；
 * 已明确选择内置主题的当前浏览器只缓存云端主题，不强制覆盖本地选择。
 */
async function restoreCloudTheme(
  initialSelection: string | null,
  expectedSelectionRevision: number
): Promise<void> {
  try {
    const response = await fetch('/api/user/theme');
    if (!response.ok) return;
    const payload = (await response.json()) as { theme?: unknown };
    const cloudTheme = normalizeImportedTheme(payload.theme);

    if (cloudTheme) {
      // 用户已在请求期间切换或导入主题时，不用较旧的云端响应覆盖当前操作。
      if (themeSelectionRevision !== expectedSelectionRevision) return;
      localStorage.setItem('cloudssh_imported_theme', JSON.stringify(cloudTheme));
      ensureCustomOption();
      if (initialSelection === null || initialSelection === CUSTOM_THEME_VALUE) {
        localStorage.setItem('cloudssh_theme_selection', CUSTOM_THEME_VALUE);
        applyImportedTheme(cloudTheme);
        syncThemeSelectors(CUSTOM_THEME_VALUE);
      }
      return;
    }

    // 匿名状态下已导入的本地主题，在首次登录后补充同步到账号。
    const localRaw = localStorage.getItem('cloudssh_imported_theme');
    if (!localRaw) return;
    const localTheme = normalizeImportedTheme(JSON.parse(localRaw));
    if (localTheme) await saveThemeToCloud(localTheme);
  } catch {
    // 云端不可用时继续使用本地主题，不影响 SSH 主流程。
  }
}

// ==================== 初始化 ====================

/**
 * macOS 26 液态玻璃动态指针天光追踪：
 * 仅在 liquid 风格下监听 pointermove 并通过 requestAnimationFrame 节流更新 --mx 和 --my，
 * 纯变量传导，零 DOM 重排，GPU 仅更新 radial-gradient 聚光位置。
 */
function initPointerSpecularTracking(): void {
  let rafId: number | null = null;
  let targetCard: HTMLElement | null = null;
  let px = 50;
  let py = 0;

  document.addEventListener(
    'pointermove',
    (e: PointerEvent) => {
      if (document.documentElement.dataset.uiStyle !== 'liquid') return;
      const card = (e.target as HTMLElement | null)?.closest?.(
        '.server-card, .cyber-box'
      ) as HTMLElement | null;
      if (!card) {
        targetCard = null;
        return;
      }
      const rect = card.getBoundingClientRect();
      targetCard = card;
      px = Math.round(((e.clientX - rect.left) / rect.width) * 100);
      py = Math.round(((e.clientY - rect.top) / rect.height) * 100);

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          if (targetCard) {
            targetCard.style.setProperty('--mx', `${px}%`);
            targetCard.style.setProperty('--my', `${py}%`);
          }
          rafId = null;
        });
      }
    },
    { passive: true }
  );

  document.addEventListener(
    'pointerleave',
    () => {
      if (targetCard) {
        targetCard.style.setProperty('--mx', '50%');
        targetCard.style.setProperty('--my', '0%');
        targetCard = null;
      }
    },
    { passive: true }
  );
}

async function init(): Promise<void> {
  initI18n();
  initUserSpaceMobileMenu();
  initServerPaginationBreakpoints();
  bindBackToTerminalButtons();
  initPointerSpecularTracking();
  const userSegmentedContainer = document.getElementById('user-theme-segmented-container');
  const userSelect = document.getElementById('user-theme-selector') as HTMLSelectElement | null;
  if (userSegmentedContainer && userSelect) {
    userThemeSegmentedControl = new LiquidSegmentedThemeControl(userSegmentedContainer, userSelect);
  }

  const drawerBar = document.getElementById('terminal-drawer-segmented-bar');
  if (drawerBar) {
    initTerminalDrawerControl();
  }
  initMobileDrawerButtons();

  document.addEventListener('cloudssh:active-terminal-change', () => {
    syncDrawerSegmentedControl();
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('#sftp-close-btn, #snippet-close-btn')) {
      setTimeout(() => syncDrawerSegmentedControl(), 50);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setTimeout(() => syncDrawerSegmentedControl(), 50);
    }
  });
  mobileTerminalController.start();
  onLocaleChange(() => {
    if (localStorage.getItem('cloudssh_imported_theme')) ensureCustomOption();
    tabManager?.refreshTranslations();
  });
  const initialThemeSelection = localStorage.getItem('cloudssh_theme_selection');
  restoreTheme();
  // 设置版权年份
  const copyrightYearSpan = document.getElementById('copyright-year');
  if (copyrightYearSpan) {
    copyrightYearSpan.textContent = new Date().getFullYear().toString();
  }

  const shareToken = takeShareTokenFromLocation();
  if (shareToken) {
    renderShareLanding(shareToken, showSharedTerminal);
    return;
  }

  // 独立终端标签页模式：URL 包含 wsUrl 参数
  if (isTerminalTab()) {
    initTerminalTab();
    return;
  }

  try {
    // 检查是否已登录
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      const user = await meRes.json();
      showUserSpace(user);
      void restoreCloudTheme(initialThemeSelection, themeSelectionRevision);
      return;
    }
  } catch {
    // /api/auth/me 失败，继续显示匿名连接表单
  }

  // 未登录 → 显示匿名连接表单
  showAuthSection();
}

// 导出供 auth-form 和 server-list 使用
export { getTabManager, showTerminalWithNewTab, validateWsUrl };

init();
