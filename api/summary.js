import { get } from '@vercel/blob';

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

// 업무포털 위젯용 "집계 전용" API
//
// /api/state 는 담당자명·주소지·임대인 계좌 같은 개인정보를 그대로 담고 있어
// 포털에 열어 주면 안 됩니다. 이 엔드포인트는 건수와 금액만 계산해서 내보내며
// 이름 · 주소 · 연락처 · 계좌번호는 한 건도 포함하지 않습니다.
// (화환의 api/summary.js 와 같은 역할입니다.)

const FILE_NAME = 'housing-state.json';

function setHeaders(res) {
  // 숫자만 나가므로 어디서든 읽을 수 있게 열어 둡니다.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 5분 캐시 — 포털 방문자가 많아도 Blob 을 자주 읽지 않습니다.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
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

async function readPayload() {
  try {
    const blob = await blobTry((opt) => get(FILE_NAME, { access: 'private', ...opt }));
    if (!blob || !blob.stream) return { data: [], savedAt: '' };

    const text = await streamToText(blob.stream);
    if (!text) return { data: [], savedAt: '' };

    const raw = JSON.parse(text);
    return {
      data: Array.isArray(raw?.data) ? raw.data : [],
      savedAt: String(raw?.savedAt || '')
    };
  } catch (error) {
    const status = error?.status || error?.statusCode || error?.cause?.status;
    const message = String(error?.message || '').toLowerCase();

    if (status === 404 || message.includes('404') || message.includes('not found')) {
      return { data: [], savedAt: '' };
    }

    throw error;
  }
}

function kstToday() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}`;
}

function shiftDays(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// 지역 판정 — index.html 의 getRegionFromAddress 와 같은 규칙입니다.
// 주소 원문은 내보내지 않고 '서울 / 청주 / 그 밖의 지역' 건수만 셉니다.
function regionGroup(address) {
  const addr = String(address ?? '').trim();
  if (addr.includes('서울')) return '서울';
  if (addr.includes('청주') || addr.includes('오창') || addr.includes('충주')) return '청주';
  return '그 밖의 지역';
}

// 앱과 같은 방식으로 날짜 문자열을 YYYY-MM-DD 로 맞춥니다.
function normalizeDate(value) {
  const m = String(value || '').match(/(\d{4})[-.\/년\s]+(\d{1,2})[-.\/월\s]+(\d{1,2})/);
  if (!m) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}`;
}

export default async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  }

  try {
    const { data: rows, savedAt } = await readPayload();

    const today = kstToday();
    const in90 = shiftDays(today, 90);

    let total = 0;          // 전체 관리 건수
    let active = 0;         // 유효 임차(미반납) 건수
    let expiring90 = 0;     // 90일 이내 계약 종료 예정
    let expired = 0;        // 이미 종료일이 지난 미반납 건
    let totalDeposit = 0;   // 보증금 합계
    let totalRent = 0;      // 월세 합계
    let nearestEnd = '';    // 가장 가까운 종료 예정일

    const areaTypes = {};   // 사택 형태별 건수 (원룸/투룸 등 — 개인정보 아님)
    const regions = { '서울': 0, '청주': 0, '그 밖의 지역': 0 };

    for (const r of rows) {
      total += 1;

      const terminated = r?.status === 'terminated';
      if (terminated) continue;

      active += 1;
      totalDeposit += Number(r?.deposit) || 0;
      totalRent += Number(r?.rent) || 0;

      const type = String(r?.areaType || '미지정');
      areaTypes[type] = (areaTypes[type] || 0) + 1;

      regions[regionGroup(r?.address)] += 1;

      const end = normalizeDate(r?.endDate);
      if (!end) continue;

      if (end < today) {
        expired += 1;
      } else if (end <= in90) {
        expiring90 += 1;
        if (!nearestEnd || end < nearestEnd) nearestEnd = end;
      }

      if (!nearestEnd && end >= today) nearestEnd = end;
    }

    return res.status(200).json({
      success: true,
      asOf: today,
      basis: '계약종료일 기준',
      total,
      active,
      expiring90,
      expired,
      totalDeposit,
      totalRent,
      nearestEnd,
      areaTypes,
      regions,
      savedAt
    });
  } catch (error) {
    console.error('[housing summary api error]', error);
    return res.status(500).json({ success: false, message: '집계 중 오류가 발생했습니다.' });
  }
}
