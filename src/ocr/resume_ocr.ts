import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureAppDataLayout, RESUME_OCR_DIR } from '../config.js';
import { baiduOcrImageBase64, isBaiduOcrConfigured } from './baidu_ocr.js';
import { isVolcengineOcrConfigured, volcengineOcrImageBase64 } from './volcengine_ocr.js';

export type ResumeOcrProvider = 'baidu' | 'volcengine';

/**
 * 是否对在线简历截图做 OCR。关闭：`BOSS_RESUME_OCR=0`。
 * 开启时必须通过 `BOSS_RESUME_OCR_PROVIDER` 明确指定 OCR 服务商。
 */
export function isResumeOcrEnabled(): boolean {
  const v = process.env.BOSS_RESUME_OCR?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * 解析在线简历 OCR 服务商。未配置或值不受支持时直接失败，禁止隐式默认和跨服务商回退。
 */
export function resolveResumeOcrProvider(
  rawProvider: string | undefined = process.env.BOSS_RESUME_OCR_PROVIDER,
): ResumeOcrProvider {
  const provider = rawProvider?.trim().toLowerCase();
  if (provider === 'baidu' || provider === 'volcengine') {
    return provider;
  }
  if (!provider) {
    throw new Error(
      '已开启简历 OCR，但未设置 BOSS_RESUME_OCR_PROVIDER；请明确设置为 baidu 或 volcengine。',
    );
  }
  throw new Error(
    `不支持的简历 OCR 服务商：${rawProvider}；BOSS_RESUME_OCR_PROVIDER 仅支持 baidu 或 volcengine。`,
  );
}

function assertProviderConfigured(provider: ResumeOcrProvider): void {
  if (provider === 'baidu' && !isBaiduOcrConfigured()) {
    throw new Error(
      '已选择百度 OCR，但未配置百度密钥：请设置 API_KEY 与 SECRET_KEY（或 BOSS_BAIDU_API_KEY / BOSS_BAIDU_SECRET_KEY）。',
    );
  }
  if (provider === 'volcengine' && !isVolcengineOcrConfigured()) {
    throw new Error(
      '已选择火山 OCR，但未配置火山密钥：请设置 BOSS_VOLCENGINE_ACCESS_KEY 与 BOSS_VOLCENGINE_SECRET_KEY。',
    );
  }
}

/** 串行执行 OCR，避免并发请求交错 */
let ocrChain: Promise<unknown> = Promise.resolve();

/**
 * 对简历区域 PNG 调用明确配置的 OCR 服务商，将结果写入
 * `~/.boss-cli/.cache/ocr/`（与截图同名 `.txt`）。
 */
export async function ocrResumePngToTextFile(pngAbsPath: string): Promise<{ textPath: string; text: string }> {
  ensureAppDataLayout();
  const provider = resolveResumeOcrProvider();
  assertProviderConfigured(provider);

  const base = basename(pngAbsPath).replace(/\.png$/i, '.txt');
  const textPath = join(RESUME_OCR_DIR, base);

  const run = async (): Promise<{ textPath: string; text: string }> => {
    const buf = await readFile(pngAbsPath);
    const imageBase64 = buf.toString('base64');
    const text =
      provider === 'baidu'
        ? await baiduOcrImageBase64(imageBase64)
        : await volcengineOcrImageBase64(imageBase64);
    await writeFile(textPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return { textPath, text };
  };

  const p = ocrChain.then(run);
  ocrChain = p.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[boss-cli] resume OCR chain reset after failure:', msg);
  });
  return p;
}
