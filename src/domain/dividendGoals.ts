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
  payoutMonths: number[];
  monthlyDividendPerShare: Record<number, number>;
  recommendedShares: number | null;
  requiredShares: number | null;
  currentPrice: number | null;
  requiredCapital: number | null;
}

export interface DividendGoalMonthProjection {
  month: number;
  etfs: { stockCode: string; dividendPerShare: number; targetIncome: number; recommendedShares: number }[];
  currentIncome: number;
  recommendedIncome: number;
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

/** 依最近約一年半與已公告近期資料，取得各曆月最新一次發放週期的每股配息。 */
export function monthlyDividendPerShare(events: Dividend[], stockCode: string, today: string): Record<number, number> {
  const anchor = new Date(`${today}T00:00:00Z`);
  const start = new Date(anchor); start.setUTCMonth(start.getUTCMonth() - 18);
  const end = new Date(anchor); end.setUTCMonth(end.getUTCMonth() + 6);
  const periods = new Map<string, number>();
  const seen = new Set<string>();
  for (const event of events) {
    if (event.stockCode !== stockCode || !event.paymentDate || event.cashPerShare === null || seen.has(event.id)) continue;
    const timestamp = Date.parse(event.paymentDate);
    if (timestamp < start.getTime() || timestamp > end.getTime()) continue;
    seen.add(event.id);
    const period = event.paymentDate.slice(0, 7);
    periods.set(period, (periods.get(period) || 0) + event.cashPerShare);
  }
  const latestByMonth = new Map<number, { period: string; amount: number }>();
  for (const [period, amount] of periods) {
    const month = Number(period.slice(5, 7));
    const current = latestByMonth.get(month);
    if (!current || period > current.period) latestByMonth.set(month, { period, amount });
  }
  return Object.fromEntries([...latestByMonth].map(([month, value]) => [month, Math.round((value.amount + Number.EPSILON) * 1e8) / 1e8]));
}

/** 每月目標依當月每股配息比例分攤；同一 ETF 採各發放月所需總股數的最大值。 */
export function projectDividendGoals(plan: DividendGoalPlan, events: Dividend[], holdings: Holding[], today: string): DividendGoalProjection[] {
  const profiles = new Map(plan.items.map(item => [item.stockCode, monthlyDividendPerShare(events, item.stockCode, today)]));
  const monthlyDividendTotals = new Map<number, number>();
  for (const profile of profiles.values()) for (const month of Object.keys(profile).map(Number)) monthlyDividendTotals.set(month, (monthlyDividendTotals.get(month) || 0) + profile[month]);
  return plan.items.map(item => {
    const holding = holdings.find(row => String(row.stock_code).trim() === item.stockCode);
    const shares = Math.max(0, Number(holding?.total_shares) || 0);
    const monthlyProfile = profiles.get(item.stockCode) || {};
    const payoutMonths = Object.keys(monthlyProfile).map(Number).sort((a, b) => a - b);
    const annualDividendPerShare = Math.round((Object.values(monthlyProfile).reduce((sum, value) => sum + value, 0) + Number.EPSILON) * 1e8) / 1e8;
    const projectedAnnualIncome = Math.round((shares * annualDividendPerShare + Number.EPSILON) * 100) / 100;
    // 目標金額依每股配息占比分配後再除回每股配息，等價於同月 ETF 採相同目標股數。
    const candidates = payoutMonths.map(month => Math.ceil(plan.monthlyTarget / (monthlyDividendTotals.get(month) || monthlyProfile[month])));
    const recommendedShares = candidates.length ? Math.max(...candidates) : null;
    const requiredShares = recommendedShares === null ? null : Math.max(0, recommendedShares - shares);
    const price = Number(holding?.current_price);
    const currentPrice = Number.isFinite(price) && price > 0 ? price : null;
    return {
      ...item, shares, annualDividendPerShare, projectedAnnualIncome, payoutMonths, monthlyDividendPerShare: monthlyProfile, recommendedShares, requiredShares, currentPrice,
      requiredCapital: requiredShares !== null && currentPrice !== null ? Math.round(requiredShares * currentPrice) : null
    };
  });
}

/** 產生 1–12 月覆蓋表，沒有 ETF 發放的月份保留空清單供畫面警示。 */
export function projectDividendGoalMonths(plan: DividendGoalPlan, projections: DividendGoalProjection[]): DividendGoalMonthProjection[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const active = projections.filter(item => item.monthlyDividendPerShare[month] > 0);
    const totalDividendPerShare = active.reduce((sum, item) => sum + item.monthlyDividendPerShare[month], 0);
    const etfs = active.map(item => ({
      stockCode: item.stockCode,
      dividendPerShare: item.monthlyDividendPerShare[month],
      targetIncome: totalDividendPerShare > 0 ? plan.monthlyTarget * item.monthlyDividendPerShare[month] / totalDividendPerShare : 0,
      recommendedShares: totalDividendPerShare > 0 ? Math.ceil(plan.monthlyTarget / totalDividendPerShare) : 0
    }));
    return {
      month,
      etfs,
      currentIncome: Math.round(active.reduce((sum, item) => sum + item.shares * item.monthlyDividendPerShare[month], 0) * 100) / 100,
      recommendedIncome: Math.round(active.reduce((sum, item) => sum + (item.recommendedShares || 0) * item.monthlyDividendPerShare[month], 0) * 100) / 100
    };
  });
}
