import { put, get } from '@vercel/blob';

/* Vercel Blob 자격 찾기 (저장소가 여러 개 연결된 경우 대비)
   Storage 연결 시 접두사가 붙으면(`housing_STORE_ID` 등) 기본 이름이 없고,
   저장소를 두 개 이상 붙이면 어느 쪽 토큰인지 코드가 알 수 없습니다.
   그래서 **후보를 전부 모아 하나씩 시도**하고, 성공한 것을 기억해 다음부터 바로 씁니다. */
const BLOB_CANDIDATES = (() => {
  const out = [];
  const seen = new Set();
  const add = (o) => {
    const k = JSON.stringify(o);
    if (o && Object.keys(o).length && !seen.has(k)) { seen.add(k); out.push(o); }
  };

  if (process.env.BLOB_READ_WRITE_TOKEN) add({ token: process.env.BLOB_READ_WRITE_TOKEN });
  for (const n of Object.keys(process.env)) {
    if (n.endsWith('_READ_WRITE_TOKEN') && process.env[n]) add({ token: process.env[n] });
  }
  if (process.env.BLOB_STORE_ID) add({ storeId: process.env.BLOB_STORE_ID });
  for (const n of Object.keys(process.env)) {
    if (n.endsWith('_STORE_ID') && process.env[n]) add({ storeId: process.env[n] });
  }
  add({});   // 아무것도 없으면 SDK 기본값
  return out;
})();

let BLOB_OK = null;   // 성공한 자격을 기억

// 자격을 바꿔 가며 시도합니다. 마지막 오류를 그대로 올려 원인을 볼 수 있게 합니다.
async function blobTry(run) {
  const list = BLOB_OK ? [BLOB_OK, ...BLOB_CANDIDATES] : BLOB_CANDIDATES;
  let last;
  for (const opt of list) {
    try {
      const r = await run(opt);
      BLOB_OK = opt;
      return r;
    } catch (e) {
      const s = e?.status || e?.statusCode || e?.cause?.status;
      const m = String(e?.message || '');
      if (s === 404 || m.includes('404') || m.toLowerCase().includes('not found')) throw e;  // 파일 없음은 즉시
      last = e;
    }
  }
  throw last || new Error('Blob 자격을 찾지 못했습니다.');
}

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
    const blob = await blobTry((opt) => get(FILE_NAME, { access: 'private', ...opt }));
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

      await blobTry((opt) => put(
        FILE_NAME,
        JSON.stringify({ data, logs, sourceFile, savedAt, savedBy, saveVersion }),
        { access: 'private', contentType: 'application/json', allowOverwrite: true, ...opt }
      ));

      return res.status(200).json({ success: true, count: data.length, savedAt, savedBy, saveVersion });
    }

    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  } catch (error) {
    console.error('[housing state api error]', error);
    return res.status(500).json({ success: false, message: error.message || '서버 오류' });
  }
}
