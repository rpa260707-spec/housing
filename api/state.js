import { put, get } from '@vercel/blob';

/* Vercel 에서 Blob 을 연결할 때 접두사가 붙으면(`housing_STORE_ID` 처럼)
   기본 이름(BLOB_READ_WRITE_TOKEN)이 없거나 다른 저장소를 가리켜 403 이 납니다.
   그래서 있는 것 중에 맞는 값을 골라 명시적으로 넘깁니다. */
const BLOB_OPT = (() => {
  const token = process.env.housing_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  const storeId = process.env.housing_STORE_ID || process.env.BLOB_STORE_ID;
  const o = {};
  if (token) o.token = token;
  else if (storeId) o.storeId = storeId;
  return o;
})();

// 비거주지 근무직원 사택 임차현황 서버 저장 API (Vercel Blob)
// 사택 계약 목록(data)과 변경 이력(logs)을 한 파일로 보관합니다.

const FILE_NAME = 'housing-state.json';

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode();
  return result;
}

function emptyPayload() {
  return { data: [], logs: [], sourceFile: '', savedAt: '', savedBy: '', saveVersion: '' };
}

async function readPayload() {
  try {
    const blob = await get(FILE_NAME, { access: 'private', ...BLOB_OPT });
    if (!blob || !blob.stream) return emptyPayload();

    const text = await streamToText(blob.stream);
    if (!text) return emptyPayload();

    const raw = JSON.parse(text);
    return {
      data: Array.isArray(raw?.data) ? raw.data : [],
      logs: Array.isArray(raw?.logs) ? raw.logs : [],
      sourceFile: String(raw?.sourceFile || ''),
      savedAt: String(raw?.savedAt || ''),
      savedBy: String(raw?.savedBy || ''),
      saveVersion: String(raw?.saveVersion || raw?.savedAt || '')
    };
  } catch (error) {
    const status = error?.status || error?.statusCode || error?.cause?.status;
    const message = String(error?.message || '').toLowerCase();

    if (status === 404 || message.includes('404') || message.includes('not found')) {
      return emptyPayload();
    }

    throw error;
  }
}

function nowKstText() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');

  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} `
       + `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}:${p(kst.getUTCSeconds())}`;
}

export default async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const saved = await readPayload();
      return res.status(200).json({ success: true, ...saved });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const data = Array.isArray(body.data) ? body.data : [];
      const logs = Array.isArray(body.logs) ? body.logs : [];
      const sourceFile = String(body.sourceFile || '');
      const savedBy = String(body.savedBy || '').trim() || '(이름없음)';

      const savedAt = nowKstText();
      const saveVersion = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      await put(
        FILE_NAME,
        JSON.stringify({ data, logs, sourceFile, savedAt, savedBy, saveVersion }),
        { access: 'private', contentType: 'application/json', allowOverwrite: true, ...BLOB_OPT }
      );

      return res.status(200).json({ success: true, count: data.length, savedAt, savedBy, saveVersion });
    }

    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  } catch (error) {
    console.error('[housing state api error]', error);
    return res.status(500).json({ success: false, message: error.message || '서버 오류' });
  }
}
