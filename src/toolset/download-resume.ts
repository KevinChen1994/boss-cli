import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CDPSession, Page } from 'puppeteer-core';
import { isBossChatIndexUrl } from '../common/auth.js';

const ATTACHMENT_PREVIEW_WAIT_MS = 15_000;
const ATTACHMENT_DOWNLOAD_WAIT_MS = 60_000;
const BOSS_RESUME_DOWNLOAD_ORIGIN = 'https://docdownload.zhipin.com';
const BOSS_RESUME_DOWNLOAD_PATH_PREFIX = '/wflow/zpgeek/download/download4boss/';

type AttachmentContext = {
  candidateName: string;
  attachmentTitle: string;
};

type CompletedDownload = {
  filePath: string;
  suggestedFilename: string;
};

async function ensureOutputDirectory(rawDirectory: string): Promise<string> {
  const requestedDirectory = resolve(rawDirectory);
  let outputDirectory: string;
  try {
    outputDirectory = await realpath(requestedDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`下载目录不存在或不可访问：${requestedDirectory}（${message}）`);
  }
  let info;
  try {
    info = await stat(outputDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`下载目录不存在或不可访问：${outputDirectory}（${message}）`);
  }
  if (!info.isDirectory()) {
    throw new Error(`下载目标不是目录：${outputDirectory}`);
  }
  try {
    await access(outputDirectory, fsConstants.W_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`下载目录不可写：${outputDirectory}（${message}）`);
  }
  return outputDirectory;
}

async function openLatestAttachmentResume(page: Page): Promise<AttachmentContext> {
  const currentUrl = page.url();
  if (!isBossChatIndexUrl(currentUrl)) {
    throw new Error(
      `当前不在聊天列表页（/web/chat/index），无法下载附件简历。当前 URL：${currentUrl}`,
    );
  }

  const context = (await page.evaluate(`(() => {
    const norm = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const detail = Array.from(document.querySelectorAll(".base-info-single-container")).find(isVisible);
    if (!detail) {
      return { kind: "no_candidate" };
    }

    const messageLists = Array.from(document.querySelectorAll(".chat-message-list")).filter(isVisible);
    const messageList = messageLists[messageLists.length - 1];
    if (!messageList) {
      return { kind: "no_message_list" };
    }
    const items = Array.from(messageList.querySelectorAll(".message-item"));
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const friend = items[index].querySelector(".item-friend");
      if (!friend) continue;
      const button = friend.querySelector(".message-card-buttons .card-btn");
      if (!(button instanceof HTMLElement)) continue;
      if (!norm(button.textContent).includes("预览附件简历")) continue;

      const attachmentTitle = norm(friend.querySelector(".message-card-top-title")?.textContent);
      if (!attachmentTitle) {
        return { kind: "missing_title" };
      }
      const candidateName = norm(detail.querySelector(".name-box")?.textContent);
      if (!candidateName) {
        return { kind: "missing_candidate_name" };
      }
      button.scrollIntoView({ block: "center", inline: "nearest" });
      button.click();
      return { kind: "opened", candidateName, attachmentTitle };
    }
    return { kind: "no_attachment" };
  })()`)) as
    | { kind: 'opened'; candidateName: string; attachmentTitle: string }
    | { kind: 'no_candidate' }
    | { kind: 'no_message_list' }
    | { kind: 'missing_title' }
    | { kind: 'missing_candidate_name' }
    | { kind: 'no_attachment' };

  if (context.kind === 'no_candidate') {
    throw new Error('请先通过 boss chat 打开候选人聊天，再下载附件简历。');
  }
  if (context.kind === 'missing_title') {
    throw new Error('已找到附件简历卡片，但附件文件名为空。');
  }
  if (context.kind === 'missing_candidate_name') {
    throw new Error('已打开候选人聊天，但候选人姓名为空。');
  }
  if (context.kind === 'no_message_list') {
    throw new Error('已打开候选人聊天，但未找到可见的聊天消息列表。');
  }
  if (context.kind === 'no_attachment') {
    throw new Error('当前候选人聊天中未找到可预览的附件简历。');
  }

  await page.waitForFunction(
    `(() => {
      const roots = Array.from(document.querySelectorAll(".resume-common-dialog.search-resume"));
      return roots.some((root) => {
        if (!(root instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(root);
        const rect = root.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
          return false;
        }
        return !!root.querySelector("iframe.attachment-iframe") && !!root.querySelector(".attachment-resume-btns");
      });
    })()`,
    { timeout: ATTACHMENT_PREVIEW_WAIT_MS },
  );

  return {
    candidateName: context.candidateName,
    attachmentTitle: context.attachmentTitle,
  };
}

async function clickAttachmentDownloadButton(page: Page): Promise<void> {
  const clicked = (await page.evaluate(`(() => {
    const roots = Array.from(document.querySelectorAll(".resume-common-dialog.search-resume"));
    const root = roots.find((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    if (!root) return false;
    const downloadUse = Array.from(root.querySelectorAll(".attachment-resume-btns use")).find((element) =>
      (element.getAttribute("xlink:href") ?? "").includes("icon-attacthment-download"),
    );
    const button = downloadUse?.closest(".popover.icon-content")?.querySelector("span");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`)) as boolean;
  if (!clicked) {
    throw new Error('附件简历预览已打开，但未找到“下载”按钮。');
  }
}

function waitForBossResumeDownload(
  session: CDPSession,
  page: Page,
): Promise<CompletedDownload> {
  return new Promise((resolveDownload, rejectDownload) => {
    let downloadGuid = '';
    let suggestedFilename = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      session.off('Browser.downloadWillBegin', onDownloadWillBegin);
      session.off('Browser.downloadProgress', onDownloadProgress);
    };
    const resolveOnce = (value: CompletedDownload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveDownload(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectDownload(error);
    };
    const onDownloadWillBegin = (event: {
      guid: string;
      url: string;
      suggestedFilename: string;
    }) => {
      let url: URL;
      try {
        url = new URL(event.url);
      } catch {
        rejectOnce(new Error(`浏览器返回了无效的附件下载地址：${event.url}`));
        return;
      }
      if (
        url.origin !== BOSS_RESUME_DOWNLOAD_ORIGIN ||
        !url.pathname.startsWith(BOSS_RESUME_DOWNLOAD_PATH_PREFIX)
      ) {
        rejectOnce(new Error(`附件下载地址不符合预期：${url.origin}${url.pathname}`));
        return;
      }
      if (!event.suggestedFilename.trim()) {
        rejectOnce(new Error('浏览器未返回附件简历文件名。'));
        return;
      }
      downloadGuid = event.guid;
      suggestedFilename = event.suggestedFilename;
    };
    const onDownloadProgress = (event: {
      guid: string;
      state: string;
      filePath?: string;
    }) => {
      if (!downloadGuid || event.guid !== downloadGuid) return;
      if (event.state === 'canceled') {
        rejectOnce(new Error(`附件简历下载已被浏览器取消：${suggestedFilename}`));
        return;
      }
      if (event.state !== 'completed') return;
      if (!event.filePath) {
        rejectOnce(new Error(`附件简历下载完成，但浏览器未返回文件路径：${suggestedFilename}`));
        return;
      }
      resolveOnce({ filePath: event.filePath, suggestedFilename });
    };

    const timer = setTimeout(() => {
      rejectOnce(new Error(`等待附件简历下载完成超时（${ATTACHMENT_DOWNLOAD_WAIT_MS}ms）。`));
    }, ATTACHMENT_DOWNLOAD_WAIT_MS);

    session.on('Browser.downloadWillBegin', onDownloadWillBegin);
    session.on('Browser.downloadProgress', onDownloadProgress);

    void clickAttachmentDownloadButton(page).catch((error) => {
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function downloadWithBrowser(
  page: Page,
  outputDirectory: string,
): Promise<CompletedDownload> {
  const session = await page.browser().target().createCDPSession();
  let download: CompletedDownload | undefined;
  let operationError: unknown;
  let restoreError: unknown;

  try {
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: outputDirectory,
      eventsEnabled: true,
    });
    download = await waitForBossResumeDownload(session, page);
  } catch (error) {
    operationError = error;
  }

  try {
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'default',
      eventsEnabled: false,
    });
  } catch (error) {
    restoreError = error;
  }

  try {
    await session.detach();
  } catch (error) {
    restoreError = restoreError ?? error;
  }

  if (operationError && restoreError) {
    throw new AggregateError(
      [operationError, restoreError],
      '附件简历下载失败，且恢复浏览器默认下载设置时发生错误。',
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (restoreError) {
    throw new Error(
      `附件简历已下载，但恢复浏览器默认下载设置失败：${
        restoreError instanceof Error ? restoreError.message : String(restoreError)
      }`,
    );
  }
  if (!download) {
    throw new Error('附件简历下载未返回结果。');
  }
  return download;
}

async function closeAttachmentPreview(page: Page, downloadedPath: string): Promise<void> {
  const closed = (await page.evaluate(`(() => {
    const roots = Array.from(document.querySelectorAll(".resume-common-dialog.search-resume"));
    const root = roots.find((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !!element.querySelector("iframe.attachment-iframe");
    });
    const closeButton = root?.querySelector(".close-btn");
    if (!(closeButton instanceof HTMLElement)) return false;
    closeButton.click();
    return true;
  })()`)) as boolean;
  if (!closed) {
    throw new Error(`附件简历已下载到 ${downloadedPath}，但未找到附件预览关闭按钮。`);
  }
}

export async function runDownloadAttachmentResume(
  page: Page,
  outputDirectoryArg: string,
): Promise<string> {
  const outputDirectory = await ensureOutputDirectory(outputDirectoryArg);
  const attachment = await openLatestAttachmentResume(page);
  const download = await downloadWithBrowser(page, outputDirectory);
  const downloadedPath = resolve(download.filePath);

  if (dirname(downloadedPath) !== outputDirectory) {
    throw new Error(
      `浏览器返回的下载路径不在指定目录中：${downloadedPath}（指定目录：${outputDirectory}）`,
    );
  }

  const fileInfo = await stat(downloadedPath);
  if (!fileInfo.isFile() || fileInfo.size <= 0) {
    throw new Error(`附件简历下载文件无效：${downloadedPath}`);
  }

  await closeAttachmentPreview(page, downloadedPath);

  return [
    '附件简历下载成功。',
    `候选人：${attachment.candidateName}`,
    `附件卡片：${attachment.attachmentTitle}`,
    `文件名：${download.suggestedFilename}`,
    `文件路径：${downloadedPath}`,
    `文件大小：${fileInfo.size} bytes`,
  ].join('\n');
}
