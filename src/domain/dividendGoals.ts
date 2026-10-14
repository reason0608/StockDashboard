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
  etfs: { stockCode: string; dividendPerShare: number; targetIncome: number; currentIncome: number; recommendedShares: number }[];
  currentIncome: number;
  recommendedIncome: number;
}

export interface ReinvestmentCandidate extends DividendGoalItem {
  shares: number;
  currentPrice: number | null;
  marketValue: number;
  allocationPercent: number;
  equalWeightPercent: number;
  conservativeYieldPercent: number | null;
  nextPayoutMonth: number | null;
  affordableShares: number | null;
  addedConservativeAnnualIncome: number | null;
  reasons: string[];
}

/**
 * 取得現金流水帳的最新餘額。優先採最後一筆 account_balance，缺少時依收支類型重算。
 * 同日資料再以 ID 中的數字排序，與總覽看板維持相同規則。
 */
export function latestCashBalance(cashFlows: Record<string, unknown>[]): number {
  const sorted = [...cashFlows].sort((a, b) => {
    const dateDiff = String(a.date || '').localeCompare(String(b.date || ''));
    if (dateDiff) return dateDiff;
    const idNumber = (value: unknown) => Number(String(value || '').replace(/\D/g, '')) || 0;
    return idNumber(a.id) - idNumber(b.id);
  });
  const latest = sorted.at(-1);
  const recorded = Number(latest?.account_balance);
  if (latest && latest.account_balance !== '' && latest.account_balance != null && Number.isFinite(recorded)) return recorded;
  return Math.round(sorted.reduce((balance, flow) => {
    const amount = Number(flow.amount) || 0;
    return /支出|交割/.test(String(flow.type || '')) ? balance - Math.abs(amount) : balance + amount;
  }, 0) * 100) / 100;
}

/** 以目前選定 ETF 的價格與保守配息率估算完成年度缺口所需資金。 */
export function estimateAnnualGoalCapital(annualTarget: number, projectedAnnualIncome: number, projections: DividendGoalProjection[], safetyFactor = 0.85): number | null {
  const gap = Math.max(0, annualTarget - projectedAnnualIncome * safetyFactor);
  if (!gap) return 0;
  const usable = projections.filter(item => item.currentPrice && item.annualDividendPerShare > 0);
  if (!usable.length) return null;
  const currentMarketValue = usable.reduce((sum, item) => sum + item.shares * (item.currentPrice || 0), 0);
  const weightedYield = currentMarketValue > 0
    ? usable.reduce((sum, item) => sum + item.shares * item.annualDividendPerShare * safetyFactor, 0) / currentMarketValue
    : usable.reduce((sum, item) => sum + item.annualDividendPerShare * safetyFactor / (item.currentPrice || 1), 0) / usable.length;
  return weightedYield > 0 ? Math.ceil(gap / weightedYield) : null;
}

/**
 * 產生可解釋的再投入候選清單。因目前沒有歷史價格，僅以配置不足優先，
 * 再依保守殖利率及距下次發放月份排序，不把除息或單日價格誤判為回檔。
 */
export function rankReinvestmentCandidates(projections: DividendGoalProjection[], cashBalance: number, currentMonth: number, safetyFactor = 0.85): ReinvestmentCandidate[] {
  const withPrice = projections.filter(item => item.currentPrice !== null);
  const totalMarketValue = withPrice.reduce((sum, item) => sum + item.shares * (item.currentPrice || 0), 0);
  const equalWeightPercent = projections.length ? 100 / projections.length : 0;
  const monthDistance = (month: number) => (month - currentMonth + 12) % 12;
  return projections.map(item => {
    const currentPrice = item.currentPrice;
    const marketValue = currentPrice === null ? 0 : item.shares * currentPrice;
    const allocationPercent = totalMarketValue > 0 ? marketValue / totalMarketValue * 100 : 0;
    const conservativeYieldPercent = currentPrice && item.annualDividendPerShare > 0 ? item.annualDividendPerShare * safetyFactor / currentPrice * 100 : null;
    const nextPayoutMonth = item.payoutMonths.length ? [...item.payoutMonths].sort((a, b) => monthDistance(a) - monthDistance(b))[0] : null;
    const affordableShares = currentPrice ? Math.max(0, Math.floor(Math.max(0, cashBalance) / currentPrice)) : null;
    const addedConservativeAnnualIncome = affordableShares === null ? null : Math.round(affordableShares * item.annualDividendPerShare * safetyFactor * 100) / 100;
    const reasons: string[] = [];
    if (allocationPercent + 0.1 < equalWeightPercent) reasons.push('配置低於等權基準');
    if (conservativeYieldPercent !== null) reasons.push(`保守殖利率 ${conservativeYieldPercent.toFixed(2)}%`);
    if (nextPayoutMonth !== null) reasons.push(`下次預估 ${nextPayoutMonth} 月發放`);
    if (!reasons.length) reasons.push('資料不足，僅供觀察');
    return { ...item, shares: item.shares, currentPrice, marketValue, allocationPercent, equalWeightPercent, conservativeYieldPercent, nextPayoutMonth, affordableShares, addedConservativeAnnualIncome, reasons };
  }).sort((a, b) => {
    const aGap = a.equalWeightPercent - a.allocationPercent;
    const bGap = b.equalWeightPercent - b.allocationPercent;
    return bGap - aGap || (b.conservativeYieldPercent || 0) - (a.conservativeYieldPercent || 0)
      || (a.nextPayoutMonth === null ? 99 : monthDistance(a.nextPayoutMonth)) - (b.nextPayoutMonth === null ? 99 : monthDistance(b.nextPayoutMonth));
  });
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
      currentIncome: Math.round(item.shares * item.monthlyDividendPerShare[month] * 100) / 100,
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
