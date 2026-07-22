/**
 * 火山引擎视觉智能 OCR：OCRNormal。
 * 需配置 `BOSS_VOLCENGINE_ACCESS_KEY`、`BOSS_VOLCENGINE_SECRET_KEY`。
 * @see https://www.volcengine.com/docs/86081/1660264?lang=zh
 */
import { createHash, createHmac } from 'node:crypto';

const VOLCENGINE_OCR_HOST = 'visual.volcengineapi.com';
const VOLCENGINE_OCR_ENDPOINT = `https://${VOLCENGINE_OCR_HOST}`;
const VOLCENGINE_OCR_ACTION = 'OCRNormal';
const VOLCENGINE_OCR_VERSION = '2020-08-26';
const VOLCENGINE_OCR_SERVICE = 'cv';
const VOLCENGINE_OCR_REGION = 'cn-north-1';

function accessKey(): string | undefined {
  return process.env.BOSS_VOLCENGINE_ACCESS_KEY?.trim() || process.env.VOLCENGINE_ACCESS_KEY?.trim();
}

function secretKey(): string | undefined {
  return process.env.BOSS_VOLCENGINE_SECRET_KEY?.trim() || process.env.VOLCENGINE_SECRET_KEY?.trim();
}

function sessionToken(): string | undefined {
  return process.env.BOSS_VOLCENGINE_SESSION_TOKEN?.trim() || process.env.VOLCENGINE_SESSION_TOKEN?.trim();
}

type VolcengineOcrLine = {
  text?: string;
  words?: string;
  line_text?: string;
};

type VolcengineOcrContainer = {
  ocr_infos?: VolcengineOcrLine[];
  line_texts?: string[];
};

type VolcengineOcrResponse = {
  code?: number;
  message?: string;
  data?: VolcengineOcrContainer;
  result?: VolcengineOcrContainer;
  ResponseMetadata?: {
    RequestId?: string;
    Error?: {
      Code?: string;
      Message?: string;
    };
  };
};

type VolcengineCredentials = {
  accessKeyId: string;
  secretKey: string;
  sessionToken?: string;
};

const UNSIGNABLE_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
  'expect',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&');
}

function canonicalHeaderEntries(headers: Record<string, string>): Array<[string, string]> {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.replace(/\s+/g, ' ').trim()] as [string, string])
    .filter(([key]) => !UNSIGNABLE_HEADERS.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function createVolcengineAuthorizationHeaders(params: {
  credentials: VolcengineCredentials;
  body: string;
  date?: Date;
}): Record<string, string> {
  const datetime = (params.date ?? new Date()).toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const shortDate = datetime.slice(0, 8);
  const bodyHash = sha256(params.body);
  const headers: Record<string, string> = {
    Host: VOLCENGINE_OCR_HOST,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Date': datetime,
    'X-Content-Sha256': bodyHash,
  };
  if (params.credentials.sessionToken) {
    headers['X-Security-Token'] = params.credentials.sessionToken;
  }

  const headerEntries = canonicalHeaderEntries(headers);
  const canonicalHeaders = headerEntries.map(([key, value]) => `${key}:${value}`).join('\n');
  const signedHeaders = headerEntries.map(([key]) => key).join(';');
  const query = canonicalQuery({
    Action: VOLCENGINE_OCR_ACTION,
    Version: VOLCENGINE_OCR_VERSION,
  });
  const canonicalRequest = [
    'POST',
    '/',
    query,
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodyHash,
  ].join('\n');
  const scope = `${shortDate}/${VOLCENGINE_OCR_REGION}/${VOLCENGINE_OCR_SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', datetime, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmacSha256(params.credentials.secretKey, shortDate);
  const kRegion = hmacSha256(kDate, VOLCENGINE_OCR_REGION);
  const kService = hmacSha256(kRegion, VOLCENGINE_OCR_SERVICE);
  const kSigning = hmacSha256(kService, 'request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.Authorization =
    `HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

export function isVolcengineOcrConfigured(): boolean {
  return Boolean(accessKey() && secretKey());
}

function extractVolcengineOcrText(data: VolcengineOcrResponse): string {
  const container = data.data ?? data.result;
  const linesFromObjects = (container?.ocr_infos ?? [])
    .map((line) => (line.text ?? line.words ?? line.line_text ?? '').trim())
    .filter((text) => text.length > 0);
  const linesFromStrings = (container?.line_texts ?? [])
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return [...linesFromObjects, ...linesFromStrings].join('\n').trim();
}

/** 对整张 PNG/JPG 做多语种文字识别，返回合并文本（按行拼接）。 */
export async function volcengineOcrImageBase64(imageBase64: string): Promise<string> {
  const ak = accessKey();
  const sk = secretKey();
  if (!ak || !sk) {
    throw new Error('缺少火山 OCR 凭证：请设置 BOSS_VOLCENGINE_ACCESS_KEY 与 BOSS_VOLCENGINE_SECRET_KEY');
  }

  const body = new URLSearchParams({ image_base64: imageBase64 }).toString();
  const headers = createVolcengineAuthorizationHeaders({
    credentials: {
      accessKeyId: ak,
      secretKey: sk,
      sessionToken: sessionToken(),
    },
    body,
  });

  const url = new URL(VOLCENGINE_OCR_ENDPOINT);
  url.searchParams.set('Action', VOLCENGINE_OCR_ACTION);
  url.searchParams.set('Version', VOLCENGINE_OCR_VERSION);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body,
  });
  const data = (await res.json()) as VolcengineOcrResponse;
  const metadataError = data.ResponseMetadata?.Error;
  if (!res.ok || metadataError || (data.code !== undefined && data.code !== 10000)) {
    const detail = metadataError
      ? `${metadataError.Code ?? ''} ${metadataError.Message ?? ''}`.trim()
      : (data.message ?? JSON.stringify(data));
    const requestId = data.ResponseMetadata?.RequestId ? ` requestId=${data.ResponseMetadata.RequestId}` : '';
    throw new Error(`火山 OCR 失败: ${res.status} ${detail}${requestId}`);
  }

  return extractVolcengineOcrText(data);
}
