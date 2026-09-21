import { describe, expect, it } from 'vitest';
import { DEFAULT_REMITTANCE_FEE, eligibleShares, isDividendReceived, netDividend, realizedDividends, realizedDividendsByStock, realizedDividendsSince, tradingDate } from '../src/domain/entitlements';
import type { Dividend, Ledger } from '../src/domain/dividends';

const event: Dividend = { id: '2330:2026-06-11', stockCode: '2330', stockName: '台積電', exDate: '2026-06-11', paymentDate: '2026-07-09', cashPerShare: 6, source: 'test', sourceUrl: 'https://example.com/', updatedAt: '2026-09-18T00:00:00Z' };

describe('每日交易紀錄串聯除息股數', () => {
  it('只累計除息日前交易；沒有資料的日期不會產生交易', () => {
    const result = eligibleShares([
      { date: '2026-06-01', stock_code: '2330', action: '買入', shares: 100 },
      { date: '2026-06-05', stock_code: '2330', action: '賣出', shares: 20 },
      { date: '2026-06-11', stock_code: '2330', action: '買入', shares: 999 },
      { date: '2026-06-12', stock_code: '2330', action: '賣出', shares: 80 },
    ], event);
    expect(result).toEqual({ shares: 80, error: null });
  });
  it('同日買賣用淨額計算，不依資料列順序產生假負庫存', () => {
    expect(eligibleShares([
      { date: '2026-06-01', stock_code: '2330', action: '賣出', shares: 50 },
      { date: '2026-06-01', stock_code: '2330', action: '買入', shares: 100 },
    ], event)).toEqual({ shares: 50, error: null });
  });
  it('錯誤日期、負庫存或無效類別會停止估算', () => {
    expect(eligibleShares([{ date: 'bad', stock_code: '2330', action: '買入', shares: 10 }], event).shares).toBeNull();
    expect(eligibleShares([{ date: '2026-06-01', stock_code: '2330', action: '賣出', shares: 10 }], event).shares).toBeNull();
    expect(eligibleShares([{ date: '2026-06-01', stock_code: '2330', action: '其他', shares: 10 }], event).shares).toBeNull();
  });
  it('含時區日期以台北日曆日判斷', () => expect(tradingDate('2026-06-10T16:30:00Z')).toBe('2026-06-11'));
});

describe('匯費與已落袋股息', () => {
  it('淨額預設扣除固定匯費，且最低為零', () => {
    expect(DEFAULT_REMITTANCE_FEE).toBe(10);
    expect(netDividend(1200, 10)).toBe(1190);
    expect(netDividend(1200, undefined)).toBe(1190);
    expect(netDividend(5)).toBe(0);
    expect(() => netDividend(100, 0.001)).toThrow();
  });
  it('發放日到達即視為已入帳', () => {
    expect(isDividendReceived(event, '2026-07-08')).toBe(false);
    expect(isDividendReceived(event, '2026-07-09')).toBe(true);
  });
  it('同股票同發放日唯一現金流水會去重', () => {
    const ledger: Ledger = { version: 1, confirmations: { [event.id]: { event, shares: 20, confirmedAt: '2026-07-09', received: true, remittanceFee: 10 } } };
    const flows = [{ id: 'FLOW_1', date: '2026-07-09', stock_code: '2330', type: '股息流入', amount: 110 }];
    expect(realizedDividends(flows, ledger)).toBe(110);
    expect(realizedDividendsByStock(flows, ledger)).toEqual({ '2330': 110 });
  });
  it('沒有對應流水時仍把已到發放日淨額加入總覽', () => {
    const ledger: Ledger = { version: 1, confirmations: { [event.id]: { event, shares: 20, confirmedAt: '2026-07-09', received: true, remittanceFee: 10 } } };
    expect(realizedDividends([], ledger)).toBe(110);
    const future = { ...event, paymentDate: '2099-07-09' };
    const futureLedger: Ledger = { version: 1, confirmations: { [future.id]: { event: future, shares: 20, confirmedAt: '2026-07-09', received: true, remittanceFee: 10 } } };
    expect(realizedDividends([], futureLedger)).toBe(0);
  });
  it('近十二月股息依發放日及流水日期篩選', () => {
    const ledger: Ledger = { version: 1, confirmations: { [event.id]: { event, shares: 20, confirmedAt: '2026-07-09', received: true, remittanceFee: 10 } } };
    const oldFlow = [{ id: 'OLD', date: '2024-01-01', stock_code: '0050', type: '股息流入', amount: 999 }];
    expect(realizedDividendsSince(oldFlow, ledger, '2025-09-18')).toBe(110);
    expect(realizedDividendsSince(oldFlow, ledger, '2026-08-01')).toBe(0);
  });
});
