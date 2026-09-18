import { describe, expect, it } from 'vitest';
import { dividendStatus, estimateDividend, isDate, parseFeed, parseLedger, relevantEvents, type Dividend, type Feed, type Ledger } from '../src/domain/dividends';
import { normalizeDate, nullableCash, parseExchange, parseEtf, parseFinMind, mergeEvents } from '../scripts/dividend-sources.mjs';
import { escapeHtml } from '../src/shared/format.js';

const event: Dividend = { id: '0050:2026-07-21', stockCode: '0050', stockName: '元大台灣50', exDate: '2026-07-21', paymentDate: '2026-08-10', cashPerShare: 0.6, source: 'test', sourceUrl: 'https://example.com/', updatedAt: '2026-09-18T00:00:00Z' };
const feed: Feed = { version: 1, updatedAt: event.updatedAt, sources: [], events: [event] };
const ledger: Ledger = { version: 1, confirmations: { [event.id]: { event, shares: 2000, received: false, confirmedAt: '2026-07-20' } } };

describe('股息計算與歷史快照', () => {
  it('計算零股與小數金額，不將缺值當零', () => {
    expect(estimateDividend(2000, 3)).toBe(6000);
    expect(estimateDividend(3, 0.1)).toBe(0.3);
    expect(estimateDividend(0, 3)).toBe(0);
    expect(estimateDividend(null, 3)).toBeNull();
    expect(estimateDividend(2000, null)).toBeNull();
  });
  it.each([-1, 1.5, Infinity, NaN])('拒絕無效股數 %s', shares => expect(() => estimateDividend(shares, 1)).toThrow());
  it('股數確認不受現在持股變化或全部賣出影響', () => {
    const events = relevantEvents(feed, [], ledger);
    expect(events).toHaveLength(1);
    expect(estimateDividend(ledger.confirmations[event.id].shares, events[0].cashPerShare)).toBe(1200);
  });
  it('依發放日自動判定入帳', () => {
    expect(dividendStatus(event, undefined, '2026-09-18')).toBe('已入帳');
    expect(dividendStatus(event, ledger.confirmations[event.id], '2026-07-21')).toBe('待發放');
    expect(dividendStatus(event, ledger.confirmations[event.id], '2026-09-18')).toBe('已入帳');
    expect(dividendStatus({ ...event, paymentDate: null }, ledger.confirmations[event.id])).toBe('發放日未公告');
  });
  it('公告更正更新金額、保持快照股數', () => {
    const events = relevantEvents({ ...feed, events: [{ ...event, cashPerShare: 0.8 }] }, [], ledger);
    expect(events[0].cashPerShare).toBe(0.8);
    expect(ledger.confirmations[event.id].shares).toBe(2000);
  });
});

describe('外部檔案驗證', () => {
  it('接受合法公告與備份', () => { expect(parseFeed(feed)).toEqual(feed); expect(parseLedger(ledger)).toEqual(ledger); });
  it('拒絕重複事件、不合法連結與不存在日期', () => {
    expect(() => parseFeed({ ...feed, events: [event, event] })).toThrow();
    expect(() => parseFeed({ ...feed, events: [{ ...event, sourceUrl: 'javascript:alert(1)' }] })).toThrow();
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2024-02-29')).toBe(true);
  });
  it('拒絕非法備份股數與識別鍵', () => {
    expect(() => parseLedger({ ...ledger, confirmations: { bad: ledger.confirmations[event.id] } })).toThrow();
    expect(() => parseLedger({ ...ledger, confirmations: { [event.id]: { ...ledger.confirmations[event.id], shares: -5 } } })).toThrow();
  });
  it('舊頁面外部文字跳脫而非執行 HTML', () => expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

describe('公開來源轉換', () => {
  it('處理民國日期及尚未公告的金額', () => {
    expect(normalizeDate('1150918')).toBe('2026-09-18');
    expect(normalizeDate('115年09月18日')).toBe('2026-09-18');
    expect(nullableCash('尚未公告')).toBeNull();
    expect(nullableCash('')).toBeNull();
    expect(nullableCash('0')).toBe(0);
    expect(() => normalizeDate('115年02月30日')).toThrow();
  });
  it('保留上櫃未公告配息，排除純除權', () => {
    const rows = [{ ExRrightsExDividend: '除息', SecuritiesCompanyCode: '00836B', CompanyName: '債券', ExRrightsExDividendDate: '1150923', CashDividend: '尚未公告' }, { ExRrightsExDividend: '除權' }];
    expect(parseExchange(rows, 'TPEX', event.updatedAt)).toMatchObject([{ stockCode: '00836B', cashPerShare: null, paymentDate: null }]);
  });
  it('ETF 欄位重排仍能正確取得發放日，缺少欄位則失敗', () => {
    const payload = { status: 'ok', fields: ['收益分配發放日', '證券代號', '除息交易日', '證券簡稱', '收益分配金額 (每1受益權益單位)'], data: [['115年08月10日', '0050', '115年07月21日', 'ETF', '0.6']] };
    expect(parseEtf(payload, event.updatedAt)[0]).toMatchObject({ paymentDate: '2026-08-10', cashPerShare: 0.6 });
    expect(() => parseEtf({ ...payload, fields: [] }, event.updatedAt)).toThrow();
  });
  it('FinMind 加總現金盈餘和公積，重複修正僅取最新一筆', () => {
    const row = { stock_id: '0050', CashExDividendTradingDate: '2026-07-21', CashDividendPaymentDate: '2026-08-10', CashEarningsDistribution: 0.4, CashStatutorySurplus: 0.2 };
    const rows = parseFinMind({ status: 200, data: [{ ...row, date: '2026-07-01' }, { ...row, date: '2026-07-02', CashEarningsDistribution: 0.6 }] }, 'ETF', event.updatedAt);
    expect(rows).toHaveLength(1); expect(rows[0].cashPerShare).toBe(0.8);
  });
  it('FinMind 只補官方缺漏，不蓋過官方每股金額', () => {
    const rows = mergeEvents([{ ...event, paymentDate: null }], [{ ...event, source: 'FinMind 股利政策', cashPerShare: 999 }]);
    expect(rows[0].cashPerShare).toBe(0.6); expect(rows[0].paymentDate).toBe('2026-08-10');
  });
});
