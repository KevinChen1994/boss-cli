import assert from 'node:assert/strict';
import { resolveResumeOcrProvider } from '../dist/ocr/resume_ocr.js';
import { createVolcengineAuthorizationHeaders } from '../dist/ocr/volcengine_ocr.js';

assert.equal(resolveResumeOcrProvider('baidu'), 'baidu');
assert.equal(resolveResumeOcrProvider(' BAIDU '), 'baidu');
assert.equal(resolveResumeOcrProvider('volcengine'), 'volcengine');
assert.equal(resolveResumeOcrProvider(' VOLCENGINE '), 'volcengine');
assert.throws(
  () => resolveResumeOcrProvider(undefined),
  /未设置 BOSS_RESUME_OCR_PROVIDER/u,
);
assert.throws(
  () => resolveResumeOcrProvider('unknown'),
  /不支持的简历 OCR 服务商/u,
);

const signedHeaders = createVolcengineAuthorizationHeaders({
  credentials: {
    accessKeyId: 'test-access-key',
    secretKey: 'test-secret-key',
  },
  body: 'image_base64=dGVzdA%3D%3D',
  date: new Date('2026-07-22T08:00:00.000Z'),
});
assert.equal(signedHeaders['X-Date'], '20260722T080000Z');
assert.equal(
  signedHeaders.Authorization,
    'HMAC-SHA256 Credential=test-access-key/20260722/cn-north-1/cv/request, ' +
    'SignedHeaders=host;x-content-sha256;x-date, ' +
    'Signature=e010043361a030f6cb80534cd86ee1b1e12f9d6c47bc58b98090d67c3b3cf5e9',
);

console.log('resume OCR provider tests passed');
