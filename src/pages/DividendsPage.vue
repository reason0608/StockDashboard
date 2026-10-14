<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { reloadData, state } from '../legacy/dashboard.js';
import { estimateDividend, parseLedger, relevantEvents, taipeiToday, type Dividend, type Feed, type Holding, type Ledger } from '../domain/dividends';
import { loadFeed, loadLedger, saveDividendGoals, saveLedger } from '../services/dividends';
import { DEFAULT_REMITTANCE_FEE, eligibleShares, isDividendReceived, netDividend, resolvedShares, transactionStockCodes, type Transaction } from '../domain/entitlements';
import { estimateAnnualGoalCapital, latestCashBalance, parseDividendGoalPlan, projectDividendGoalMonths, projectDividendGoals, rankReinvestmentCandidates, type DividendGoalItem } from '../domain/dividendGoals';

const feed = ref<Feed>({ version: 1, updatedAt: null, events: [], sources: [] });
const ledger = ref<Ledger>({ version: 1, confirmations: {} });
const holdings = ref<Holding[]>([]);
const transactions = ref<Transaction[]>([]);
const cashFlows = ref<Record<string, unknown>[]>([]);
const isDemo = ref(true);
const portfolioReady = ref(false);
const loading = ref(false);
const warning = ref('');
const error = ref('');
const storageError = ref(false);
const goalSaving = ref(false);
const goalMessage = ref('');
const goalMonthly = ref(0);
const goalItems = ref<DividendGoalItem[]>([]);
const savedGoalMonthly = ref(0);
const savedGoalItems = ref<DividendGoalItem[]>([]);
const goalLoaded = ref(false);
const newGoalCode = ref('');
const search = ref('');
const year = ref(taipeiToday().slice(0, 4));
const goalView = ref<'overview' | 'months' | 'candidates'>('overview');
const goalTabs = [
  { id: 'overview' as const, label: '目標與ETF' },
  { id: 'months' as const, label: '12個月分布' },
  { id: 'candidates' as const, label: '再投入候選' }
];
const allEvents = computed(() => relevantEvents(feed.value, holdings.value, ledger.value, transactionStockCodes(transactions.value)));
const years = computed(() => [...new Set([taipeiToday().slice(0, 4), ...allEvents.value.map(e => (e.paymentDate || e.exDate).slice(0, 4))])].sort().reverse());
const annual = computed(() => allEvents.value.filter(e => (e.paymentDate || e.exDate).startsWith(year.value)));
const visible = computed(() => annual.value.filter(e => `${e.stockCode} ${e.stockName}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const missing = computed(() => holdings.value.filter(h => !annual.value.some(e => e.stockCode === String(h.stock_code))));
const stale = computed(() => !feed.value.updatedAt || Date.now() - Date.parse(feed.value.updatedAt) > 3 * 86400000);
const pendingCount = computed(() => annual.value.filter(e => netAmount(e) === null).length);
const awaiting = computed(() => annual.value.reduce((sum, e) => sum + (isDividendReceived(e) ? 0 : netAmount(e) ?? 0), 0));
const received = computed(() => annual.value.reduce((sum, e) => sum + (isDividendReceived(e) ? netAmount(e) ?? 0 : 0), 0));
const undated = computed(() => annual.value.filter(e => !e.paymentDate).length);
const etfOptions = computed(() => {
  const map = new Map<string, string>();
  feed.value.events.forEach(event => map.set(event.stockCode, event.stockName));
  return [...map].map(([stockCode, stockName]) => ({ stockCode, stockName })).sort((a, b) => a.stockCode.localeCompare(b.stockCode));
});
const goalPlan = computed(() => parseDividendGoalPlan({ monthlyTarget: goalMonthly.value, items: goalItems.value }));
const goalProjection = computed(() => projectDividendGoals(goalPlan.value, feed.value.events, holdings.value, taipeiToday()));
const goalMonthProjection = computed(() => projectDividendGoalMonths(goalPlan.value, goalProjection.value));
const projectedMonthlyIncome = computed(() => goalMonthProjection.value.reduce((sum, item) => sum + item.currentIncome, 0) / 12);
const projectedAnnualIncome = computed(() => goalProjection.value.reduce((sum, item) => sum + item.projectedAnnualIncome, 0));
const conservativeAnnualIncome = computed(() => projectedAnnualIncome.value * 0.85);
const annualTarget = computed(() => goalMonthly.value * 12);
const annualGap = computed(() => Math.max(0, annualTarget.value - conservativeAnnualIncome.value));
const goalProgress = computed(() => annualTarget.value > 0 ? Math.min(100, conservativeAnnualIncome.value / annualTarget.value * 100) : 0);
const requiredAnnualCapital = computed(() => estimateAnnualGoalCapital(annualTarget.value, projectedAnnualIncome.value, goalProjection.value));
const cashBalance = computed(() => latestCashBalance(cashFlows.value));
const reinvestmentCandidates = computed(() => rankReinvestmentCandidates(goalProjection.value, cashBalance.value, Number(taipeiToday().slice(5, 7))));
const goalChanged = computed(() => JSON.stringify(goalPlan.value) !== JSON.stringify({ monthlyTarget: savedGoalMonthly.value, items: savedGoalItems.value }));

/** 依每日交易紀錄自動計算除息日前持股；已入帳後保留當時快照。 */
function shareCount(event: Dividend) { return resolvedShares(event, transactions.value, ledger.value.confirmations[event.id]); }
/** 稅前總額尚未扣匯費，供畫面核對。 */
function grossAmount(event: Dividend) {
  const c = ledger.value.confirmations[event.id];
  return estimateDividend(shareCount(event), c && isDividendReceived(event) ? c.event.cashPerShare : event.cashPerShare);
}
/** 淨額一律扣除固定匯費。 */
function netAmount(event: Dividend) { return netDividend(grossAmount(event)); }
/** 格式化台幣；未知值與零元分開顯示。 */
function money(value: number | null) { return value === null ? '待確認' : `NT$ ${value.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
/** 狀態同時反映交易資料、公告及入帳核對。 */
function statusText(event: Dividend) {
  const entitlement = eligibleShares(transactions.value, event);
  if (entitlement.error) return '交易紀錄需修正';
  if (!event.paymentDate) return '發放日未公告';
  if (isDividendReceived(event)) return '已入帳';
  if (event.cashPerShare === null) return '金額未公告';
  return '待發放';
}
/** 檢查公告是否在使用者確認後修改，提示重新核對。 */
function revised(event: Dividend) {
  const old = ledger.value.confirmations[event.id]?.event;
  return old && (old.cashPerShare !== event.cashPerShare || old.paymentDate !== event.paymentDate);
}
/** 接收舊帳務模組同步事件，不上傳持股至公開資料來源。 */
function syncPortfolio() {
  holdings.value = state.inventory.map((h: Holding) => ({ stock_code: String(h.stock_code).trim(), stock_name: String(h.stock_name || ''), total_shares: Number(h.total_shares), current_price: h.current_price, avg_cost: h.avg_cost, market_value: h.market_value }));
  transactions.value = state.transactions.map((t: Transaction) => ({ ...t, stock_code: String(t.stock_code).trim() }));
  cashFlows.value = state.cashFlow.map((flow: Record<string, unknown>) => ({ ...flow }));
  isDemo.value = state.isDemo;
  portfolioReady.value = true;
  storageError.value = false;
  try { ledger.value = loadLedger(isDemo.value); }
  catch { storageError.value = true; ledger.value = { version: 1, confirmations: {} }; error.value = '瀏覽器無法讀取歷史配息估算資料；不影響 ETF 目標與試算表庫存。請確認網站儲存空間未被封鎖。'; }
}

/** 從雲端正式資料載入草稿；舊資料若曾被 Sheets 移除前導零，會用公告代號唯一比對修復。 */
function loadSavedGoalPlan(force = false) {
  if ((!portfolioReady.value || !etfOptions.value.length) || (goalLoaded.value && !force)) return;
  const items = (state.dividendGoals || []).map((item: Record<string, unknown>) => {
    const raw = String(item.stock_code || item.stockCode || '').trim().toUpperCase();
    const matches = etfOptions.value.filter(option => option.stockCode.replace(/^0+/, '') === raw.replace(/^0+/, ''));
    const option = etfOptions.value.find(candidate => candidate.stockCode === raw) || (matches.length === 1 ? matches[0] : undefined);
    return { stockCode: option?.stockCode || raw, stockName: option?.stockName || String(item.stock_name || item.stockName || '') };
  });
  const plan = parseDividendGoalPlan({ monthlyTarget: Number((state.investmentSettings as Record<string, unknown>)?.monthly_passive_income_target || 0), items });
  savedGoalMonthly.value = plan.monthlyTarget;
  savedGoalItems.value = plan.items.map(item => ({ ...item }));
  goalMonthly.value = plan.monthlyTarget;
  goalItems.value = plan.items.map(item => ({ ...item }));
  goalLoaded.value = true;
}

/** 從公告清單加入 ETF；實際股數保持為零直到新增交易。 */
function addGoalItem() {
  const code = newGoalCode.value.trim().toUpperCase();
  const option = etfOptions.value.find(item => item.stockCode === code);
  if (!option) { goalMessage.value = '請選擇目前配息資料中可辨識的 ETF。'; return; }
  if (!goalItems.value.some(item => item.stockCode === code)) goalItems.value.push(option);
  newGoalCode.value = '';
  goalMessage.value = '';
}
function removeGoalItem(code: string) { goalItems.value = goalItems.value.filter(item => item.stockCode !== code); }
/** 切換年度目標的精簡檢視，避免同頁同時展開大量資訊。 */
function setGoalView(view: 'overview' | 'months' | 'candidates') { goalView.value = view; }
/** Demo 寫入瀏覽器；個人模式由 Apps Script 同時儲存目標並 upsert 0 庫存。 */
async function persistGoalPlan() {
  goalSaving.value = true;
  goalMessage.value = '';
  try {
    const plan = goalPlan.value;
    if (isDemo.value) {
      localStorage.setItem('demo_monthly_passive_income_target', String(plan.monthlyTarget));
      localStorage.setItem('demo_dividend_goals', JSON.stringify(plan.items));
    } else {
      const saved = await saveDividendGoals(state.apiUrl, plan);
      savedGoalMonthly.value = saved.monthlyTarget;
      savedGoalItems.value = saved.items.map(item => ({ ...item }));
    }
    await reloadData();
    loadSavedGoalPlan(true);
    goalMessage.value = '投資目標已儲存，庫存清單已同步。';
  } catch (e) { goalMessage.value = (e as Error).message; }
  finally { goalSaving.value = false; }
}
/** 更新公開公告，保留已載入內容以避免暫時失敗清空畫面。 */
async function refresh() {
  loading.value = true;
  warning.value = '';
  try { const result = await loadFeed(); feed.value = result.feed; warning.value = result.warning; }
  catch (e) { warning.value = (e as Error).message; }
  finally { loading.value = false; }
}
/** 寫入成功後才更新畫面，避免顯示實際未保存的股數。 */
function persist(next: Ledger) {
  saveLedger(isDemo.value, next);
  ledger.value = next;
}
/** 發放日到達時自動保存股數快照，並通知總覽重新計算已落袋股息。 */
function syncAutomaticReceipts() {
  if (!portfolioReady.value || storageError.value) return;
  const next = parseLedger(JSON.parse(JSON.stringify(ledger.value)));
  let changed = false;
  for (const event of allEvents.value) {
    if (!isDividendReceived(event) || next.confirmations[event.id]?.received) continue;
    const entitlement = eligibleShares(transactions.value, event);
    if (entitlement.error || entitlement.shares === null) continue;
    next.confirmations[event.id] = { event: { ...event }, shares: entitlement.shares, confirmedAt: taipeiToday(), received: true, remittanceFee: DEFAULT_REMITTANCE_FEE };
    changed = true;
  }
  if (!changed) return;
  try { persist(next); window.dispatchEvent(new Event('dividend-ledger-updated')); }
  catch { storageError.value = true; error.value = '無法保存歷史配息估算資料；總覽仍會採用試算表中已登錄的股息現金流。'; }
}

watch([feed, transactions, portfolioReady], syncAutomaticReceipts, { deep: true });
watch([feed, portfolioReady], () => loadSavedGoalPlan(), { deep: true });
onMounted(() => { window.addEventListener('portfolio-updated', syncPortfolio); void refresh(); });
onUnmounted(() => window.removeEventListener('portfolio-updated', syncPortfolio));
</script>

<template>
  <div class="dividends space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div><p class="text-xs font-semibold tracking-widest text-indigo-400 mb-2">DIVIDEND CALENDAR</p><h2 class="text-2xl font-bold">股息追蹤</h2><p class="text-sm text-slate-400 mt-2">掌握每次除息、預計入帳日與自己的配息股數。</p></div>
    </div>
    <p v-if="!portfolioReady" class="banner">正在載入持股資料…</p>
    <p v-if="portfolioReady && isDemo" class="banner">目前為 Demo 持股。股息公告是真實市場資料，預估金額僅依示範持股試算；確認紀錄與個人模式分開保存。</p>
    <p v-if="warning" class="banner" role="status">{{ warning }}</p>
    <p v-if="error" class="banner border-rose-500/40 text-rose-300" role="alert">{{ error }}</p>
    <div class="flex flex-wrap items-center gap-4 text-sm">
      <label>年度 <select v-model="year" class="field ml-2"><option v-for="y in years" :key="y">{{ y }}</option></select></label>
      <span class="text-slate-400">按發放年度統計；發放日未公告時暫以除息年度歸類。</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="panel"><p class="text-sm text-slate-400">預計入帳・已扣匯費</p><p class="text-2xl font-bold mt-3 text-indigo-300">{{ money(awaiting) }}</p><p class="hint">依交易紀錄自動推算；每筆固定扣除 NT$10</p></div>
      <div class="panel"><p class="text-sm text-slate-400">已入帳・淨額</p><p class="text-2xl font-bold mt-3 text-emerald-300">{{ money(received) }}</p><p class="hint">發放日到達即自動入帳，並同步至總覽</p></div>
      <div class="panel"><p class="text-sm text-slate-400">尚待補齊資料</p><p class="text-2xl font-bold mt-3">{{ pendingCount }} <span class="text-sm font-normal text-slate-400">筆</span></p><p class="hint">尚有 {{ undated }} 筆發放日未公告</p></div>
    </div>
    <section class="panel space-y-5" aria-labelledby="annual-goal-title">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div><p class="text-xs font-semibold tracking-widest text-indigo-400 mb-2">REINVESTMENT PLAN</p><h3 id="annual-goal-title" class="text-lg font-semibold">年度配息投資目標</h3><p class="hint">以全年配息能力為主，月份分布與再投入候選分開檢視。</p></div>
        <div class="text-right"><p class="text-xs text-slate-400">保守達成率</p><p class="text-3xl font-bold text-indigo-300">{{ goalProgress.toFixed(1) }}%</p><p class="text-xs text-slate-500 mt-1">基準預估的 85%</p></div>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="annual-goal-summary">
        <div class="metric"><p>年度目標</p><strong>{{ money(annualTarget) }}</strong><small>月均 {{ money(goalMonthly) }}</small></div>
        <div class="metric"><p>基準預估年配息</p><strong>{{ money(projectedAnnualIncome) }}</strong><small>目前月均 {{ money(projectedMonthlyIncome) }}</small></div>
        <div class="metric"><p>保守預估年配息</p><strong class="text-emerald-300">{{ money(conservativeAnnualIncome) }}</strong><small>以基準預估 85% 計</small></div>
        <div class="metric"><p>保守情境尚缺</p><strong class="text-amber-200">{{ money(annualGap) }}</strong><small>尚需資金 {{ requiredAnnualCapital === null ? '待股價資料' : money(requiredAnnualCapital) }}</small></div>
      </div>
      <div class="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 flex flex-wrap items-center justify-between gap-4" data-testid="cash-pool">
        <div><p class="text-sm text-emerald-200">可再投入現金池</p><p class="text-2xl font-bold mt-1">{{ money(cashBalance) }}</p><p class="hint !mt-1">直接採現金流水帳最新一筆餘額，不另外維護。</p></div>
        <button type="button" class="secondary" @click="goalView = 'candidates'">查看可買ETF</button>
      </div>
      <nav class="goal-tabs" aria-label="投資目標檢視">
        <button v-for="tab in goalTabs" :key="tab.id" type="button" :class="{ active: goalView === tab.id }" @click="setGoalView(tab.id)">{{ tab.label }}</button>
      </nav>

      <div v-if="goalView === 'overview'" class="space-y-4">
        <div data-testid="saved-goal-summary" class="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-300"><span class="text-slate-400">目前已儲存：</span>年目標 {{ money(savedGoalMonthly * 12) }}・{{ savedGoalItems.length ? savedGoalItems.map(item => item.stockCode).join('、') : '尚未選擇 ETF' }}<span v-if="goalChanged" class="ml-2 text-amber-300">・有尚未儲存的變更</span></div>
        <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end">
          <label class="text-sm">希望每月平均配息<input v-model.number="goalMonthly" class="field mt-2 w-full" type="number" min="0" max="1000000000" step="100" aria-label="每月配息目標"><span class="hint !mt-1 block">年度目標自動為 {{ money(annualTarget) }}</span></label>
          <label class="text-sm">加入 ETF<input v-model="newGoalCode" class="field mt-2 w-full" list="etf-goal-options" placeholder="輸入代號，例如 0056" @keyup.enter="addGoalItem"><datalist id="etf-goal-options"><option v-for="item in etfOptions" :key="item.stockCode" :value="item.stockCode">{{ item.stockName }}</option></datalist></label>
          <button type="button" class="secondary" @click="addGoalItem">加入</button>
        </div>
        <div v-if="goalItems.length" class="overflow-x-auto border border-slate-800 rounded-lg">
          <table class="w-full text-sm text-left whitespace-nowrap"><thead class="bg-slate-950/50 text-slate-400"><tr><th>ETF</th><th>發放月份</th><th>目前股數</th><th>預估年配息</th><th>保守殖利率</th><th></th></tr></thead><tbody class="divide-y divide-slate-800"><tr v-for="item in goalProjection" :key="item.stockCode"><td><strong>{{ item.stockCode }}</strong><p class="text-xs text-slate-400">{{ item.stockName }}</p></td><td>{{ item.payoutMonths.length ? item.payoutMonths.map(month => `${month}月`).join('、') : '資料不足' }}</td><td>{{ item.shares.toLocaleString('zh-TW') }}</td><td>{{ money(item.projectedAnnualIncome) }}</td><td>{{ item.currentPrice && item.annualDividendPerShare ? `${(item.annualDividendPerShare * 0.85 / item.currentPrice * 100).toFixed(2)}%` : '待資料' }}</td><td><button type="button" class="text-rose-300 hover:text-rose-200" @click="removeGoalItem(item.stockCode)">移除</button></td></tr></tbody></table>
        </div>
        <p v-else class="text-sm text-slate-400">尚未選擇 ETF。</p>
        <div class="flex flex-wrap items-center justify-between gap-3"><p class="text-sm text-slate-300">儲存後同步更新庫存目標ETF；實際股數仍只由交易紀錄更新。</p><button type="button" class="primary" :disabled="goalSaving" @click="persistGoalPlan">{{ goalSaving ? '儲存中…' : '儲存投資目標' }}</button></div>
        <p v-if="goalMessage" class="banner" role="status">{{ goalMessage }}</p>
      </div>

      <div v-else-if="goalView === 'months'" class="space-y-4" data-testid="monthly-goal-cards">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <details v-for="month in goalMonthProjection" :key="month.month" class="month-card" :class="month.etfs.length ? '' : 'empty'">
            <summary><span><strong>{{ month.month }} 月</strong><small>{{ month.etfs.length ? `${month.etfs.length} 檔 ETF` : '無配息 ETF' }}</small></span><span class="text-right"><strong>{{ money(month.currentIncome) }}</strong><small>{{ projectedAnnualIncome > 0 ? `${(month.currentIncome / projectedAnnualIncome * 100).toFixed(1)}%／全年` : '0%／全年' }}</small></span></summary>
            <div v-if="month.etfs.length" class="month-detail"><p v-for="etf in month.etfs" :key="etf.stockCode"><span><b>{{ etf.stockCode }}</b>・{{ etf.dividendPerShare }}／股</span><strong>{{ money(etf.currentIncome) }}</strong></p><p class="month-gap"><span>與月均目標差距</span><strong :class="month.currentIncome >= goalMonthly ? 'text-emerald-300' : 'text-amber-200'">{{ month.currentIncome >= goalMonthly ? '+' : '-' }}{{ money(Math.abs(month.currentIncome - goalMonthly)) }}</strong></p></div>
            <p v-else class="month-detail text-amber-200">所選 ETF 目前沒有本月發放紀錄，與月均目標差 {{ money(goalMonthly) }}。</p>
          </details>
        </div>
        <p class="hint">金額依目前股數與近期實際／已公告的每股配息推估；占比以基準預估年配息計算。月份卡片可展開查看各 ETF 貢獻。</p>
      </div>

      <div v-else class="space-y-4" data-testid="reinvestment-candidates">
        <div class="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 text-sm text-slate-300">排序優先補足低於等權配置的ETF，再參考保守殖利率與下次預估發放月份。目前沒有歷史價格序列，因此不顯示或猜測回檔幅度。</div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <article v-for="(item, index) in reinvestmentCandidates" :key="item.stockCode" class="candidate-card">
            <div class="flex items-start justify-between gap-3"><div><span class="rank">#{{ index + 1 }}</span><strong class="ml-2">{{ item.stockCode }}</strong><p class="text-xs text-slate-400 mt-1">{{ item.stockName }}</p></div><p class="text-right text-sm"><span class="text-slate-400">現金池最多</span><br><strong>{{ item.affordableShares === null ? '待股價' : `${item.affordableShares.toLocaleString('zh-TW')} 股` }}</strong></p></div>
            <div class="grid grid-cols-3 gap-2 mt-4 text-xs"><p><span>目前配置</span><strong>{{ item.allocationPercent.toFixed(1) }}%</strong></p><p><span>等權基準</span><strong>{{ item.equalWeightPercent.toFixed(1) }}%</strong></p><p><span>投入後年息增加</span><strong>{{ item.addedConservativeAnnualIncome === null ? '待資料' : money(item.addedConservativeAnnualIncome) }}</strong></p></div>
            <ul class="mt-4 text-xs text-slate-300 space-y-1"><li v-for="reason in item.reasons" :key="reason">・{{ reason }}</li></ul>
          </article>
        </div>
        <p class="hint">「最多可買」是假設將目前現金池全數投入單一ETF的比較值，不是買進建議；除息日價格調整也不視為保證便宜或保證填息。</p>
      </div>
    </section>
    <div class="panel !p-0 overflow-hidden">
      <div class="p-5 flex flex-wrap items-center justify-between gap-3"><h3 class="font-semibold">我的配息紀錄</h3><input v-model="search" class="field" type="search" aria-label="搜尋配息股票" placeholder="搜尋股票代號或名稱"></div>
      <div class="overflow-x-auto">
        <table data-testid="dividend-records" class="w-full text-sm text-left whitespace-nowrap">
          <thead class="bg-slate-950/50 text-slate-400"><tr><th>股票</th><th>除息日</th><th>發放日</th><th>每股／單位</th><th>自動股數</th><th>稅前總額</th><th>匯費</th><th>預估淨額</th><th>狀態</th></tr></thead>
          <tbody class="divide-y divide-slate-800">
            <tr v-for="event in visible" :key="event.id">
              <td><strong>{{ event.stockCode }}</strong><p class="text-slate-400 text-xs mt-1">{{ event.stockName }}</p><a :href="event.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-400">{{ event.source }}</a><p class="text-xs text-slate-500">資料 {{ event.updatedAt.slice(0, 10) }}</p></td>
              <td>{{ event.exDate }}</td><td>{{ event.paymentDate || '未公告' }}</td><td>{{ event.cashPerShare === null ? '未公告' : event.cashPerShare.toLocaleString('zh-TW', { maximumFractionDigits: 8 }) }}</td>
              <td><span v-if="shareCount(event) !== null">{{ shareCount(event)?.toLocaleString('zh-TW') }}</span><span v-else class="text-rose-300">無法計算</span></td><td>{{ money(grossAmount(event)) }}</td><td>{{ money(DEFAULT_REMITTANCE_FEE) }}</td><td class="font-mono text-indigo-200">{{ money(netAmount(event)) }}</td>
              <td><span class="text-xs rounded-full bg-slate-800 px-2 py-1">{{ statusText(event) }}</span><p v-if="revised(event)" class="text-xs text-amber-300 mt-2">公告有修正，請重新核對</p></td>
            </tr>
            <tr v-if="!visible.length"><td colspan="9" class="!py-10 text-center text-slate-400">{{ loading ? '正在讀取公告…' : search ? '沒有符合搜尋條件的紀錄。' : '目前沒有此年度可顯示的配息公告。未查到資料不代表不配息。' }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-if="missing.length" class="panel"><h3 class="font-semibold mb-2">本年度尚未查到公告的持股</h3><p class="text-sm text-slate-400">{{ missing.map(h => `${h.stock_code} ${h.stock_name}`).join('、') }}</p><p class="hint">資料源可能尚未公告或未涵蓋。上市／上櫃預告採近期資料；歷史紀錄自排程開始累積，ETF 另含來源提供的年度資料。</p></div>
    <div class="text-xs text-slate-400 space-y-2">
      <p :class="stale ? 'text-amber-300' : ''">公告快照：{{ feed.updatedAt ? new Date(feed.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '尚未更新' }}（台北時間）{{ stale ? '・資料可能已過期' : '' }}</p>
      <p v-for="source in feed.sources" :key="source.name" :class="source.error ? 'text-amber-300' : ''">{{ source.name }}：{{ source.updatedAt ? new Date(source.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '尚未成功' }}{{ source.error ? `・${source.error}` : '' }}</p>
      <p>股數直接依每日交易紀錄推算；每筆匯費固定為 NT$10。每次重新整理頁面都會自動讀取最新公告，並在發放日到達後保存入帳快照。</p>
      <p>歷史配息估算資料保存在目前瀏覽器，用來保留發放當時的公告與股數；實際帳務仍以試算表現金流為準，儲存失敗不影響 ETF 目標或庫存。</p>
    </div>
  </div>
</template>

<style scoped>
.panel { @apply bg-slate-900 border border-slate-800 rounded-xl p-5; }
.primary { @apply bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg px-4 py-2 text-sm font-semibold; }
.secondary { @apply bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm; }
.field { @apply bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-indigo-400 focus:outline-none; }
.banner { @apply border border-amber-500/20 bg-amber-500/5 text-amber-200 text-sm rounded-lg p-3; }
.hint { @apply text-xs text-slate-400 mt-3 leading-relaxed; }
.metric { @apply rounded-xl border border-slate-800 bg-slate-950/50 p-4 min-w-0; }
.metric p { @apply text-xs text-slate-400; }
.metric strong { @apply block text-lg sm:text-xl mt-2 break-words; }
.metric small { @apply block text-xs text-slate-500 mt-2; }
.goal-tabs { @apply inline-flex max-w-full overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/60 p-1; }
.goal-tabs button { @apply whitespace-nowrap rounded-md px-3 py-2 text-sm text-slate-400; }
.goal-tabs button.active { @apply bg-indigo-600 text-white; }
.month-card { @apply rounded-xl border border-slate-800 bg-slate-950/50; }
.month-card.empty { @apply border-amber-500/30 bg-amber-500/5; }
.month-card summary { @apply cursor-pointer list-none flex items-start justify-between gap-3 p-4; }
.month-card summary::-webkit-details-marker { display: none; }
.month-card summary span { @apply min-w-0; }
.month-card summary strong { @apply block; }
.month-card summary small { @apply block text-xs text-slate-400 mt-1; }
.month-detail { @apply border-t border-slate-800 px-4 py-3 text-xs space-y-2; }
.month-detail p { @apply flex items-start justify-between gap-3; }
.month-gap { @apply pt-2 mt-2 border-t border-slate-800; }
.candidate-card { @apply rounded-xl border border-slate-800 bg-slate-950/50 p-4; }
.candidate-card .rank { @apply rounded-full bg-indigo-500/15 text-indigo-300 px-2 py-1 text-xs; }
.candidate-card .grid p { @apply min-w-0; }
.candidate-card .grid span { @apply block text-slate-500; }
.candidate-card .grid strong { @apply block mt-1 break-words text-slate-200; }
th, td { @apply px-4 py-4; }
button:disabled { @apply opacity-40 cursor-not-allowed; }
</style>
