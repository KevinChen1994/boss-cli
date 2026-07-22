import type { Page } from 'puppeteer-core';
import { SIDEBAR_NAV_AFTER_CLICK_MS, sleepRandom } from '../browser/index.js';

const SIDEBAR_NAV_WAIT_MS = 15_000;

function escapeCssAttributeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\a ');
}

/**
 * 点击 Boss 左侧 `.menu-list` 中的菜单项，并等待导航到给定 pathname（如 `/web/chat/index`）。
 */
export async function clickBossSidebarMenuToPath(
  page: Page,
  menuLabel: string,
  targetPath: string,
): Promise<void> {
  const selector = `.menu-list a[href*="${escapeCssAttributeValue(targetPath)}"]`;
  const target = await page.$(selector);
  if (!target) {
    throw new Error(`未找到侧边栏菜单“${menuLabel}”，无法跳转到 ${targetPath}。`);
  }

  try {
    // 使用 Puppeteer 的鼠标事件生成浏览器级点击；Boss 会忽略 DOM element.click() 的非可信事件。
    await target.click();
  } finally {
    await target.dispose();
  }

  await sleepRandom(SIDEBAR_NAV_AFTER_CLICK_MS.min, SIDEBAR_NAV_AFTER_CLICK_MS.max);

  await page.waitForFunction(
    `((path) => {
      try {
        const p = window.location.pathname.replace(/\\/+$/, "") || "/";
        return p === path;
      } catch {
        return false;
      }
    })`,
    { timeout: SIDEBAR_NAV_WAIT_MS },
    targetPath,
  );
}
