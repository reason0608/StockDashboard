import { describe, expect, it } from 'vitest';
import { parseDividendGoalPlan, projectDividendGoals, trailingAnnualDividendPerShare } from '../src/domain/dividendGoals';
import type { Dividend } from '../src/domain/dividends';

const events: Dividend[] = [
  { id: '0056:2026-01-10', stockCode: '0056', stockName: 'ETF', exDate: '2026-01-10', paymentDate: '2026-02-01', cashPerShare: 1, source: 'TWSE', sourceUrl: 'https://example.com', updatedAt: '2026-02-01T00:00:00Z' },
  { id: '0056:2026-07-10', stockCode: '0056', stockName: 'ETF', exDate: '2026-07-10', paymentDate: '2026-08-01', cashPerShare: 1.5, source: 'TWSE', sourceUrl: 'https://example.com', updatedAt: '2026-08-01T00:00:00Z' }
];

describe('ETF 配息目標', () => {
  it('依近 12 月公告合計每股配息', () => expect(trailingAnnualDividendPerShare(events, '0056', '2026-10-14')).toBe(2.5));
  it('去除重複 ETF 並正規化代號', () => expect(parseDividendGoalPlan({ monthlyTarget: 1000, items: [{ stockCode: '0056', stockName: 'A' }, { stockCode: '0056', stockName: 'B' }] }).items).toHaveLength(1));
  it('股數由配息反推，股價只影響資金', () => {
    const [result] = projectDividendGoals({ monthlyTarget: 1000, items: [{ stockCode: '0056', stockName: 'ETF' }] }, events, [{ stock_code: '0056', stock_name: 'ETF', total_shares: 1000, current_price: 40 }], '2026-10-14');
    expect(result.requiredShares).toBe(3800);
    expect(result.requiredCapital).toBe(152000);
  });
  it('沒有歷史配息時不猜測所需股數', () => expect(projectDividendGoals({ monthlyTarget: 1000, items: [{ stockCode: '00999', stockName: '新 ETF' }] }, events, [], '2026-10-14')[0].requiredShares).toBeNull());
});
