import { test, expect } from '@playwright/test';

const fixtureEvent = { id: '2330:2026-06-11', stockCode: '2330', stockName: '台積電', exDate: '2026-06-11', paymentDate: '2026-07-09', cashPerShare: 6, source: '測試公告', sourceUrl: 'https://example.com/', updatedAt: '2026-09-18T00:00:00Z' };
const feed = { version: 1, updatedAt: '2026-09-18T00:00:00Z', sources: [], events: [fixtureEvent] };

test.beforeEach(async ({ page }) => {
  // 固定時間與公告，不因每日資料變動導致互動測試不穩定。
  await page.clock.setFixedTime(new Date('2026-09-18T04:00:00Z'));
  await page.route('**/data/dividends.json', route => route.fulfill({ json: feed }));
});

test('既有分頁與新增交易表單可操作，重新整理 hash 保留分頁', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await expect(page.locator('#card-total-assets')).not.toHaveText('$0');
  await page.locator('#tab-btn-inventory').click();
  await expect(page.locator('#inventory-table-body')).toContainText('2330');
  await expect(page.locator('#tab-content-inventory')).toContainText('已領股息');
  await expect(page.locator('#tab-content-inventory')).toContainText('未實現損益（不含息）');
  await expect(page.locator('#tab-content-inventory')).toContainText('含息報酬率');
  await expect(page.locator('#inventory-table-body tr').first().locator('td').nth(6)).toHaveText(/^\$1,(500|610)\.00$/);
  await page.reload();
  await expect(page.locator('#tab-content-inventory')).toBeVisible();
  await page.locator('#tab-btn-transactions').click();
  await page.getByRole('button', { name: '新增交易紀錄' }).click();
  await page.locator('#tx-code').fill('2317'); await page.locator('#tx-name').fill('鴻海');
  await page.locator('#tx-price').fill('100'); await page.locator('#tx-shares').fill('10');
  await page.locator('#transaction-form button[type=submit]').click();
  await expect(page.locator('#transactions-table-body')).toContainText('2317');
  await page.locator('#tab-btn-inventory').click();
  await expect(page.locator('#inventory-table-body')).toContainText('2317');
  expect(errors).toEqual([]);
});

test('發放日到達即自動入帳，重載與賣出後仍保留快照', async ({ page }) => {
  await page.goto('./#/dividends');
  await expect(page.locator('.dividends tbody')).toContainText('已入帳');
  await expect(page.locator('.dividends tbody')).toContainText('NT$ 110.00');
  await page.locator('#tab-btn-dashboard').click();
  await expect(page.locator('#card-total-dividends')).toHaveText('$1,610.00');
  await page.locator('#tab-btn-dividends').click();
  await page.evaluate(() => localStorage.setItem('demo_transactions', '[]'));
  await page.reload();
  await expect(page.locator('.dividends tbody')).toContainText('20');
  await expect(page.locator('.dividends tbody')).toContainText('NT$ 110.00');
});

test('股息頁不顯示備份與手動更新控制', async ({ page }) => {
  await page.goto('./#/dividends');
  await expect(page.getByRole('button', { name: '匯出股息備份' })).toHaveCount(0);
  await expect(page.getByText('匯入股息備份')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新讀取公告' })).toHaveCount(0);
  await expect(page.locator('.dividends tbody')).toContainText('已入帳');
});

test('公告更新失敗保留快取，手機畫面不超出頁寬', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/dividends');
  await expect(page.locator('.dividends tbody')).toContainText('2330');
  await page.route('**/data/dividends.json', route => route.abort());
  await page.reload();
  await expect(page.getByText('公告更新失敗，正在顯示上次成功快取，請留意更新時間。')).toBeVisible();
  await expect(page.locator('.dividends tbody')).toContainText('2330');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Sheets 持股與 Demo 快照分離，外部股票名稱不執行 HTML', async ({ page }) => {
  const gas = `https://script.google.com/macros/s/${'a'.repeat(60)}/exec`;
  await page.addInitScript(url => localStorage.setItem('sheet_api_url', url), gas);
  await page.route(gas, route => route.fulfill({ json: {
    cashFlow: [], transactions: [{ id: 'T1', date: '2026-01-01', stock_code: '2330', stock_name: '台積電', action: '買入', shares: 300, price: 100, fee: 0, tax: 0, total_amount: 30000 }], inventory: [{ stock_code: '2330', stock_name: '<img src=x onerror=alert(1)>', total_shares: 300, current_price: 100, market_value: 30000 }],
  } }));
  await page.goto('./#/inventory');
  await expect(page.locator('#inventory-table-body')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#inventory-table-body img')).toHaveCount(0);
  await page.locator('#tab-btn-dividends').click();
  await expect(page.getByText('目前為 Demo 持股。', { exact: false })).not.toBeVisible();
  await expect(page.locator('.dividends tbody')).toContainText('300');
  await expect(page.locator('.dividends tbody')).toContainText('已入帳');
  expect(await page.evaluate(() => !!localStorage.getItem('stock_dashboard_dividends_v1_personal'))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('stock_dashboard_dividends_v1_demo'))).toBeNull();
});
