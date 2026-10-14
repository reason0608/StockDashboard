import { parseFeed, parseLedger, type Feed, type Ledger } from '../domain/dividends';
import { parseDividendGoalPlan, type DividendGoalPlan } from '../domain/dividendGoals';

const cacheKey = 'stock_dashboard_dividend_feed_v1';
/** Demo 與個人帳務分開儲存，避免將示範股數帶入真實持股。 */
export function ledgerKey(isDemo: boolean) { return `stock_dashboard_dividends_v1_${isDemo ? 'demo' : 'personal'}`; }

/** 讀取已確認股數，毀損時保留原檔並讓 UI 顯示錯誤，避免靜默覆寫。 */
export function loadLedger(isDemo: boolean): Ledger {
  const saved = localStorage.getItem(ledgerKey(isDemo));
  return saved ? parseLedger(JSON.parse(saved)) : { version: 1, confirmations: {} };
}

/** 先驗證再存檔；quota 或隱私模式失敗由畫面明確回報。 */
export function saveLedger(isDemo: boolean, ledger: Ledger) {
  localStorage.setItem(ledgerKey(isDemo), JSON.stringify(parseLedger(ledger)));
}

/** 讀同站公告，網路或格式失敗時回退至驗證過的上一份快取。 */
export async function loadFeed(): Promise<{ feed: Feed; warning: string }> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/dividends.json`, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const feed = parseFeed(await response.json());
    let warning = '';
    try { localStorage.setItem(cacheKey, JSON.stringify(feed)); } catch { warning = '瀏覽器無法快取公告；離線時可能無法讀取。'; }
    return { feed, warning };
  } catch {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return { feed: parseFeed(JSON.parse(cached)), warning: '公告更新失敗，正在顯示上次成功快取，請留意更新時間。' };
    throw new Error('目前無法讀取配息公告，請稍後重試。');
  }
}

/** 將目標與 0 庫存占位列交由同一 Apps Script 請求處理，避免部分成功。 */
export async function saveDividendGoals(apiUrl: string, plan: DividendGoalPlan): Promise<DividendGoalPlan> {
  const response = await fetch(apiUrl, { method: 'POST', body: JSON.stringify({ action: 'saveDividendGoals', plan: parseDividendGoalPlan(plan) }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== 'success') throw new Error(result.message || 'ETF 目標儲存失敗');
  return parseDividendGoalPlan(result.plan ?? plan);
}
