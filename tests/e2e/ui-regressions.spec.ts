import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

test('强制 GitHub 登录模式隐藏匿名连接表单', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: false,
        sitekey: '',
        githubAuthEnabled: true,
        githubAuthRequired: true,
      }),
    })
  );

  await page.goto('/');

  await expect(page.locator('#github-auth-required-panel')).toBeVisible();
  await expect(page.locator('#github-login-btn')).toBeVisible();
  await expect(page.locator('#connection-form')).toHaveCount(0);
});

test('Turnstile 跟随 Standard Light 和后续主题切换', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cloudssh_theme_selection', 'standard-light');

    const state = {
      renders: [] as Array<{ id: string; theme: string | undefined }>,
      removals: [] as string[],
    };
    (window as any).__turnstileTest = state;
    (window as any).turnstile = {
      render(container: HTMLElement, options: { theme?: string }) {
        const id = `widget-${state.renders.length + 1}`;
        state.renders.push({ id, theme: options.theme });
        container.replaceChildren(document.createTextNode(id));
        return id;
      },
      remove(widgetId: string) {
        state.removals.push(widgetId);
      },
      reset() {},
      getResponse() {
        return undefined;
      },
    };
  });
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: true,
        sitekey: 'test-site-key',
        githubAuthEnabled: false,
        githubAuthRequired: false,
      }),
    })
  );

  await page.goto('/');

  await expect
    .poll(() => page.evaluate(() => (window as any).__turnstileTest.renders))
    .toEqual([{ id: 'widget-1', theme: 'light' }]);

  await page.evaluate(() => {
    const themeSelector = document.getElementById('theme-selector');
    if (!(themeSelector instanceof HTMLSelectElement)) {
      throw new Error('theme-selector not found');
    }
    themeSelector.value = 'standard-dark';
    themeSelector.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect
    .poll(() => page.evaluate(() => (window as any).__turnstileTest))
    .toEqual({
      renders: [
        { id: 'widget-1', theme: 'light' },
        { id: 'widget-2', theme: 'dark' },
      ],
      removals: ['widget-1'],
    });
});
