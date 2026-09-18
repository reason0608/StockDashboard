<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { state } from '../legacy/dashboard.js';
import { dividendStatus, estimateDividend, parseLedger, relevantEvents, taipeiToday, type Dividend, type Feed, type Holding, type Ledger } from '../domain/dividends';
import { loadFeed, loadLedger, saveLedger } from '../services/dividends';

const feed = ref<Feed>({ version: 1, updatedAt: null, events: [], sources: [] });
const ledger = ref<Ledger>({ version: 1, confirmations: {} });
const holdings = ref<Holding[]>([]);
const isDemo = ref(true);
const portfolioReady = ref(false);
const loading = ref(false);
const warning = ref('');
const error = ref('');
const notice = ref('');
const storageError = ref(false);
const search = ref('');
const year = ref(taipeiToday().slice(0, 4));
const editing = ref<Dividend | null>(null);
const sharesInput = ref<string | number>('');
const receivedInput = ref(false);
const pendingImport = ref<Ledger | null>(null);
const allEvents = computed(() => relevantEvents(feed.value, holdings.value, ledger.value));
const years = computed(() => [...new Set([taipeiToday().slice(0, 4), ...allEvents.value.map(e => (e.paymentDate || e.exDate).slice(0, 4))])].sort().reverse());
const annual = computed(() => allEvents.value.filter(e => (e.paymentDate || e.exDate).startsWith(year.value)));
const visible = computed(() => annual.value.filter(e => `${e.stockCode} ${e.stockName}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const missing = computed(() => holdings.value.filter(h => !annual.value.some(e => e.stockCode === String(h.stock_code))));
const stale = computed(() => !feed.value.updatedAt || Date.now() - Date.parse(feed.value.updatedAt) > 3 * 86400000);
const pendingCount = computed(() => annual.value.filter(e => !ledger.value.confirmations[e.id] || e.cashPerShare === null).length);
const awaiting = computed(() => annual.value.reduce((sum, e) => sum + (ledger.value.confirmations[e.id]?.received ? 0 : amount(e) ?? 0), 0));
const received = computed(() => annual.value.reduce((sum, e) => sum + (ledger.value.confirmations[e.id]?.received ? amount(e) ?? 0 : 0), 0));
const undated = computed(() => annual.value.filter(e => !e.paymentDate).length);
const monthly = computed(() => Array.from({ length: 12 }, (_, i) => {
  const prefix = `${year.value}-${String(i + 1).padStart(2, '0')}`;
  const events = annual.value.filter(e => e.paymentDate?.startsWith(prefix));
  return { month: i + 1, amount: events.reduce((total, e) => total + (amount(e) ?? 0), 0), pending: events.filter(e => amount(e) === null).length };
}));
const maxMonthly = computed(() => Math.max(1, ...monthly.value.map(m => m.amount)));

/** 預估以快照股數計算；已入帳紀錄保留確認當時的金額，避免公告修正改寫歷史。 */
function amount(event: Dividend) {
  const c = ledger.value.confirmations[event.id];
  return estimateDividend(c?.shares ?? null, c?.received ? c.event.cashPerShare : event.cashPerShare);
}
/** 格式化台幣預估值；未知金額與零元分開顯示。 */
function money(value: number | null) { return value === null ? '待確認' : `NT$ ${value.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}`; }
/** 檢查公告是否在使用者確認後修改，提示重新核對。 */
function revised(event: Dividend) {
  const old = ledger.value.confirmations[event.id]?.event;
  return old && (old.cashPerShare !== event.cashPerShare || old.paymentDate !== event.paymentDate);
}
/** 接收舊帳務模組同步事件，不上傳持股至公開資料來源。 */
function syncPortfolio() {
  holdings.value = state.inventory.map((h: Holding) => ({ stock_code: String(h.stock_code).trim(), stock_name: String(h.stock_name || ''), total_shares: Number(h.total_shares) }));
  isDemo.value = state.isDemo;
  portfolioReady.value = true;
  storageError.value = false;
  editing.value = null;
  pendingImport.value = null;
  try { ledger.value = loadLedger(isDemo.value); }
  catch { storageError.value = true; ledger.value = { version: 1, confirmations: {} }; error.value = '股息儲存資料無法讀取，已停止寫入。請先保留瀏覽器資料，再匯入有效備份。'; }
}
/** 更新公開公告，保留已載入內容以避免暫時失敗清空畫面。 */
async function refresh() {
  loading.value = true;
  warning.value = '';
  try { const result = await loadFeed(); feed.value = result.feed; warning.value = result.warning; }
  catch (e) { warning.value = (e as Error).message; }
  finally { loading.value = false; }
}
/** 開啟某次配息編輯，不把目前股數自動認定為歷史領息資格。 */
function edit(event: Dividend) {
  editing.value = event;
  const saved = ledger.value.confirmations[event.id];
  sharesInput.value = saved ? String(saved.shares) : '';
  receivedInput.value = saved?.received ?? false;
  error.value = '';
}
/** 使用者主動套用目前庫存；仍需按儲存確認該次資格。 */
function useCurrentShares() {
  sharesInput.value = String(holdings.value.find(h => h.stock_code === editing.value?.stockCode)?.total_shares ?? 0);
}
/** 寫入成功後才更新畫面，避免顯示實際未保存的股數。 */
function persist(next: Ledger) {
  saveLedger(isDemo.value, next);
  ledger.value = next;
}
/** 儲存單次配息快照，零股數合法，負數、小數及空白禁止。 */
function confirmShares() {
  if (!editing.value || storageError.value) return;
  try {
    if (!/^\d+$/.test(String(sharesInput.value).trim())) throw new Error('請填入零或正整數股數。');
    const shares = Number(sharesInput.value);
    estimateDividend(shares, editing.value.cashPerShare ?? 0);
    if (receivedInput.value && (editing.value.cashPerShare === null || !editing.value.paymentDate || editing.value.paymentDate > taipeiToday())) throw new Error('請在發放日到達且金額已公告後確認入帳。');
    const next = parseLedger(JSON.parse(JSON.stringify(ledger.value)));
    next.confirmations[editing.value.id] = { event: { ...editing.value }, shares, confirmedAt: taipeiToday(), received: receivedInput.value };
    persist(next);
    editing.value = null;
    notice.value = '已儲存此次配息股數。入帳標記只用於股息追蹤，未新增現金流水。';
  } catch (e) { error.value = (e as Error).message; }
}
/** 下載僅含股息快照的本機備份，不包含試算表 URL 或 API 金鑰。 */
function exportBackup() {
  const blob = new Blob([JSON.stringify(ledger.value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `dividends-${isDemo.value ? 'demo' : 'personal'}-${taipeiToday()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** 匯入前驗證並顯示筆數供檢閱，尚未覆寫現有紀錄。 */
async function previewImport(event: Event) {
  const input = event.target as HTMLInputElement;
  try {
    const file = input.files?.[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) throw new Error('備份不可超過 5 MB。');
    pendingImport.value = parseLedger(JSON.parse(await file.text())); error.value = '';
  } catch (e) { pendingImport.value = null; error.value = `無法匯入：${(e as Error).message}`; }
  finally { input.value = ''; }
}
/** 使用者確認後合併備份，同事件由備份取代，其他紀錄仍保留。 */
function applyImport() {
  if (!pendingImport.value) return;
  try {
    persist({ version: 1, confirmations: { ...ledger.value.confirmations, ...pendingImport.value.confirmations } });
    pendingImport.value = null; storageError.value = false; notice.value = '股息備份已匯入。'; error.value = '';
  } catch (e) { error.value = `備份未寫入：${(e as Error).message}`; }
}
onMounted(() => { window.addEventListener('portfolio-updated', syncPortfolio); void refresh(); });
onUnmounted(() => window.removeEventListener('portfolio-updated', syncPortfolio));
</script>

<template>
  <div class="dividends space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div><p class="text-xs font-semibold tracking-widest text-indigo-400 mb-2">DIVIDEND CALENDAR</p><h2 class="text-2xl font-bold">股息追蹤</h2><p class="text-sm text-slate-400 mt-2">掌握每次除息、預計入帳日與自己的配息股數。</p></div>
      <div class="flex gap-2 flex-wrap">
        <button class="secondary" :disabled="loading" @click="refresh">{{ loading ? '載入中…' : '重新讀取公告' }}</button>
        <button class="secondary" :disabled="!portfolioReady || storageError" @click="exportBackup">匯出股息備份</button>
        <label class="secondary cursor-pointer">匯入股息備份<input type="file" accept=".json,application/json" class="sr-only" :disabled="!portfolioReady" @change="previewImport"></label>
      </div>
    </div>
    <p v-if="!portfolioReady" class="banner">正在載入持股資料…</p>
    <p v-if="portfolioReady && isDemo" class="banner">目前為 Demo 持股。股息公告是真實市場資料，預估金額僅依示範持股試算；確認紀錄與個人模式分開保存。</p>
    <p v-if="warning" class="banner" role="status">{{ warning }}</p>
    <p v-if="error" class="banner border-rose-500/40 text-rose-300" role="alert">{{ error }}</p>
    <p v-if="notice" class="text-sm text-emerald-300" role="status">{{ notice }}</p>
    <div v-if="pendingImport" class="panel flex flex-wrap items-center gap-3">
      <p>即將合併 {{ Object.keys(pendingImport.confirmations).length }} 筆紀錄至{{ isDemo ? ' Demo ' : '個人' }}模式，同一次配息會由備份取代。</p>
      <button class="primary" @click="applyImport">確認匯入</button><button class="secondary" @click="pendingImport = null">取消</button>
    </div>
    <div class="flex flex-wrap items-center gap-4 text-sm">
      <label>年度 <select v-model="year" class="field ml-2"><option v-for="y in years" :key="y">{{ y }}</option></select></label>
      <span class="text-slate-400">按發放年度統計；發放日未公告時暫以除息年度歸類。</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="panel"><p class="text-sm text-slate-400">已確認股數・尚未確認入帳</p><p class="text-2xl font-bold mt-3 text-indigo-300">{{ money(awaiting) }}</p><p class="hint">稅前預估，不含股數或金額待確認的紀錄</p></div>
      <div class="panel"><p class="text-sm text-slate-400">已確認入帳・稅前參考</p><p class="text-2xl font-bold mt-3 text-emerald-300">{{ money(received) }}</p><p class="hint">保留確認時金額，實際入帳以券商明細為準</p></div>
      <div class="panel"><p class="text-sm text-slate-400">尚待確認股數／金額</p><p class="text-2xl font-bold mt-3">{{ pendingCount }} <span class="text-sm font-normal text-slate-400">筆</span></p><p class="hint">尚有 {{ undated }} 筆發放日未公告</p></div>
    </div>
    <div class="panel">
      <h3 class="font-semibold">每月預估股息 <span class="text-xs text-slate-400 font-normal">依已確認股數，含已確認入帳</span></h3>
      <div class="grid grid-cols-3 sm:grid-cols-6 xl:grid-cols-12 gap-3 mt-5">
        <div v-for="m in monthly" :key="m.month" class="bg-slate-950/60 rounded-lg p-3 min-w-0">
          <p class="text-xs text-slate-400">{{ m.month }} 月</p><p class="text-sm font-semibold mt-2">{{ m.amount.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) }}</p>
          <div class="h-1 bg-slate-800 rounded mt-3"><div class="bg-indigo-400 h-1 rounded" :style="{ width: `${m.amount / maxMonthly * 100}%` }"></div></div>
          <p v-if="m.pending" class="text-xs text-amber-300 mt-2">{{ m.pending }} 筆待確認</p>
        </div>
      </div>
      <p class="hint">發放日未公告的紀錄不分配至月份；此處不以去年股息推估未公告配息。</p>
    </div>
    <div class="panel !p-0 overflow-hidden">
      <div class="p-5 flex flex-wrap items-center justify-between gap-3"><h3 class="font-semibold">我的配息紀錄</h3><input v-model="search" class="field" type="search" aria-label="搜尋配息股票" placeholder="搜尋股票代號或名稱"></div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left whitespace-nowrap">
          <thead class="bg-slate-950/50 text-slate-400"><tr><th>股票</th><th>除息日</th><th>發放日</th><th>每股／單位</th><th>參與股數</th><th>稅前預估</th><th>狀態</th><th>操作</th></tr></thead>
          <tbody class="divide-y divide-slate-800">
            <tr v-for="event in visible" :key="event.id">
              <td><strong>{{ event.stockCode }}</strong><p class="text-slate-400 text-xs mt-1">{{ event.stockName }}</p><a :href="event.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-400">{{ event.source }}</a><p class="text-xs text-slate-500">資料 {{ event.updatedAt.slice(0, 10) }}</p></td>
              <td>{{ event.exDate }}</td><td>{{ event.paymentDate || '未公告' }}</td><td>{{ event.cashPerShare === null ? '未公告' : event.cashPerShare.toLocaleString('zh-TW', { maximumFractionDigits: 8 }) }}</td>
              <td>{{ ledger.confirmations[event.id]?.shares?.toLocaleString('zh-TW') ?? '待確認' }}</td><td class="font-mono text-indigo-200">{{ money(amount(event)) }}</td>
              <td><span class="text-xs rounded-full bg-slate-800 px-2 py-1">{{ dividendStatus(event, ledger.confirmations[event.id]) }}</span><p v-if="revised(event)" class="text-xs text-amber-300 mt-2">公告有修正，請重新核對</p></td>
              <td><button class="secondary" :disabled="storageError" :aria-label="`確認 ${event.stockCode} ${event.exDate} 股數`" @click="edit(event)">{{ ledger.confirmations[event.id] ? '編輯確認' : '確認股數' }}</button></td>
            </tr>
            <tr v-if="!visible.length"><td colspan="8" class="!py-10 text-center text-slate-400">{{ loading ? '正在讀取公告…' : search ? '沒有符合搜尋條件的紀錄。' : '目前沒有此年度可顯示的配息公告。未查到資料不代表不配息。' }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-if="missing.length" class="panel"><h3 class="font-semibold mb-2">本年度尚未查到公告的持股</h3><p class="text-sm text-slate-400">{{ missing.map(h => `${h.stock_code} ${h.stock_name}`).join('、') }}</p><p class="hint">資料源可能尚未公告或未涵蓋。上市／上櫃預告採近期資料；歷史紀錄自排程開始累積，ETF 另含來源提供的年度資料。</p></div>
    <div class="text-xs text-slate-400 space-y-2">
      <p :class="stale ? 'text-amber-300' : ''">公告快照：{{ feed.updatedAt ? new Date(feed.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '尚未更新' }}（台北時間）{{ stale ? '・資料可能已過期' : '' }}</p>
      <p v-for="source in feed.sources" :key="source.name" :class="source.error ? 'text-amber-300' : ''">{{ source.name }}：{{ source.updatedAt ? new Date(source.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '尚未成功' }}{{ source.error ? `・${source.error}` : '' }}</p>
      <p>此分頁的股數確認只保存在這個瀏覽器，不會同步 Google Sheets。可透過股息備份搬移至其他裝置；請自行保管備份。</p>
    </div>
    <div v-if="editing" class="fixed inset-0 z-[60] bg-slate-950/90 flex items-center justify-center p-4" @keydown.esc="editing = null">
      <form class="panel w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="dividend-dialog-title" @submit.prevent="confirmShares">
        <h3 id="dividend-dialog-title" class="text-lg font-bold">{{ editing.stockCode }}・確認此次配息</h3>
        <p class="text-sm text-slate-400">除息 {{ editing.exDate }} ／ 發放 {{ editing.paymentDate || '未公告' }}</p>
        <p class="banner">請填入有資格參與這次配息的股數。現在持股可能與除息時不同；未參與請填 0。</p>
        <label class="block text-sm">參與配息股數<input v-model="sharesInput" class="field block w-full mt-2" inputmode="numeric" type="number" min="0" step="1" required autofocus></label>
        <button type="button" class="text-sm text-indigo-300 underline" @click="useCurrentShares">帶入目前庫存（仍需自行核對）</button>
        <label class="flex items-start gap-2 text-sm"><input v-model="receivedInput" type="checkbox" class="mt-1" :disabled="editing.cashPerShare === null || !editing.paymentDate || editing.paymentDate > taipeiToday()">我已核對券商紀錄，確認此筆已入帳</label>
        <p class="hint">入帳標記不會自動新增現金流水，避免與原帳務重複計算。稅費、匯費與券商捨入差異未扣除。</p>
        <p v-if="error" role="alert" class="text-rose-300 text-sm">{{ error }}</p>
        <div class="flex justify-end gap-2"><button type="button" class="secondary" @click="editing = null">取消</button><button class="primary" type="submit">儲存確認</button></div>
      </form>
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
th, td { @apply px-4 py-4; }
button:disabled { @apply opacity-40 cursor-not-allowed; }
</style>
