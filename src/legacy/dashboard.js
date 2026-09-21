import * as lucide from '../shared/icons.js';
import { renderContributionChart, renderAssetAllocationChart, renderPortfolioHistoryChart } from './charts.js';
import { escapeHtml, formatNumber } from '../shared/format.js';
import { toggleTab } from '../router';
import { loadLedger } from '../services/dividends';
import { realizedDividends, realizedDividendsByStock, realizedDividendsSince } from '../domain/entitlements';
import { analyzeQuoteQuality } from '../domain/quoteQuality';

        // =========================================================================
        // ⚙️ 統一雲端連線設定：在此處貼上您的 Google Apps Script Web App URL。
        // 當您將 index.html 分發給老婆或其他設備時，所有人打開皆能直接使用，完全不需再次設定！
        // =========================================================================
        const DEFAULT_API_URL = ""; // 👈 填入您的 Web App 完整網址 (包含完整的 56 字元部署 ID)

        // --- 1. 初始化 Mock / 預設數據 (DEMO 模式使用) ---
        const DEFAULT_CASH_FLOW = [
            { id: "FLOW_001", date: "2026-06-01", contributor: "老公", type: "存入", stock_code: "", amount: 100000, note: "6月份固定投資入金" },
            { id: "FLOW_002", date: "2026-06-01", contributor: "老婆", type: "存入", stock_code: "", amount: 100000, note: "6月份固定投資入金" },
            { id: "FLOW_003", date: "2026-06-05", contributor: "共同", type: "證券交割支出", stock_code: "2330", amount: 20540, note: "買入台積電零股交割" },
            { id: "FLOW_004", date: "2026-06-08", contributor: "共同", type: "證券交割支出", stock_code: "0050", amount: 15150, note: "今日買入0050零股交割" },
            { id: "FLOW_005", date: "2026-06-08", contributor: "共同", type: "股息流入", stock_code: "2330", amount: 1500, note: "台積電季配息自動入帳" },
        ];

        const DEFAULT_TRANSACTIONS = [
            { id: "TX_001", date: "2026-06-05", stock_code: "2330", stock_name: "台積電", action: "買入", price: 1025.00, shares: 20, fee: 20, tax: 0, total_amount: 20520 },
            { id: "TX_002", date: "2026-06-08", stock_code: "0050", stock_name: "元大台灣50", action: "買入", price: 151.30, shares: 100, fee: 20, tax: 0, total_amount: 15150 },
        ];

        const DEMO_PRICES = {
            "2330": { name: "台積電", price: 1045.00 },
            "0050": { name: "元大台灣50", price: 153.20 }
        };

        // 系統狀態
        export const state = {
            cashFlow: [],
            transactions: [],
            inventory: [],
            portfolioSnapshots: [],
            investmentSettings: {},
            apiUrl: "",
            isDemo: true,
            lastError: "",
            lastSyncAt: null
        };



        // 智慧型網址規格驗證器 (Tech Lead 專防複製錯誤)
        function validateGasUrl(url) {
            if (!url) return { valid: false, reason: "尚未輸入網址" };
            const cleanUrl = url.trim();
            if (!cleanUrl.startsWith("https://script.google.com/macros/s/")) {
                return { valid: false, reason: "網址開頭不正確！必須是 https://script.google.com/macros/s/ 開頭。" };
            }
            const parts = cleanUrl.split("/macros/s/");
            if (parts.length < 2) return { valid: false, reason: "無法解析網址中的部署 ID 區段。" };
            
            const idPart = parts[1].split("/")[0];
            if (idPart.length < 56) {
                return { 
                    valid: false, 
                    reason: `偵測到部署 ID 只有 ${idPart.length} 個字元（一般標準應為 56 個字元）！這 99% 是複製貼上時最後幾個字漏掉了。請重新開啟 Apps Script 部署視窗，完整複製完整的 Web App 網址。` 
                };
            }
            if (!cleanUrl.endsWith("/exec")) {
                return { valid: false, reason: "網頁應用程式網址必須以 /exec 結尾！" };
            }
            return { valid: true };
        }

        // 監聽網址欄位輸入，進行智慧防呆提示
        function bindSettingsValidation() {
            const apiInput = document.getElementById("settings-api-url");
            if (apiInput) {
                apiInput.addEventListener("input", (e) => {
                    const url = e.target.value.trim();
                    const warning = document.getElementById("url-warning");
                    const validation = validateGasUrl(url);
                    
                    if (url && !validation.valid) {
                        warning.classList.remove("hidden");
                        warning.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 shrink-0"></i><span>${validation.reason}</span>`;
                        lucide.createIcons();
                    } else {
                        warning.classList.add("hidden");
                    }
                });
            }
        }

        // 台北時區精準格式化器 (僅顯示 YYYY-MM-DD，絕不漏日跳日)
        function formatDateTaipei(dateInput) {
            if (!dateInput) return "-";
            if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
                return dateInput.trim();
            }
            try {
                const date = new Date(dateInput);
                if (isNaN(date.getTime())) {
                    const match = String(dateInput).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
                    if (match) {
                        return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
                    }
                    return String(dateInput);
                }
                const formatter = new Intl.DateTimeFormat('zh-TW', {
                    timeZone: 'Asia/Taipei',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                });
                return formatter.format(date).replace(/\//g, '-');
            } catch (e) {
                return String(dateInput);
            }
        }

        // 手機端點擊狀態燈觸發連線狀態 Tooltip
        function showConnectionStatusToast() {
            let statusMessage = "連線狀態：";
            let iconName = "alert-circle";
            let iconColor = "text-amber-400";

            if (state.isDemo) {
                statusMessage += "DEMO 測試預覽模式 (無雲端連線)";
            } else if (state.lastError) {
                statusMessage += "雲端連線失敗，已自動降級回離線模式";
                iconColor = "text-red-400";
            } else {
                statusMessage += "Google 試算表同步連線成功！";
                iconColor = "text-emerald-400";
                iconName = "check-circle";
            }
            showToast(statusMessage, iconName, iconColor);
        }

        // --- 2. 系統啟動與數據整合載入 ---
        export async function initializeDashboard() {
            bindSettingsValidation();
            loadAppsScriptPreview();
            window.addEventListener('dividend-ledger-updated', () => { renderDashboard(); renderInventoryTable(); });
            // 優先讀取 LocalStorage 自訂覆蓋，若無則採用全域預設之 DEFAULT_API_URL
            state.apiUrl = localStorage.getItem("sheet_api_url") || DEFAULT_API_URL;
            
            // 如果成功讀取到了程式碼中宣告的預設 API 網址，顯示提示綠條
            if (DEFAULT_API_URL && !localStorage.getItem("sheet_api_url")) {
                const indicator = document.getElementById('central-config-indicator');
                if (indicator) indicator.classList.remove('hidden');
            }

            // 讀取出資人姓名設定
            document.getElementById('settings-husband-name').value = localStorage.getItem("husband_name") || "";
            document.getElementById('settings-wife-name').value = localStorage.getItem("wife_name") || "";

            // 設定今日日期預設值 (台北時區)
            const todayStr = formatDateTaipei(new Date());
            document.getElementById('cf-date').value = todayStr;
            document.getElementById('tx-date').value = todayStr;
            document.getElementById('current-date-badge').innerHTML = `<i data-lucide="calendar" class="w-3.5 h-3.5"></i> ${todayStr} (今日)`;

            if (state.apiUrl) {
                state.isDemo = false;
                const badge = document.getElementById('connection-badge');
                badge.className = "cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-2.5 sm:py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 transition-all duration-200 active:scale-95";
                badge.innerHTML = `
                    <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
                    <span class="hidden sm:inline" id="connection-text">Google 試算表連線中</span>
                `;
                document.getElementById('settings-api-url').value = state.apiUrl;
            } else {
                state.isDemo = true;
                if (!localStorage.getItem('demo_cash_flow')) {
                    localStorage.setItem('demo_cash_flow', JSON.stringify(DEFAULT_CASH_FLOW));
                    localStorage.setItem('demo_transactions', JSON.stringify(DEFAULT_TRANSACTIONS));
                }
            }

            await reloadData();
            lucide.createIcons();
        };

        // --- 3. 數據同步核心 ---
        async function reloadData() {
            const syncIcon = document.getElementById('sync-icon');
            if (syncIcon) syncIcon.classList.add('animate-spin');
            showLoadingToast("正在同步資產數據...");

            try {
                if (state.isDemo || !state.apiUrl) {
                    state.cashFlow = JSON.parse(localStorage.getItem('demo_cash_flow')) || DEFAULT_CASH_FLOW;
                    state.transactions = JSON.parse(localStorage.getItem('demo_transactions')) || DEFAULT_TRANSACTIONS;
                    state.portfolioSnapshots = [];
                    state.investmentSettings = { monthly_passive_income_target: Number(localStorage.getItem('demo_monthly_passive_income_target') || 0) };
                    calculateInventoryFromTransactions();
                    document.getElementById('connection-error-banner').classList.add('hidden');
                } else {
                    // 先行驗證網址結構，防禦並在前端攔截無效的請求
                    const validation = validateGasUrl(state.apiUrl);
                    if (!validation.valid) {
                        throw new Error(`網址格式錯誤：${validation.reason}`);
                    }

                    const response = await fetch(state.apiUrl, { redirect: "follow" });
                    if (!response.ok) throw new Error(`HTTP 錯誤! 狀態碼: ${response.status}`);
                    
                    const data = await response.json();
                    
                    if (!data || (!data.cashFlow && !data.transactions && !data.inventory)) {
                        throw new Error("API 回傳結構不正確。請確認 Google 試算表工作表分頁命名為 users_cash_flow, daily_transactions, stock_inventory 且腳本複製完全。");
                    }

                    state.cashFlow = (data.cashFlow || []).filter(item => item.id);
                    state.transactions = (data.transactions || []).filter(item => item.id);
                    state.inventory = (data.inventory || []).filter(item => item.stock_code);
                    state.portfolioSnapshots = Array.isArray(data.portfolioSnapshots) ? data.portfolioSnapshots : [];
                    state.investmentSettings = data.investmentSettings && typeof data.investmentSettings === 'object' ? data.investmentSettings : {};
                    state.lastError = "";
                    state.lastSyncAt = new Date().toISOString();

                    const badge = document.getElementById('connection-badge');
                    badge.className = "cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-2.5 sm:py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 transition-all duration-200 active:scale-95";
                    badge.innerHTML = `
                        <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
                        <span class="hidden sm:inline" id="connection-text">雲端連線成功</span>
                    `;
                    document.getElementById('connection-error-banner').classList.add('hidden');
                }

                renderDashboard();
                renderCashFlowTable();
                renderTransactionsTable();
                renderInventoryTable();
                
                showToast(state.isDemo ? "已載入 Demo 數據！" : "雲端數據同步成功！", "check-circle", "text-emerald-400");
            } catch (error) {
                console.error("同步報錯:", error);
                state.lastError = error.toString();
                
                state.isDemo = true;
                state.lastSyncAt = null;
                state.cashFlow = JSON.parse(localStorage.getItem('demo_cash_flow')) || DEFAULT_CASH_FLOW;
                state.transactions = JSON.parse(localStorage.getItem('demo_transactions')) || DEFAULT_TRANSACTIONS;
                state.portfolioSnapshots = [];
                state.investmentSettings = { monthly_passive_income_target: Number(localStorage.getItem('demo_monthly_passive_income_target') || 0) };
                calculateInventoryFromTransactions();
                
                renderDashboard();
                renderCashFlowTable();
                renderTransactionsTable();
                renderInventoryTable();

                document.getElementById('connection-error-banner').classList.remove('hidden');
                document.getElementById('diagnostic-error-summary').textContent = "連線失敗 (CORS或網址部署錯誤)";
                document.getElementById('diagnostic-raw-error').textContent = `${error.toString()}\n\n時間: 2026-06-08\n連線網址: ${state.apiUrl}\n\n【排錯關鍵提示】:\n如果此處拋出 Failed to fetch 且您的網址長度非標準56字元ID，請回 Cloud 控制台確認是否完整複製了 /exec 結尾的 Web App URL。`;
                
                const badge = document.getElementById('connection-badge');
                badge.className = "cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-2.5 sm:py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20 transition-all duration-200 active:scale-95";
                badge.innerHTML = `
                    <span class="w-2.5 h-2.5 rounded-full bg-rose-500 shrink-0"></span>
                    <span class="hidden sm:inline" id="connection-text">連線失敗 (Demo 預覽)</span>
                `;
                
                showToast("雲端同步失敗，已開啟防禦 Demo 預覽！", "alert-circle", "text-amber-400");
            } finally {
                if (syncIcon) syncIcon.classList.remove('animate-spin');
                window.dispatchEvent(new Event('portfolio-updated'));
            }
        }

        function openDiagnosticModal() {
            openModal('diagnostic-modal');
        }

        function calculateInventoryFromTransactions() {
            const invMap = {};
            state.transactions.forEach(t => {
                if (!invMap[t.stock_code]) {
                    invMap[t.stock_code] = {
                        stock_code: t.stock_code,
                        stock_name: t.stock_name,
                        total_shares: 0,
                        total_cost_spent: 0,
                    };
                }
                const item = invMap[t.stock_code];
                const sharesNum = Number(t.shares || 0);
                const totalAmtNum = Number(t.total_amount || 0);

                if (t.action === "買入") {
                    item.total_shares += sharesNum;
                    item.total_cost_spent += totalAmtNum;
                } else if (t.action === "賣出") {
                    item.total_shares -= sharesNum;
                    item.total_cost_spent -= totalAmtNum;
                }
            });

            state.inventory = Object.values(invMap).filter(item => item.total_shares > 0).map(item => {
                const demoPriceInfo = DEMO_PRICES[item.stock_code] || { price: 100 };
                const current_price = demoPriceInfo.price;
                const market_value = item.total_shares * current_price;
                const avg_cost = item.total_shares > 0 ? (item.total_cost_spent / item.total_shares) : 0;
                const unrealized_pnl = market_value - item.total_cost_spent;
                const roi = item.total_cost_spent > 0 ? (unrealized_pnl / item.total_cost_spent) : 0;

                return {
                    stock_code: item.stock_code,
                    stock_name: item.stock_name,
                    total_shares: item.total_shares,
                    avg_cost: Math.round(avg_cost * 100) / 100,
                    total_investment: item.total_cost_spent,
                    current_price: current_price,
                    market_value: market_value,
                    unrealized_pnl: unrealized_pnl,
                    roi: roi
                };
            });
        }

        // --- 4. 畫面渲染函式群 ---
        function renderDashboard() {
            // 智慧姓名動態偵測核心
            const contributorsSet = new Set();
            state.cashFlow.forEach(flow => {
                if (flow.type === "存入" && flow.contributor !== "共同" && flow.contributor) {
                    contributorsSet.add(flow.contributor);
                }
            });
            const contributorsList = Array.from(contributorsSet);

            const configHusband = localStorage.getItem("husband_name") || "";
            const configWife = localStorage.getItem("wife_name") || "";

            const husbandName = configHusband || contributorsList[0] || "老公";
            const wifeName = configWife || contributorsList[1] || "老婆";

            const cfSelect = document.getElementById('cf-contributor');
            if (cfSelect) {
                cfSelect.innerHTML = `
                    <option value="${escapeHtml(husbandName)}">${escapeHtml(husbandName)}</option>
                    <option value="${escapeHtml(wifeName)}">${escapeHtml(wifeName)}</option>
                    <option value="共同">共同</option>
                `;
            }

            // 依日期與 ID 排序流水帳，確保能夠準確鎖定最後一筆
            const sortedFlows = [...state.cashFlow].sort((a, b) => {
                const dateDiff = new Date(a.date) - new Date(b.date);
                if (dateDiff !== 0) return dateDiff;
                const idA = Number(String(a.id).replace(/\D/g, '')) || 0;
                const idB = Number(String(b.id).replace(/\D/g, '')) || 0;
                return idA - idB;
            });

            let calculatedCash = 0;
            let totalContributed = 0;
            let husbandContributed = 0;
            let wifeContributed = 0;
            let jointContributed = 0;

            sortedFlows.forEach(flow => {
                const amt = Number(flow.amount || 0);
                const typeStr = String(flow.type || "");

                if (typeStr === "存入" || typeStr.includes("存入")) {
                    calculatedCash += amt;
                    totalContributed += amt;
                    if (flow.contributor === husbandName) {
                        husbandContributed += amt;
                    } else if (flow.contributor === wifeName) {
                        wifeContributed += amt;
                    } else {
                        jointContributed += amt;
                    }
                } else if (typeStr === "股息流入" || typeStr.includes("股息") || typeStr.includes("配息")) {
                    calculatedCash += amt;
                } else if (typeStr === "證券交割支出" || typeStr.includes("支出") || typeStr.includes("交割")) {
                    calculatedCash -= Math.abs(amt);
                } else if (typeStr === "活存利息" || typeStr.includes("利息")) {
                    // 活存利息收入
                    calculatedCash += amt;
                } else {
                    // 其他自訂收支項目
                    calculatedCash += amt;
                }
            });

            // 🚨 關鍵修正：優先使用試算表最新一筆的 account_balance 作為 Single Source of Truth！
            // 如此一來不論試算表中有任何自訂扣款、退稅或活存利息，看板金額必定與流水帳 100% 相符
            const latestFlow = sortedFlows[sortedFlows.length - 1];
            const cashBalance = (latestFlow && latestFlow.account_balance !== undefined && latestFlow.account_balance !== "")
                ? Number(latestFlow.account_balance)
                : calculatedCash;

            let totalStockValue = 0;
            let totalStockCost = 0;
            let totalUnrealizedPnL = 0;

            state.inventory.forEach(inv => {
                totalStockValue += Number(inv.market_value || 0);
                
                // 關鍵自動容錯與動態本金計算
                const cost = Number(inv.total_investment) || (Number(inv.avg_cost || 0) * Number(inv.total_shares || 0));
                totalStockCost += cost;
                
                totalUnrealizedPnL += Number(inv.unrealized_pnl || 0);
            });

            const totalAssets = cashBalance + totalStockValue;
            const overallRoi = totalStockCost > 0 ? (totalUnrealizedPnL / totalStockCost) * 100 : 0;

            document.getElementById('card-total-assets').textContent = `$${formatNumber(totalAssets)}`;
            document.getElementById('card-stock-value').textContent = `$${formatNumber(totalStockValue)}`;
            document.getElementById('card-cash-balance').textContent = `$${formatNumber(cashBalance)}`;
            document.getElementById('card-total-contributed').textContent = `$${formatNumber(totalContributed)}`;
            let totalDividends = 0;
            try {
                totalDividends = realizedDividends(state.cashFlow, loadLedger(state.isDemo));
            } catch (error) {
                console.warn('股息追蹤資料無法讀取，總覽暫時僅採用現金流水。', error);
                totalDividends = state.cashFlow.filter(flow => /股息|配息/.test(String(flow.type || ''))).reduce((sum, flow) => sum + (Number(flow.amount) || 0), 0);
            }
            document.getElementById('card-total-dividends').textContent = `$${formatNumber(totalDividends, 2)}`;
            renderPassiveIncome();
            renderPortfolioHistoryChart(state.portfolioSnapshots);

            const pnlElement = document.getElementById('card-unrealized-pnl');
            const roiElement = document.getElementById('card-roi');
            const bgIndicator = document.getElementById('pnl-bg-indicator');

            const formattedPnL = (totalUnrealizedPnL >= 0 ? "+" : "") + formatNumber(totalUnrealizedPnL);
            const formattedRoi = (totalUnrealizedPnL >= 0 ? "+" : "") + overallRoi.toFixed(2) + "%";

            pnlElement.textContent = `$${formattedPnL}`;
            roiElement.textContent = formattedRoi;

            if (totalUnrealizedPnL >= 0) {
                pnlElement.className = "text-3xl font-extrabold text-red-500 mt-2";
                roiElement.className = "font-bold text-red-500";
                bgIndicator.className = "absolute right-3 top-3 opacity-10 text-red-500";
                bgIndicator.innerHTML = `<i data-lucide="trending-up" class="w-16 h-16"></i>`;
            } else {
                pnlElement.className = "text-3xl font-extrabold text-emerald-400 mt-2";
                roiElement.className = "font-bold text-emerald-400";
                bgIndicator.className = "absolute right-3 top-3 opacity-10 text-emerald-400";
                bgIndicator.innerHTML = `<i data-lucide="trending-down" class="w-16 h-16"></i>`;
            }

            renderContributionChart(husbandContributed, wifeContributed, jointContributed, husbandName, wifeName);
            renderAssetAllocationChart(cashBalance, state.inventory);

            // 今日交易戰報 (手機端響應式合併與隐藏優化)
            const todayStr = formatDateTaipei(new Date());
            const todayTrans = state.transactions.filter(t => formatDateTaipei(t.date) === todayStr);
            const todayBody = document.getElementById('today-transactions-body');
            
            if (todayTrans.length === 0) {
                todayBody.innerHTML = `
                    <tr>
                        <td colspan="5" class="px-4 py-8 text-center text-slate-500">
                            今日無交易買賣。下單後點選「新增交易紀錄」，將同步更新於此，方便直接截圖發到群組。
                        </td>
                    </tr>
                `;
            } else {
                todayBody.innerHTML = todayTrans.map(t => {
                    const typeBadge = t.action === "買入" 
                        ? `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] sm:text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">買入</span>`
                        : `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] sm:text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">賣出</span>`;
                    return `
                        <tr class="hover:bg-slate-900/40">
                            <td class="px-3 sm:px-4 py-3 whitespace-nowrap">${typeBadge}</td>
                            <td class="px-3 sm:px-4 py-3">
                                <div class="font-semibold text-slate-200">${escapeHtml(t.stock_code)} <span class="text-[10px] sm:text-xs text-slate-400 font-normal">${escapeHtml(t.stock_name)}</span></div>
                                <!-- 手機版專屬折疊資訊 (單價與股數)，消除 Scrollbar -->
                                <div class="text-[10px] text-slate-400 font-mono mt-0.5 sm:hidden">
                                    ${formatNumber(t.shares)} 股 × $${formatNumber(t.price, 2)}
                                </div>
                            </td>
                            <td class="px-3 sm:px-4 py-3 text-right font-mono hidden sm:table-cell">$${formatNumber(t.price, 2)}</td>
                            <td class="px-3 sm:px-4 py-3 text-right font-mono hidden sm:table-cell">${formatNumber(t.shares)} 股</td>
                            <td class="px-3 sm:px-4 py-3 text-right font-mono text-slate-200 font-semibold whitespace-nowrap">$${formatNumber(t.total_amount)}</td>
                        </tr>
                    `;
                }).join('');
            }
            lucide.createIcons();
        }

        function renderCashFlowTable() {
            const body = document.getElementById('cashflow-table-body');
            let balance = 0;
            const sortedFlows = [...state.cashFlow].sort((a, b) => {
                const dateDiff = new Date(a.date) - new Date(b.date);
                if (dateDiff !== 0) return dateDiff;
                const idA = Number(String(a.id).replace(/\D/g, '')) || 0;
                const idB = Number(String(b.id).replace(/\D/g, '')) || 0;
                return idA - idB;
            });
            
            const renderedFlows = sortedFlows.map(flow => {
                const amt = Number(flow.amount || 0);
                const typeStr = String(flow.type || "");
                if (typeStr.includes("存入") || typeStr.includes("股息") || typeStr.includes("利息") || typeStr.includes("收入")) {
                    balance += amt;
                } else if (typeStr.includes("支出") || typeStr.includes("交割")) {
                    balance -= Math.abs(amt);
                } else {
                    balance += amt;
                }
                return { ...flow, calculatedBalance: balance };
            }).reverse();

            if (renderedFlows.length === 0) {
                body.innerHTML = `<tr><td colspan="10" class="px-6 py-10 text-center text-slate-500">尚無現金流水帳，點擊右上方新增。</td></tr>`;
                return;
            }

            body.innerHTML = renderedFlows.map(flow => {
                let typeClass = "";
                let amtPrefix = "";
                const typeStr = String(flow.type || "");

                if (typeStr.includes("存入")) {
                    typeClass = "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
                    amtPrefix = "+";
                } else if (typeStr.includes("股息") || typeStr.includes("利息")) {
                    typeClass = "bg-amber-500/10 text-amber-400 border-amber-500/20";
                    amtPrefix = Number(flow.amount) >= 0 ? "+" : "";
                } else {
                    typeClass = "bg-slate-800 text-slate-400 border-slate-700";
                    amtPrefix = "-";
                }

                const finalBalance = flow.account_balance ? Number(flow.account_balance) : flow.calculatedBalance;

                return `
                    <tr class="hover:bg-slate-900/50">
                        <td class="px-6 py-4 font-mono text-xs text-slate-500">${escapeHtml(flow.id || '-')}</td>
                        <td class="px-6 py-4 text-slate-300 font-mono">${escapeHtml(formatDateTaipei(flow.date))}</td>
                        <td class="px-6 py-4 font-semibold text-slate-200">${escapeHtml(flow.contributor)}</td>
                        <td class="px-6 py-4">
                            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${typeClass}">
                                ${escapeHtml(flow.type)}
                            </span>
                        </td>
                        <td class="px-6 py-4 text-slate-400 font-mono">${escapeHtml(flow.stock_code || '-')}</td>
                        <td class="px-6 py-4 text-right font-mono font-bold ${amtPrefix === '+' || Number(flow.amount) >= 0 ? 'text-red-400' : 'text-slate-300'}">
                            ${amtPrefix}$${formatNumber(flow.amount)}
                        </td>
                        <td class="px-6 py-4 text-right font-mono text-slate-200 font-semibold">$${formatNumber(finalBalance)}</td>
                        <td class="px-6 py-4 text-slate-400 max-w-xs truncate">${escapeHtml(flow.note || '')}</td>
                    </tr>
                `;
            }).join('');
        }

        function renderTransactionsTable() {
            const body = document.getElementById('transactions-table-body');
            const sorted = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));

            if (sorted.length === 0) {
                body.innerHTML = `<tr><td colspan="10" class="px-6 py-10 text-center text-slate-500">尚無交易紀錄，點擊右上方新增。</td></tr>`;
                return;
            }

            body.innerHTML = sorted.map(t => {
                const actionBadge = t.action === "買入"
                    ? `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">買入</span>`
                    : `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">賣出</span>`;
                return `
                    <tr class="hover:bg-slate-900/50">
                        <td class="px-6 py-4 text-slate-300 font-mono">${escapeHtml(formatDateTaipei(t.date))}</td>
                        <td class="px-6 py-4 font-bold text-slate-200">${escapeHtml(t.stock_code)} <span class="text-xs text-slate-400 font-normal">${escapeHtml(t.stock_name)}</span></td>
                        <td class="px-6 py-4">${actionBadge}</td>
                        <td class="px-6 py-4 text-right font-mono">$${formatNumber(t.price, 2)}</td>
                        <td class="px-6 py-4 text-right font-mono">${formatNumber(t.shares)} 股</td>
                        <td class="px-6 py-4 text-right font-mono text-slate-400">$${formatNumber(t.fee)}</td>
                        <td class="px-6 py-4 text-right font-mono text-slate-400">$${formatNumber(t.tax || 0)}</td>
                        <td class="px-6 py-4 text-right font-mono text-white font-bold">$${formatNumber(t.total_amount)}</td>
                    </tr>
                `;
            }).join('');
        }

        // 渲染持股庫存 Table (買入成本與目前市價強制呈現2位小數點)
        function renderInventoryTable() {
            const body = document.getElementById('inventory-table-body');
            renderQuoteQuality();
            
            if (state.inventory.length === 0) {
                body.innerHTML = `<tr><td colspan="10" class="px-6 py-10 text-center text-slate-500">目前庫存空空如也，快去買進第一檔股票吧！</td></tr>`;
                document.getElementById('inventory-table-footer').innerHTML = '';
                return;
            }

            let dividendsByStock = {};
            try { dividendsByStock = realizedDividendsByStock(state.cashFlow, loadLedger(state.isDemo)); }
            catch (error) { console.warn('無法讀取每檔已領股息，庫存表暫以現金流水計算。', error); }
            const totals = state.inventory.reduce((sum, inv) => {
                const cost = Number(inv.total_investment) || (Number(inv.avg_cost || 0) * Number(inv.total_shares || 0));
                sum.cost += cost;
                sum.marketValue += Number(inv.market_value || 0);
                sum.dividends += Number(dividendsByStock[String(inv.stock_code).trim()] || 0);
                sum.pnl += Number(inv.unrealized_pnl || 0);
                return sum;
            }, { cost: 0, marketValue: 0, dividends: 0, pnl: 0 });
            const totalRoi = totals.cost > 0 ? totals.pnl / totals.cost * 100 : 0;
            const totalRoiWithDividends = totals.cost > 0 ? (totals.pnl + totals.dividends) / totals.cost * 100 : 0;
            const totalPnlClass = totals.pnl >= 0 ? 'text-red-500' : 'text-emerald-400';
            const totalReturnClass = totalRoiWithDividends >= 0 ? 'text-red-500' : 'text-emerald-400';
            document.getElementById('inventory-table-footer').innerHTML = `
                <tr>
                    <td class="px-6 py-4 text-slate-100">TOTAL</td>
                    <td class="px-6 py-4">—</td>
                    <td class="px-6 py-4">—</td>
                    <td class="px-6 py-4 text-right">$${formatNumber(totals.cost)}</td>
                    <td class="px-6 py-4">—</td>
                    <td class="px-6 py-4 text-right">$${formatNumber(totals.marketValue)}</td>
                    <td class="px-6 py-4 text-right text-amber-300">$${formatNumber(totals.dividends)}</td>
                    <td class="px-6 py-4 text-right ${totalPnlClass}">${totals.pnl >= 0 ? '+' : ''}$${formatNumber(totals.pnl)}</td>
                    <td class="px-6 py-4 text-right ${totalPnlClass}">${totalRoi >= 0 ? '+' : ''}${totalRoi.toFixed(2)}%</td>
                    <td class="px-6 py-4 text-right ${totalReturnClass}">${totalRoiWithDividends >= 0 ? '+' : ''}${totalRoiWithDividends.toFixed(2)}%</td>
                </tr>
            `;


            body.innerHTML = state.inventory.map(inv => {
                const pnl = Number(inv.unrealized_pnl || 0);
                const roi = Number(inv.roi || 0) * 100;
                const receivedDividends = Number(dividendsByStock[String(inv.stock_code).trim()] || 0);
                const pnlClass = pnl >= 0 ? 'text-red-500 font-bold' : 'text-emerald-400 font-bold';
                const pnlPrefix = pnl >= 0 ? '+' : '';

                // 🚨 智慧自動推算累計投入本金 (容錯與自動計算)：
                // 讀取 Google Sheets 時若該欄位沒有值，自動由 平均買入成本 * 庫存股數 算出
                const calculatedCost = Number(inv.total_investment) || (Number(inv.avg_cost || 0) * Number(inv.total_shares || 0));
                const totalReturnRate = calculatedCost > 0 ? ((pnl + receivedDividends) / calculatedCost) * 100 : 0;
                const totalReturnClass = totalReturnRate >= 0 ? 'text-red-500 font-bold' : 'text-emerald-400 font-bold';
                const totalReturnPrefix = totalReturnRate >= 0 ? '+' : '';

                return `
                    <tr class="hover:bg-slate-900/50">
                        <td class="px-6 py-4 font-bold text-slate-200">${escapeHtml(inv.stock_code)} <span class="text-xs text-slate-400 font-normal block">${escapeHtml(inv.stock_name || '台股')}</span></td>
                        <td class="px-6 py-4 text-right font-mono">${formatNumber(inv.total_shares)} 股</td>
                        <td class="px-6 py-4 text-right font-mono text-slate-400">$${formatNumber(inv.avg_cost, 2)}</td>
                        <td class="px-6 py-4 text-right font-mono text-slate-300">$${formatNumber(calculatedCost)}</td>
                        <td class="px-6 py-4 text-right font-mono font-bold text-slate-100">$${formatNumber(inv.current_price, 2)}</td>
                        <td class="px-6 py-4 text-right font-mono font-bold text-slate-100">$${formatNumber(inv.market_value)}</td>
                        <td class="px-6 py-4 text-right font-mono text-amber-300">$${formatNumber(receivedDividends)}</td>
                        <td class="px-6 py-4 text-right font-mono ${pnlClass}">${pnlPrefix}$${formatNumber(pnl)}</td>
                        <td class="px-6 py-4 text-right font-mono ${pnlClass}">${pnlPrefix}${roi.toFixed(2)}%</td>
                        <td class="px-6 py-4 text-right font-mono ${totalReturnClass}">${totalReturnPrefix}${totalReturnRate.toFixed(2)}%</td>
                    </tr>
                `;
            }).join('');
        }

        /** 依最近十二個月已入帳股息計算共同月收入目標與達成率。 */
        function renderPassiveIncome() {
            const today = formatDateTaipei(new Date());
            const since = new Date(`${today}T12:00:00+08:00`);
            since.setFullYear(since.getFullYear() - 1);
            const sinceDate = formatDateTaipei(since);
            let trailing = 0;
            try { trailing = realizedDividendsSince(state.cashFlow, loadLedger(state.isDemo), sinceDate); }
            catch (error) { console.warn('近十二月股息計算失敗。', error); }
            const monthly = trailing / 12;
            const target = Number(state.investmentSettings.monthly_passive_income_target || 0);
            const progress = target > 0 ? monthly / target * 100 : 0;
            document.getElementById('card-monthly-passive-income').textContent = `$${formatNumber(monthly, 2)}`;
            document.getElementById('passive-income-target').textContent = target > 0 ? `$${formatNumber(target)}` : '尚未設定';
            document.getElementById('passive-income-progress-text').textContent = target > 0 ? `${progress.toFixed(1)}%` : '尚未設定';
            document.getElementById('passive-income-progress-bar').style.width = `${Math.min(Math.max(progress, 0), 100)}%`;
            const input = document.getElementById('settings-passive-income-target');
            if (input && document.activeElement !== input) input.value = target > 0 ? String(target) : '';
        }

        /** 顯示試算表同步時間、報價日期與異常代號，避免將舊報價誤認為即時行情。 */
        function renderQuoteQuality() {
            const panel = document.getElementById('quote-quality-panel');
            if (!panel) return;
            const quality = analyzeQuoteQuality(state.inventory, new Date(), state.isDemo);
            const synced = state.lastSyncAt
                ? new Date(state.lastSyncAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
                : '—';
            const dateRange = quality.oldestQuoteDate
                ? (quality.oldestQuoteDate === quality.newestQuoteDate ? quality.oldestQuoteDate : `${quality.oldestQuoteDate}～${quality.newestQuoteDate}`)
                : '未提供';
            const styles = {
                ok: ['行情資料正常', 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'],
                warning: ['行情資料需留意', 'bg-amber-500/10 text-amber-300 border-amber-500/30'],
                error: ['行情資料異常', 'bg-rose-500/10 text-rose-300 border-rose-500/30'],
                demo: ['Demo 固定報價', 'bg-slate-700/50 text-slate-300 border-slate-600'],
            };
            const [label, badgeClass] = styles[quality.level];
            const issues = [];
            if (quality.invalidCodes.length) issues.push(`無有效市價：${quality.invalidCodes.join('、')}`);
            if (quality.staleCodes.length) issues.push(`報價可能過期：${quality.staleCodes.join('、')}`);
            if (quality.missingDateCodes.length) issues.push(`缺少 price_date：${quality.missingDateCodes.join('、')}`);
            panel.innerHTML = `
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <div class="flex items-center gap-2"><h3 class="font-semibold text-slate-200">行情資料狀態</h3><span class="px-2 py-0.5 rounded-full border text-xs ${badgeClass}">${label}</span></div>
                        <p class="text-xs text-slate-400 mt-1">GOOGLEFINANCE 可能為延遲行情；同步成功不代表所有報價都是當日資料。</p>
                    </div>
                    <div class="text-xs text-slate-400 font-mono text-right"><p>網頁同步：${escapeHtml(synced)}</p><p>報價日期：${escapeHtml(dateRange)}</p></div>
                </div>
                ${issues.length ? `<div class="mt-3 text-xs text-amber-300 space-y-1">${issues.map(issue => `<p>${escapeHtml(issue)}</p>`).join('')}</div>` : ''}
            `;
        }

        // --- 6. 介面 Tabs 操作與彈窗機制 ---
        // 介面控制
        function openModal(modalId) {
            document.getElementById(modalId).classList.remove('hidden');
        }

        function closeModal(modalId) {
            document.getElementById(modalId).classList.add('hidden');
        }

        function toggleStockCodeInput() {
            const type = document.getElementById('cf-type').value;
            const wrapper = document.getElementById('cf-stock-code-wrapper');
            if (type === "證券交割支出" || type === "股息流入") {
                wrapper.classList.remove('hidden');
            } else {
                wrapper.classList.add('hidden');
                document.getElementById('cf-stock-code').value = "";
            }
        }

        // --- 7. 表單提交與同步邏輯 ---
        async function submitCashFlow(event) {
            event.preventDefault();
            const date = document.getElementById('cf-date').value;
            const contributor = document.getElementById('cf-contributor').value;
            const type = document.getElementById('cf-type').value;
            const stock_code = document.getElementById('cf-stock-code').value;
            const amount = Number(document.getElementById('cf-amount').value);
            const note = document.getElementById('cf-note').value;

            const rowData = [
                "FLOW_" + Date.now(),
                date,
                contributor,
                type,
                stock_code,
                amount,
                note
            ];

            showLoadingToast("正在將現金流水寫入雲端...");

            if (state.isDemo) {
                const newFlow = { id: rowData[0], date, contributor, type, stock_code, amount, note };
                const flows = JSON.parse(localStorage.getItem('demo_cash_flow')) || DEFAULT_CASH_FLOW;
                flows.push(newFlow);
                localStorage.setItem('demo_cash_flow', JSON.stringify(flows));
                closeModal('cashflow-modal');
                document.getElementById('cashflow-form').reset();
                await reloadData();
            } else {
                try {
                    const res = await fetch(state.apiUrl, {
                        method: 'POST',
                        body: JSON.stringify({
                            targetSheet: "users_cash_flow",
                            rowData: rowData
                        })
                    });
                    const result = await res.json();
                    if (result.status === "success") {
                        closeModal('cashflow-modal');
                        document.getElementById('cashflow-form').reset();
                        await reloadData();
                        showToast("現金流水帳儲存成功！", "check-circle", "text-emerald-400");
                    } else {
                        showToast("儲存失敗：" + result.message, "alert-circle", "text-red-400");
                    }
                } catch (err) {
                    showToast("同步雲端失敗，請確認 Apps Script 已部署為「所有人」！", "alert-circle", "text-red-400");
                }
            }
        }

        async function submitTransaction(event) {
            event.preventDefault();
            const date = document.getElementById('tx-date').value;
            const action = document.getElementById('tx-action').value;
            const stock_code = document.getElementById('tx-code').value;
            const stock_name = document.getElementById('tx-name').value;
            const price = Number(document.getElementById('tx-price').value);
            const shares = Number(document.getElementById('tx-shares').value);
            const fee = Number(document.getElementById('tx-fee').value);
            const tax = Number(document.getElementById('tx-tax').value);

            let total_amount = price * shares;
            if (action === "買入") {
                total_amount += fee;
            } else {
                total_amount = total_amount - fee - tax;
            }

            const rowData = [
                "TX_" + Date.now(),
                date,
                stock_code,
                stock_name,
                action,
                price,
                shares,
                fee,
                tax,
                total_amount,
                "" // 移除經手人
            ];

            showLoadingToast("正在將交易寫入試算表...");

            if (state.isDemo) {
                const newTx = {
                    id: rowData[0], date, stock_code, stock_name, action, price, shares, fee, tax, total_amount
                };
                const txs = JSON.parse(localStorage.getItem('demo_transactions')) || DEFAULT_TRANSACTIONS;
                txs.push(newTx);
                localStorage.setItem('demo_transactions', JSON.stringify(txs));

                const flows = JSON.parse(localStorage.getItem('demo_cash_flow')) || DEFAULT_CASH_FLOW;
                flows.push({
                    id: "FLOW_" + Date.now(),
                    date,
                    contributor: "共同",
                    type: "證券交割支出",
                    stock_code: stock_code,
                    amount: total_amount,
                    note: `系統自動連動交割: 買入 ${stock_name} ${shares} 股`
                });
                localStorage.setItem('demo_cash_flow', JSON.stringify(flows));

                closeModal('transaction-modal');
                document.getElementById('transaction-form').reset();
                await reloadData();
            } else {
                try {
                    await fetch(state.apiUrl, {
                        method: 'POST',
                        body: JSON.stringify({ targetSheet: "daily_transactions", rowData: rowData })
                    });
                    
                    const flowRowData = [
                        "FLOW_" + Date.now(),
                        date,
                        "共同",
                        "證券交割支出",
                        stock_code,
                        total_amount,
                        `系統自動連動: 交割 ${stock_name} ${shares} 股`
                    ];
                    
                    const resFlow = await fetch(state.apiUrl, {
                        method: 'POST',
                        body: JSON.stringify({ targetSheet: "users_cash_flow", rowData: flowRowData })
                    });
                    
                    const resJson = await resFlow.json();
                    if (resJson.status === "success") {
                        closeModal('transaction-modal');
                        document.getElementById('transaction-form').reset();
                        await reloadData();
                        showToast("交易登錄成功，現金已自動扣減！", "check-circle", "text-emerald-400");
                    } else {
                        showToast("儲存現金連動失敗", "alert-circle", "text-red-400");
                    }
                } catch (err) {
                    showToast("同步試算表失敗，請重試！", "alert-circle", "text-red-400");
                }
            }
        }

        // --- 8. 設定管理 ---
        async function saveApiSettings() {
            const url = document.getElementById('settings-api-url').value.trim();
            const husbandInput = document.getElementById('settings-husband-name').value.trim();
            const wifeInput = document.getElementById('settings-wife-name').value.trim();
            const target = Number(document.getElementById('settings-passive-income-target').value || 0);
            if (!Number.isFinite(target) || target < 0 || target > 1000000000) {
                showToast("被動收入目標必須是 0 到 10 億之間的數字。", "alert-triangle", "text-rose-400");
                return;
            }

            if (url) {
                const validation = validateGasUrl(url);
                if (!validation.valid) {
                    showToast("網址驗證失敗：" + validation.reason, "alert-triangle", "text-rose-400");
                    return; // 阻擋儲存，防禦性開發
                }
                localStorage.setItem("sheet_api_url", url);
            }
            
            // 儲存姓名客製化設定
            localStorage.setItem("husband_name", husbandInput);
            localStorage.setItem("wife_name", wifeInput);
            if (state.isDemo || !(url || state.apiUrl)) {
                localStorage.setItem('demo_monthly_passive_income_target', String(target));
            } else {
                try {
                    const response = await fetch(url || state.apiUrl, {
                        method: 'POST',
                        body: JSON.stringify({ action: 'saveSettings', settings: { monthly_passive_income_target: target } })
                    });
                    const result = await response.json();
                    if (result.status !== 'success') throw new Error(result.message || '設定儲存失敗');
                } catch (error) {
                    showToast("被動收入目標無法寫入 investment_settings，請先更新並部署 Apps Script。", "alert-circle", "text-red-400");
                    return;
                }
            }

            showToast("所有設定已儲存！即將自動刷新...", "check-circle", "text-emerald-400");
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        }

        // 智慧重置
        function resetToDemo() {
            localStorage.removeItem("sheet_api_url");
            localStorage.removeItem("demo_cash_flow");
            localStorage.removeItem("demo_transactions");
            localStorage.removeItem("husband_name");
            localStorage.removeItem("wife_name");
            localStorage.removeItem("demo_monthly_passive_income_target");
            showToast("已重置為 DEMO 測試模式，正在重刷...", "check-circle", "text-emerald-400");
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        }

        async function loadAppsScriptPreview() {
            try {
                const response = await fetch(`${import.meta.env.BASE_URL}google-apps-script.txt`, { cache: 'no-cache' });
                if (!response.ok) throw new Error('Apps Script 範本讀取失敗');
                document.getElementById('apps-script-code-block').textContent = await response.text();
            } catch (error) { console.warn(error); }
        }

        async function copyAppsScriptCode() {
            await loadAppsScriptPreview();
            const code = document.getElementById('apps-script-code-block').innerText;
            const textarea = document.createElement('textarea');
            textarea.value = code;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            showToast("Apps Script 語法已複製至剪貼簿！", "copy", "text-indigo-400");
        }

        // --- 9. 格式化工具 ---
        // 智慧轉型與小數格式化
        function showToast(message, iconName = "check-circle", iconColor = "text-emerald-400") {
            const toast = document.getElementById('toast');
            const toastMsg = document.getElementById('toast-message');
            const toastIcon = document.getElementById('toast-icon');

            toastMsg.textContent = message;
            toastIcon.setAttribute('class', `w-5 h-5 ${iconColor}`);
            toastIcon.setAttribute('data-lucide', iconName);
            lucide.createIcons();

            toast.classList.remove('translate-y-20', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');

            setTimeout(() => {
                toast.classList.add('translate-y-20', 'opacity-0');
                toast.classList.remove('translate-y-0', 'opacity-100');
            }, 3000);
        }

        function showLoadingToast(message) {
            showToast(message, "loader", "text-indigo-400 animate-spin");
        }
    
export const handlers = { showConnectionStatusToast, reloadData, openDiagnosticModal, openModal, closeModal, saveApiSettings, resetToDemo, copyAppsScriptCode, submitCashFlow, submitTransaction, toggleStockCodeInput };
