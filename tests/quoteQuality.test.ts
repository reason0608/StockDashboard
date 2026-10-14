import { describe, expect, it } from 'vitest';
import { analyzeQuoteQuality, calculateTransactionPricePerformance } from '../src/domain/quoteQuality';

describe('持股行情資料品質', () => {
  const now = new Date('2026-09-21T08:00:00+08:00');

  it('有效且最近交易日報價顯示正常', () => {
    expect(analyzeQuoteQuality([{ stock_code: '0050', current_price: 65.5, price_date: '2026-09-18' }], now)).toMatchObject({
      level: 'ok', validCount: 1, newestQuoteDate: '2026-09-18', staleCodes: [],
    });
  });

  it('辨識無效價格、缺少日期與過期資料', () => {
    const result = analyzeQuoteQuality([
      { stock_code: '0050', current_price: '#N/A', price_date: '2026-09-18' },
      { stock_code: '00878', current_price: 22, price_date: '2026-09-16' },
      { stock_code: '00919', current_price: 21 },
    ], now);
    expect(result.level).toBe('error');
    expect(result.invalidCodes).toEqual(['0050']);
    expect(result.staleCodes).toEqual(['00878']);
    expect(result.missingDateCodes).toEqual(['00919']);
  });

  it('Demo 報價不冒充雲端即時行情', () => {
    expect(analyzeQuoteQuality([{ stock_code: '0050', current_price: 65 }], now, true).level).toBe('demo');
  });

  it('單筆買入只計最新報價價差，不含費用與配息', () => {
    expect(calculateTransactionPricePerformance({ action: '買入', price: 50, shares: 20 }, 55)).toEqual({ currentPrice: 55, priceDifference: 5, profitLoss: 100, returnPercent: 10 });
    expect(calculateTransactionPricePerformance({ action: '買入', price: 50, shares: 20 }, 45)).toEqual({ currentPrice: 45, priceDifference: -5, profitLoss: -100, returnPercent: -10 });
  });

  it('賣出或缺少有效報價時不臆測交易損益', () => {
    expect(calculateTransactionPricePerformance({ action: '賣出', price: 50, shares: 20 }, 55)).toBeNull();
    expect(calculateTransactionPricePerformance({ action: '買入', price: 50, shares: 20 }, '#N/A')).toBeNull();
  });
});
