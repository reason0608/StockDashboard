import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { parseFeed } from '../src/domain/dividends.ts';
import { TWSE_URL, TPEX_URL, ETF_URL, FINMIND_URL, parseExchange, parseEtf, parseFinMind, mergeEvents } from './dividend-sources.mjs';

const output = new URL('../public/data/dividends.json', import.meta.url);
const now = new Date().toISOString();
let previous = { version: 1, updatedAt: null, sources: [], events: [] };
try { previous = parseFeed(JSON.parse(await readFile(output, 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

/** 以限時及一次重試讀取公開 JSON，錯誤輸出不包含 token 或回應本文。 */
async function request(url, headers = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch { if (attempt === 1) throw new Error('來源暫時無法取得，保留上次成功資料'); }
  }
}

// 排程從已發布檔案續接歷史，不需要將每日 JSON commit 回公開儲存庫。
if (process.argv.includes('--restore-published')) {
  try {
    const published = parseFeed(await request('https://reason0608.github.io/StockDashboard/data/dividends.json'));
    if ((published.updatedAt || '') > (previous.updatedAt || '')) previous = published;
  } catch { console.warn('未取得已發布快照，使用儲存庫內基準資料。'); }
}

const sources = [];
let events = previous.events;
let successes = 0;
const jobs = [
  ['證交所除息預告', TWSE_URL, data => parseExchange(data, 'TWSE', now)],
  ['櫃買中心除息預告', TPEX_URL, data => parseExchange(data, 'TPEX', now)],
  ['證交所 ETF 收益分配', ETF_URL, data => parseEtf(data, now)],
];
for (const [name, url, parse] of jobs) {
  try {
    const rows = parse(await request(url));
    // 先驗證，任何資料結構異動都不覆蓋原有快照。
    parseFeed({ version: 1, updatedAt: now, sources: [], events: rows });
    events = mergeEvents(events, rows);
    sources.push({ name, updatedAt: now, error: null }); successes++;
    console.log(`${name}: ${rows.length} 筆`);
  } catch (e) {
    sources.push({ name, updatedAt: previous.sources.find(s => s.name === name)?.updatedAt || null, error: e.message });
    console.warn(`${name}: ${e.message}`);
  }
}

// 公開代號清單只代表補充資料範圍，不讀取、不公開使用者持股。
const configured = JSON.parse(await readFile(new URL('../config/dividend-symbols.json', import.meta.url), 'utf8'));
const recentCutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
const recentCodes = events.filter(e => e.exDate >= recentCutoff && !e.paymentDate).map(e => e.stockCode);
const symbols = [...new Set([...configured, ...recentCodes])].slice(0, 120);
const headers = process.env.FINMIND_TOKEN ? { Authorization: `Bearer ${process.env.FINMIND_TOKEN}` } : {};
let enriched = 0;
for (const code of symbols) {
  if (!/^[0-9A-Z]{4,10}$/.test(code)) throw new Error('補充代號格式不正確');
  try {
    const url = new URL(FINMIND_URL);
    url.search = new URLSearchParams({ dataset: 'TaiwanStockDividend', data_id: code, start_date: `${new Date().getUTCFullYear() - 1}-01-01` }).toString();
    const rows = parseFinMind(await request(url, headers), events.find(e => e.stockCode === code)?.stockName, now);
    parseFeed({ version: 1, updatedAt: now, sources: [], events: rows });
    events = mergeEvents(events, rows); enriched++;
  } catch {
    sources.push({ name: `FinMind ${code}`, updatedAt: null, error: '補充資料未取得；請以官方公告為準，可設定 FINMIND_TOKEN 增加可用額度。' });
    // 避免上游拒絕後持續打 API。其餘官方資料仍可發布。
    break;
  }
}
sources.push({ name: 'FinMind 發放日與歷史補充', updatedAt: enriched ? now : null, error: enriched < symbols.length ? `本次完成 ${enriched}/${symbols.length} 個代號，部分發放日可能缺漏。` : null });
if (!successes) throw new Error('所有官方來源均失敗，不覆寫或發布資料。');
const result = parseFeed({ version: 1, updatedAt: now, sources, events });
await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/data/dividends.json.tmp', import.meta.url), JSON.stringify(result, null, 2) + '\n', 'utf8');
await rename(new URL('../public/data/dividends.json.tmp', import.meta.url), output);
console.log(`已保存 ${result.events.length} 筆公開配息紀錄。`);
