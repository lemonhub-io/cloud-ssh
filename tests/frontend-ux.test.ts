import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getNetworkQuality } from '../frontend/src/network-quality';
import { osDisplayName, osIconSvg } from '../frontend/src/os-icons';
import { parsePort } from '../frontend/src/port';
import {
  filterServers,
  normalizeTagsInput,
  paginateServers,
  resolveServerPageSize,
  type ServerConfig,
} from '../frontend/src/server-list';
import { resolveTerminalFontSize } from '../frontend/src/terminal-layout';
import { DETECTED_OS_KEYS } from '../src/worker/os-detect';

const servers: ServerConfig[] = [
  {
    id: 1,
    user_id: 1,
    name: 'Production API',
    host: 'api.example.com',
    port: 22,
    username: 'deploy',
    auth_method: 'publickey',
    tags: ['production', 'api'],
    created_at: '',
    updated_at: '',
  },
  {
    id: 2,
    user_id: 1,
    name: '测试数据库',
    host: '10.0.0.8',
    port: 2222,
    username: 'DBAdmin',
    auth_method: 'password',
    tags: ['staging', 'database'],
    created_at: '',
    updated_at: '',
  },
];

describe('服务器操作系统图标', () => {
  it('后端所有可持久化 OS key 都有可访问名称和图标回退', () => {
    for (const os of DETECTED_OS_KEYS) {
      expect(osDisplayName(os), os).not.toBeNull();
      expect(osIconSvg(os), os).toContain('<svg');
    }
  });

  it('未知或空值继续使用服务器默认图标', () => {
    expect(osDisplayName('unknown')).toBeNull();
    expect(osIconSvg('unknown')).toBeNull();
    expect(osIconSvg(null)).toBeNull();
  });
});

describe('服务器列表搜索', () => {
  it('手机、触屏平板和桌面端分别使用 3、6、9 张分页', () => {
    expect(resolveServerPageSize(390, true)).toBe(3);
    expect(resolveServerPageSize(767, false)).toBe(3);
    expect(resolveServerPageSize(768, true)).toBe(6);
    expect(resolveServerPageSize(1180, true)).toBe(6);
    expect(resolveServerPageSize(1024, false)).toBe(9);
    expect(resolveServerPageSize(1181, true)).toBe(9);
  });

  it('按名称、主机和用户名进行不区分大小写的过滤', () => {
    expect(filterServers(servers, 'production')).toEqual([servers[0]]);
    expect(filterServers(servers, '10.0.0.8')).toEqual([servers[1]]);
    expect(filterServers(servers, 'dbadmin')).toEqual([servers[1]]);
  });

  it('忽略查询两端空白，空查询返回全部服务器', () => {
    expect(filterServers(servers, '  API  ')).toEqual([servers[0]]);
    expect(filterServers(servers, '   ')).toEqual(servers);
  });

  it('没有匹配项时返回空列表', () => {
    expect(filterServers(servers, 'missing')).toEqual([]);
  });

  it('支持标签筛选、标签输入规范化和分页边界修正', () => {
    expect(filterServers(servers, '', 'database')).toEqual([servers[1]]);
    expect(normalizeTagsInput(' Production, production，data   base ')).toEqual([
      'Production',
      'data base',
    ]);
    expect(paginateServers(servers, 99, 1)).toEqual({
      items: [servers[1]],
      currentPage: 2,
      totalPages: 2,
    });
  });
});

describe('终端响应式字号', () => {
  it('手机、触屏平板和桌面端分别使用 12、13、14px', () => {
    expect(resolveTerminalFontSize(390, true)).toBe(12);
    expect(resolveTerminalFontSize(767, false)).toBe(12);
    expect(resolveTerminalFontSize(768, true)).toBe(13);
    expect(resolveTerminalFontSize(1180, true)).toBe(13);
    expect(resolveTerminalFontSize(1024, false)).toBe(14);
    expect(resolveTerminalFontSize(1181, true)).toBe(14);
  });
});

describe('连接表单提交与端口校验', () => {
  it('仅接受 1-65535 范围内的十进制整数端口', () => {
    expect(parsePort('22')).toBe(22);
    expect(parsePort(' 65535 ')).toBe(65535);
    expect(parsePort('0')).toBeNull();
    expect(parsePort('65536')).toBeNull();
    expect(parsePort('22.5')).toBeNull();
    expect(parsePort('22abc')).toBeNull();
    expect(parsePort('1e2')).toBeNull();
    expect(parsePort('')).toBeNull();
  });

  it('使用标准 submit 事件，私钥文本框中的 Enter 不会被全局捕获', () => {
    const authSource = readFileSync(
      new URL('../frontend/src/auth-form.ts', import.meta.url),
      'utf8'
    );
    const serverSource = readFileSync(
      new URL('../frontend/src/server-list.ts', import.meta.url),
      'utf8'
    );
    const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');

    expect(authSource).toContain("addEventListener('submit'");
    expect(serverSource).toContain("addEventListener('submit'");
    expect(authSource).not.toContain("addEventListener('keypress'");
    expect(serverSource).not.toContain("addEventListener('keypress'");
    expect(authSource).toContain('id="connect-btn"');
    expect(authSource).toContain('type="submit"');
    expect(html).toMatch(/id="server-submit-btn"[^>]+type="submit"/);
  });

  it('最近连接删除按钮显式 type="button"，点击不会误提交连接表单', () => {
    const authSource = readFileSync(
      new URL('../frontend/src/auth-form.ts', import.meta.url),
      'utf8'
    );
    // 删除按钮位于 <form id="connection-form"> 内；若缺省 type 会默认 submit，
    // 点击 "x" 会触发 handleConnect()（stopPropagation 无法阻止默认提交动作）。
    const deleteBtn =
      authSource.match(/<button[^>]*class="[^"]*delete-history-btn[^"]*"[^>]*>/)?.[0] ?? '';
    expect(deleteBtn).toContain('type="button"');
    expect(deleteBtn).not.toContain('type="submit"');
  });

  it('连接成功后清空密码与私钥输入框，避免返回匿名页时凭据残留', () => {
    const authSource = readFileSync(
      new URL('../frontend/src/auth-form.ts', import.meta.url),
      'utf8'
    );
    const connectIdx = authSource.lastIndexOf('await terminal.connect(');
    const clearPwIdx = authSource.lastIndexOf(
      "(document.getElementById('password') as HTMLInputElement).value = ''"
    );
    const clearKeyIdx = authSource.lastIndexOf(
      "(document.getElementById('private-key') as HTMLTextAreaElement).value = ''"
    );
    expect(connectIdx).toBeGreaterThan(-1);
    // 清空语句必须出现在 terminal.connect 之后（连接成功后才清空）
    expect(clearPwIdx).toBeGreaterThan(connectIdx);
    expect(clearKeyIdx).toBeGreaterThan(connectIdx);
  });
});

describe('网络质量三色提示', () => {
  it('分别按 CF 延迟和 WebSocket RTT 阈值返回三种颜色等级', () => {
    expect(getNetworkQuality(100, 'cf')).toBe('good');
    expect(getNetworkQuality(101, 'cf')).toBe('fair');
    expect(getNetworkQuality(250, 'cf')).toBe('fair');
    expect(getNetworkQuality(251, 'cf')).toBe('poor');

    expect(getNetworkQuality(100, 'ws')).toBe('good');
    expect(getNetworkQuality(101, 'ws')).toBe('fair');
    expect(getNetworkQuality(200, 'ws')).toBe('fair');
    expect(getNetworkQuality(201, 'ws')).toBe('poor');
  });

  it('状态栏只渲染色点和延迟数值，不增加质量文字', () => {
    const source = readFileSync(new URL('../frontend/src/tab-manager.ts', import.meta.url), 'utf8');
    expect(source).toContain(`network-quality-\${item.quality}`);
    expect(source).toContain('CF-');
    expect(source).toContain('RTT:');
    expect(source).not.toMatch(/良好|一般|较差|Good|Fair|Poor/);
  });
});
