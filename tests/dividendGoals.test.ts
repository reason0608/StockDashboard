import { describe, expect, it } from 'vitest';
import { monthlyDividendPerShare, parseDividendGoalPlan, projectDividendGoalMonths, projectDividendGoals, trailingAnnualDividendPerShare } from '../src/domain/dividendGoals';
import type { Dividend } from '../src/domain/dividends';

const events: Dividend[] = [
  { id: '0056:2026-01-10', stockCode: '0056', stockName: 'ETF', exDate: '2026-01-10', paymentDate: '2026-02-01', cashPerShare: 1, source: 'TWSE', sourceUrl: 'https://example.com', updatedAt: '2026-02-01T00:00:00Z' },
  { id: '0056:2026-07-10', stockCode: '0056', stockName: 'ETF', exDate: '2026-07-10', paymentDate: '2026-08-01', cashPerShare: 1.5, source: 'TWSE', sourceUrl: 'https://example.com', updatedAt: '2026-08-01T00:00:00Z' }
];

describe('ETF 配息目標', () => {
  it('依近 12 月公告合計每股配息', () => expect(trailingAnnualDividendPerShare(events, '0056', '2026-10-14')).toBe(2.5));
  it('去除重複 ETF 並正規化代號', () => expect(parseDividendGoalPlan({ monthlyTarget: 1000, items: [{ stockCode: '0056', stockName: 'A' }, { stockCode: '0056', stockName: 'B' }] }).items).toHaveLength(1));
  it('股數依各發放月份反推，股價只影響資金', () => {
    const [result] = projectDividendGoals({ monthlyTarget: 1000, items: [{ stockCode: '0056', stockName: 'ETF' }] }, events, [{ stock_code: '0056', stock_name: 'ETF', total_shares: 1000, current_price: 40 }], '2026-10-14');
    expect(result.payoutMonths).toEqual([2, 8]);
    expect(result.recommendedShares).toBe(1000);
    expect(result.requiredShares).toBe(0);
    expect(result.requiredCapital).toBe(0);
  });
  it('沒有歷史配息時不猜測所需股數', () => expect(projectDividendGoals({ monthlyTarget: 1000, items: [{ stockCode: '00999', stockName: '新 ETF' }] }, events, [], '2026-10-14')[0].requiredShares).toBeNull());
  it('同月 ETF 依每股配息比例分攤目標金額', () => {
    const octoberEvents: Dividend[] = [
      { ...events[0], id: '00919:2026-09-20', stockCode: '00919', exDate: '2026-09-20', paymentDate: '2026-10-15', cashPerShare: 1.1 },
      { ...events[0], id: '00918:2026-09-21', stockCode: '00918', exDate: '2026-09-21', paymentDate: '2026-10-16', cashPerShare: 1.75 }
    ];
    const plan = { monthlyTarget: 1000, items: [{ stockCode: '00919', stockName: 'A' }, { stockCode: '00918', stockName: 'B' }] };
    const projections = projectDividendGoals(plan, octoberEvents, [], '2026-10-14');
    expect(projections.map(item => item.recommendedShares)).toEqual([351, 351]);
    const october = projectDividendGoalMonths(plan, projections)[9];
    expect(october.etfs[0].targetIncome).toBeCloseTo(1000 / 2.85 * 1.1);
    expect(october.etfs[1].targetIncome).toBeCloseTo(1000 / 2.85 * 1.75);
    expect(october.recommendedIncome).toBeCloseTo(1000.35);
  });
  it('每月資料採該曆月最新發放週期', () => {
    const profile = monthlyDividendPerShare([...events, { ...events[0], id: '0056:2025-01-10', exDate: '2025-01-10', paymentDate: '2025-02-01', cashPerShare: 9 }], '0056', '2026-10-14');
    expect(profile[2]).toBe(1);
  });
});
