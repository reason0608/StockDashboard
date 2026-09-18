import { estimateDividend, isDate, taipeiToday, type Confirmation, type Dividend, type Ledger } from './dividends';

export interface Transaction { id?: string; date: string; stock_code: string; action: string; shares: number | string }
export interface CashFlow { id: string; date: string; stock_code?: string; type: string; amount: number | string }

/** 將試算表的日期／含時區時間轉為台北日曆日期，不以 UTC 截斷交易日。 */
export function tradingDate(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  const plain = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (plain) {
    const result = `${plain[1]}-${plain[2].padStart(2, '0')}-${plain[3].padStart(2, '0')}`;
    return isDate(result) ? result : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date(raw));
}

/** 完整交易帳自零開始，累加除息日前買入減賣出；無交易日期不需補列。 */
export function eligibleShares(transactions: Transaction[], event: Dividend, today = taipeiToday()): { shares: number | null; error: string | null } {
  const daily = new Map<string, number>();
  for (const t of transactions) {
    if (String(t.stock_code).trim() !== event.stockCode) continue;
    const date = tradingDate(t.date);
    if (!date) return { shares: null, error: '交易日期無法辨識，請修正每日交易紀錄。' };
    if (date >= event.exDate || date > today) continue;
    const shares = typeof t.shares === 'string' && !t.shares.trim() ? NaN : Number(t.shares);
    const action = String(t.action).trim();
    if (!Number.isSafeInteger(shares) || shares <= 0 || !['買入', '賣出'].includes(action)) return { shares: null, error: '交易股數或買賣類別不正確，請修正每日交易紀錄。' };
    daily.set(date, (daily.get(date) || 0) + (action === '買入' ? shares : -shares));
  }
  let total = 0;
  // 按日淨額處理，避免同日沖銷因來源列順序造成暫時負庫存。
  for (const [, delta] of [...daily].sort(([a], [b]) => a.localeCompare(b))) {
    total += delta;
    if (!Number.isSafeInteger(total) || total < 0) return { shares: null, error: '交易累計出現負庫存，請核對買賣紀錄。' };
  }
  return { shares: total, error: null };
}

/** 扣除單次匯費；未設定費用保留未知，不能假設免收費。 */
export function netDividend(gross: number | null, fee: number | undefined): number | null {
  if (gross === null) return null;
  if (gross === 0) return 0;
  if (fee === undefined) return null;
  if (!Number.isFinite(fee) || fee < 0 || Math.round(fee * 100) !== fee * 100 || fee > gross) throw new Error('匯費須為非負金額、最多兩位小數，且不得超過股息。');
  return Math.round((gross - fee) * 100) / 100;
}

/** 已入帳採當時快照；尚未入帳隨交易紀錄更新，舊手動股數不覆蓋交易推算。 */


export function resolvedShares(event: Dividend, transactions: Transaction[], c?: Confirmation) {
  return c?.received ? c.shares : eligibleShares(transactions, event).shares;
}

/** 顯示交易紀錄中曾持有的股票；沒有交易的日期自然不產生任何股數變動。 */
export function transactionStockCodes(transactions: Transaction[]): Set<string> {
  return new Set(transactions.map(t => String(t.stock_code).trim()).filter(code => /^[0-9A-Z]{4,10}$/.test(code)));
}

/** 僅將股息／配息現金流水納入股息合計，排除活存利息。 */
export function isDividendFlow(flow: CashFlow) { return /股息|配息/.test(flow.type); }

/** 顯示可連結的流水，讓已記帳的配息只計一次。 */
export function matchingFlows(event: Dividend, flows: CashFlow[]) {
  return flows.filter(f => isDividendFlow(f) && String(f.stock_code).trim() === event.stockCode && tradingDate(f.date) === event.paymentDate);
}

/** 合併本機已入帳淨額與既有流水；明確連結或唯一同股票同發放日流水只計一次。 */
export function realizedDividends(flows: CashFlow[], ledger: Ledger): number {
  const excluded = new Set<string>();
  let total = 0;
  for (const c of Object.values(ledger.confirmations)) {
    if (!c.received) continue;
    const net = netDividend(estimateDividend(c.shares, c.event.cashPerShare), c.remittanceFee);
    if (net === null) continue;
    if (c.cashFlowId) excluded.add(c.cashFlowId);
    else {
      const candidates = matchingFlows(c.event, flows);
      // 同日僅一筆時自動去重；多筆需使用者明確指定，不猜測哪一筆。
      if (candidates.length === 1) excluded.add(String(candidates[0].id));
      else if (candidates.length > 1) continue;
    }
    total += net;
  }
  for (const flow of flows) {
    if (isDividendFlow(flow) && !excluded.has(String(flow.id))) {
      const value = Number(flow.amount);
      if (Number.isFinite(value)) total += value;
    }
  }
  return Math.round(total * 100) / 100;
}
