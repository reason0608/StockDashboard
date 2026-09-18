export const TWSE_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL';
export const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost';
export const ETF_URL = 'https://www.twse.com.tw/rwd/zh/ETF/etfDiv?response=json';
export const FINMIND_URL = 'https://api.finmindtrade.com/api/v4/data';

/** 將民國緊湊日期／中文日期／西元日期統一為 ISO，未知日期保留 null。 */
export function normalizeDate(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let parts = raw.match(/^(\d{3,4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/)?.slice(1);
  if (!parts && /^\d{7,8}$/.test(raw)) parts = [raw.slice(0, -4), raw.slice(-4, -2), raw.slice(-2)];
  if (!parts) throw new Error('資料來源日期格式不正確');
  const [y, m, d] = parts.map(Number);
  const result = `${y < 1911 ? y + 1911 : y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw new Error('資料來源含無效日期');
  return result;
}

/** 未公告不是零，避免空白字串經 Number 轉換後錯算零元。 */
export function nullableCash(input) {
  if (input == null || ['', '-', '--', '尚未公告', '未公告'].includes(String(input).trim())) return null;
  const n = Number(String(input).replaceAll(',', ''));
  if (!Number.isFinite(n) || n < 0) throw new Error('資料來源含無效股息');
  return n;
}

/** 建立只含公開市場欄位的事件，不保留來源多餘內容。 */
function event(code, name, exDate, paymentDate, cash, source, sourceUrl, now) {
  const date = normalizeDate(exDate);
  if (!date || !/^[0-9A-Z]{4,10}$/.test(String(code))) throw new Error('資料來源缺少股票或除息日期');
  return { id: `${code}:${date}`, stockCode: String(code), stockName: String(name || code), exDate: date,
    paymentDate: normalizeDate(paymentDate), cashPerShare: nullableCash(cash), source, sourceUrl, updatedAt: now };
}

/** 上市／上櫃預告包含純除權資料，僅保留有現金配息或尚待公告金額的除息事件。 */
export function parseExchange(rows, exchange, now) {
  if (!Array.isArray(rows)) throw new Error('預告表結構已改變');
  return rows.filter(r => String(exchange === 'TWSE' ? r.Exdividend : r.ExRrightsExDividend).includes('息')).map(r => exchange === 'TWSE'
    ? event(r.Code, r.Name, r.Date, null, r.CashDividend, '證交所除息預告', TWSE_URL, now)
    : event(r.SecuritiesCompanyCode, r.CompanyName, r.ExRrightsExDividendDate, null, r.CashDividend, '櫃買中心除息預告', TPEX_URL, now));
}

/** ETF 依欄位標題讀值，介面順序改變時仍保持正確，缺欄位則中止更新。 */
export function parseEtf(payload, now) {
  const required = ['證券代號', '證券簡稱', '除息交易日', '收益分配發放日', '收益分配金額 (每1受益權益單位)'];
  if (!['OK', 'ok'].includes(payload?.stat ?? payload?.status) || !Array.isArray(payload.fields) || !Array.isArray(payload.data)) throw new Error('ETF 公告格式不正確');
  const columns = required.map(label => payload.fields.indexOf(label));
  if (columns.some(i => i < 0)) throw new Error('ETF 公告欄位已變更');
  const rows = payload.data.map(row => {
    const [code, name, ex, pay, cash] = columns.map(i => row[i]);
    return event(code, name, ex, pay, cash, '證交所 ETF 收益分配', ETF_URL, now);
  });
  // 相同公告可能重複出現，只去掉完全相同的紀錄；衝突值由驗證拒絕。
  return rows.filter((e, i) => rows.findIndex(other => JSON.stringify(other) === JSON.stringify(e)) === i);
}

/** FinMind 補充發放日期與歷史；現金股利包含盈餘和公積，不加股票股利。 */
export function parseFinMind(payload, name, now) {
  if (payload?.status !== 200 || !Array.isArray(payload.data)) throw new Error('FinMind 回應失敗或已達使用限制');
  const events = new Map();
  for (const row of [...payload.data].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (!row.CashExDividendTradingDate) continue;
    const earnings = nullableCash(row.CashEarningsDistribution);
    const surplus = nullableCash(row.CashStatutorySurplus);
    const cash = earnings === null && surplus === null ? null : (earnings ?? 0) + (surplus ?? 0);
    if (cash === 0) continue;
    const e = event(row.stock_id, name || row.stock_id, row.CashExDividendTradingDate, row.CashDividendPaymentDate, cash, 'FinMind 股利政策', 'https://finmind.github.io/tutor/TaiwanMarket/Fundamental/', now);
    events.set(e.id, e);
  }
  return [...events.values()];
}

/** 合併來源时官方金額優先，補充來源僅填入官方缺少的發放日或金額。 */
export function mergeEvents(existing, incoming) {
  const map = new Map(existing.map(e => [e.id, e]));
  for (const e of incoming) {
    const old = map.get(e.id);
    if (old && e.source.startsWith('FinMind') && !old.source.startsWith('FinMind')) {
      map.set(e.id, { ...old, paymentDate: old.paymentDate || e.paymentDate, cashPerShare: old.cashPerShare ?? e.cashPerShare,
        source: old.paymentDate || !e.paymentDate ? old.source : `${old.source} / FinMind 發放日` });
    } else map.set(e.id, { ...e, paymentDate: e.paymentDate || old?.paymentDate || null });
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
