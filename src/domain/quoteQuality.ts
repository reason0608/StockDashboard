export interface InventoryQuote {
  stock_code?: unknown;
  current_price?: unknown;
  price_date?: unknown;
  quote_date?: unknown;
  price_updated_at?: unknown;
  updated_at?: unknown;
}

export interface QuoteQuality {
  level: 'ok' | 'warning' | 'error' | 'demo';
  validCount: number;
  invalidCodes: string[];
  missingDateCodes: string[];
  staleCodes: string[];
  oldestQuoteDate: string | null;
  newestQuoteDate: string | null;
}

/** 將試算表日期正規化為台北日曆日；無法辨識時回傳 null。 */
function quoteDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  }
  const parsed = new Date(value as string | number | Date);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
}

/** 計算兩日期間經過的週間日；週末不會讓星期五行情在星期一被誤判過期。 */
function elapsedWeekdays(from: string, to: string): number {
  let cursor = new Date(`${from}T12:00:00+08:00`);
  const end = new Date(`${to}T12:00:00+08:00`);
  let days = 0;
  while (cursor < end && days < 370) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(cursor);
    if (name !== 'Sat' && name !== 'Sun') days += 1;
  }
  return days;
}

/** 彙整庫存報價完整性與新鮮度，供畫面顯示而不依賴特定資料來源。 */
export function analyzeQuoteQuality(inventory: InventoryQuote[], now = new Date(), isDemo = false): QuoteQuality {
  if (isDemo) return { level: 'demo', validCount: inventory.length, invalidCodes: [], missingDateCodes: [], staleCodes: [], oldestQuoteDate: null, newestQuoteDate: null };
  const invalidCodes: string[] = [], missingDateCodes: string[] = [], staleCodes: string[] = [], dates: string[] = [];
  const today = quoteDate(now)!;
  let validCount = 0;
  for (const item of inventory) {
    const code = String(item.stock_code ?? '未知代號').trim();
    const price = Number(item.current_price);
    if (!Number.isFinite(price) || price <= 0) invalidCodes.push(code); else validCount += 1;
    const date = quoteDate(item.price_date ?? item.quote_date ?? item.price_updated_at ?? item.updated_at);
    if (!date) missingDateCodes.push(code);
    else { dates.push(date); if (elapsedWeekdays(date, today) > 1) staleCodes.push(code); }
  }
  return {
    level: invalidCodes.length ? 'error' : (missingDateCodes.length || staleCodes.length ? 'warning' : 'ok'),
    validCount, invalidCodes, missingDateCodes, staleCodes,
    oldestQuoteDate: dates.length ? [...dates].sort()[0] : null,
    newestQuoteDate: dates.length ? [...dates].sort().at(-1)! : null,
  };
}
