export interface Dividend {
  id: string;
  stockCode: string;
  stockName: string;
  exDate: string;
  paymentDate: string | null;
  cashPerShare: number | null;
  source: string;
  sourceUrl: string;
  updatedAt: string;
}
export interface Feed {
  version: 1;
  updatedAt: string | null;
  events: Dividend[];
  sources: { name: string; updatedAt: string | null; error: string | null }[];
}
export interface Confirmation {
  event: Dividend;
  shares: number;
  confirmedAt: string;
  received: boolean;
  remittanceFee?: number;
  cashFlowId?: string;
}
export interface Ledger { version: 1; confirmations: Record<string, Confirmation> }
export interface Holding { stock_code: string; stock_name: string; total_shares: number }

/** 嚴格檢查日期，防止不存在的日曆日期被 Date 自動進位。 */
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** 每一除息事件使用股票代號與除息日識別，不以發放日或金額作為可變動的鍵。 */
export function eventId(code: string, exDate: string) { return `${code}:${exDate}`; }

/** 將持股數乘以已公告每股金額；缺值不當成零，預估保留到分。 */
export function estimateDividend(shares: number | null, cashPerShare: number | null): number | null {
  if (shares === null || cashPerShare === null) return null;
  if (!Number.isSafeInteger(shares) || shares < 0 || !Number.isFinite(cashPerShare) || cashPerShare < 0) throw new Error('股數或每股金額不正確');
  const result = shares * cashPerShare;
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER / 100) throw new Error('預估金額超出可計算範圍');
  return Math.round((result + Number.EPSILON) * 100) / 100;
}

/** 僅接受 HTTPS 來源，排除可執行的連結協定。 */
function validSourceUrl(value: unknown) {
  try { return typeof value === 'string' && new URL(value).protocol === 'https:'; } catch { return false; }
}

/** 驗證外部公告與備份的資料結構，回傳原物件的型別保證。 */
export function isDividend(value: unknown): value is Dividend {
  if (!value || typeof value !== 'object') return false;
  const e = value as Dividend;
  return typeof e.stockCode === 'string' && /^[0-9A-Z]{4,10}$/.test(e.stockCode)
    && typeof e.stockName === 'string' && e.stockName.length <= 200
    && isDate(e.exDate) && e.id === eventId(e.stockCode, e.exDate)
    && (e.paymentDate === null || (isDate(e.paymentDate) && e.paymentDate >= e.exDate))
    && (e.cashPerShare === null || (typeof e.cashPerShare === 'number' && Number.isFinite(e.cashPerShare) && e.cashPerShare >= 0 && e.cashPerShare <= 1000000))
    && typeof e.source === 'string' && e.source.length <= 200 && validSourceUrl(e.sourceUrl)
    && typeof e.updatedAt === 'string' && Number.isFinite(Date.parse(e.updatedAt));
}

/** 解析公告快照；拒絕毀損檔案，讓呼叫端可以回退至上一份快取。 */
export function parseFeed(value: unknown): Feed {
  const f = value as Feed;
  if (!f || f.version !== 1 || !Array.isArray(f.events) || !f.events.every(isDividend)
    || new Set(f.events.map(e => e.id)).size !== f.events.length
    || (f.updatedAt !== null && (typeof f.updatedAt !== 'string' || !Number.isFinite(Date.parse(f.updatedAt))))
    || !Array.isArray(f.sources) || !f.sources.every(s => typeof s.name === 'string'
      && (s.updatedAt === null || (typeof s.updatedAt === 'string' && Number.isFinite(Date.parse(s.updatedAt))))
      && (s.error === null || typeof s.error === 'string'))) throw new Error('股息公告檔格式不正確');
  return f;
}

/** 還原使用者備份時逐筆驗證，禁止不合法股數、重複鍵與原型污染鍵。 */
export function parseLedger(value: unknown): Ledger {
  const l = value as Ledger;
  if (!l || l.version !== 1 || !l.confirmations || typeof l.confirmations !== 'object' || Array.isArray(l.confirmations)) throw new Error('股息備份格式不正確');
  const confirmations: Record<string, Confirmation> = {};
  for (const [id, c] of Object.entries(l.confirmations)) {
    if (!c || !isDividend(c.event) || c.event.id !== id || !Number.isSafeInteger(c.shares) || c.shares < 0
      || typeof c.received !== 'boolean' || !isDate(c.confirmedAt)) throw new Error('備份含有無效的股息紀錄');
    const gross = estimateDividend(c.shares, c.event.cashPerShare);
    if (c.remittanceFee !== undefined && (typeof c.remittanceFee !== 'number' || !Number.isFinite(c.remittanceFee) || c.remittanceFee < 0 || Math.abs(c.remittanceFee * 100 - Math.round(c.remittanceFee * 100)) > 1e-7 || (gross !== null && c.remittanceFee > gross))) throw new Error('備份匯費不正確');
    if (c.cashFlowId !== undefined && (typeof c.cashFlowId !== 'string' || !c.cashFlowId || c.cashFlowId.length > 200)) throw new Error('流水關聯不正確');
    confirmations[id] = { event: { ...c.event }, shares: c.shares, received: c.received, confirmedAt: c.confirmedAt, ...(c.remittanceFee === undefined ? {} : { remittanceFee: c.remittanceFee }), ...(c.cashFlowId ? { cashFlowId: c.cashFlowId } : {}) };
  }
  const links = Object.values(confirmations).filter(c => c.received && c.cashFlowId).map(c => c.cashFlowId);
  if (new Set(links).size !== links.length) throw new Error('同一筆流水不能重複連結配息');
  return { version: 1, confirmations };
}

/** 保留賣出後的歷史確認紀錄；公告修正以新資料顯示，股數仍使用已確認快照。 */
export function relevantEvents(feed: Feed, holdings: Holding[], ledger: Ledger, transactionCodes: Set<string> = new Set()) {
  const codes = new Set([...holdings.map(h => String(h.stock_code).trim()), ...transactionCodes]);
  const events = new Map(Object.values(ledger.confirmations).map(c => [c.event.id, c.event]));
  for (const event of feed.events) if (codes.has(event.stockCode) || events.has(event.id)) events.set(event.id, event);
  return [...events.values()].sort((a, b) => (a.paymentDate || a.exDate).localeCompare(b.paymentDate || b.exDate));
}

/** 使用台北日期判斷發放日與過期狀態。 */
export function taipeiToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
}

/** 依發放日自動判斷入帳狀態。 */
export function dividendStatus(event: Dividend, _confirmation?: Confirmation, today = taipeiToday()) {
  if (!event.paymentDate) return '發放日未公告';
  if (event.paymentDate <= today) return '已入帳';
  if (event.cashPerShare === null) return '金額未公告';
  return '待發放';
}
