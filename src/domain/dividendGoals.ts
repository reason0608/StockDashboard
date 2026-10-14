import type { Dividend, Holding } from './dividends';

export interface DividendGoalItem {
  stockCode: string;
  stockName: string;
}

export interface DividendGoalPlan {
  monthlyTarget: number;
  items: DividendGoalItem[];
}

export interface DividendGoalProjection extends DividendGoalItem {
  shares: number;
  annualDividendPerShare: number;
  projectedAnnualIncome: number;
  requiredShares: number | null;
  currentPrice: number | null;
  requiredCapital: number | null;
}

/** 驗證儲存內容並依股票代號去重，避免重複建立庫存占位列。 */
export function parseDividendGoalPlan(value: unknown): DividendGoalPlan {
  const plan = value as DividendGoalPlan;
  const monthlyTarget = Number(plan?.monthlyTarget);
  if (!Number.isFinite(monthlyTarget) || monthlyTarget < 0 || monthlyTarget > 1_000_000_000) throw new Error('每月配息目標不正確');
  if (!Array.isArray(plan?.items) || plan.items.length > 100) throw new Error('ETF 目標清單不正確');
  const seen = new Set<string>();
  const items = plan.items.map(item => ({
    stockCode: String(item?.stockCode || '').trim().toUpperCase(),
    stockName: String(item?.stockName || '').trim().slice(0, 200)
  })).filter(item => {
    if (!/^[0-9A-Z]{4,10}$/.test(item.stockCode) || seen.has(item.stockCode)) return false;
    seen.add(item.stockCode);
    return true;
  });
  return { monthlyTarget, items };
}

/** 最近 12 個月實際公告合計；同一次除息事件只計一次。 */
export function trailingAnnualDividendPerShare(events: Dividend[], stockCode: string, today: string): number {
  const end = Date.parse(today);
  const start = end - 365 * 86400000;
  const seen = new Set<string>();
  const total = events.reduce((sum, event) => {
    const date = event.paymentDate || event.exDate;
    const timestamp = Date.parse(date);
    if (event.stockCode !== stockCode || event.cashPerShare === null || timestamp < start || timestamp > end || seen.has(event.id)) return sum;
    seen.add(event.id);
    return sum + event.cashPerShare;
  }, 0);
  return Math.round((total + Number.EPSILON) * 1e8) / 1e8;
}

/** 以等額配息目標反推缺少股數；股價只影響所需資金，不影響股數。 */
export function projectDividendGoals(plan: DividendGoalPlan, events: Dividend[], holdings: Holding[], today: string): DividendGoalProjection[] {
  const annualTargetPerItem = plan.items.length ? plan.monthlyTarget * 12 / plan.items.length : 0;
  return plan.items.map(item => {
    const holding = holdings.find(row => String(row.stock_code).trim() === item.stockCode);
    const shares = Math.max(0, Number(holding?.total_shares) || 0);
    const annualDividendPerShare = trailingAnnualDividendPerShare(events, item.stockCode, today);
    const projectedAnnualIncome = Math.round((shares * annualDividendPerShare + Number.EPSILON) * 100) / 100;
    const requiredShares = annualDividendPerShare > 0 ? Math.max(0, Math.ceil((annualTargetPerItem - projectedAnnualIncome) / annualDividendPerShare)) : null;
    const price = Number(holding?.current_price);
    const currentPrice = Number.isFinite(price) && price > 0 ? price : null;
    return {
      ...item, shares, annualDividendPerShare, projectedAnnualIncome, requiredShares, currentPrice,
      requiredCapital: requiredShares !== null && currentPrice !== null ? Math.round(requiredShares * currentPrice) : null
    };
  });
}
