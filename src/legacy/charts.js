import Chart from 'chart.js/auto';
import { escapeHtml, formatNumber } from '../shared/format.js';
let contributionChartInstance = null;
let assetAllocationChartInstance = null;
        // --- 5. 出資與資產比重圖表渲染 (Chart.js) (調整為完全支援動態出資人代名) ---
        export function renderContributionChart(husband, wife, joint, husbandName, wifeName) {
            const ctx = document.getElementById('contributionChart').getContext('2d');
            const total = husband + wife + joint;
            
            const husbandPct = total > 0 ? ((husband / total) * 100).toFixed(1) : 0;
            const wifePct = total > 0 ? ((wife / total) * 100).toFixed(1) : 0;
            const jointPct = total > 0 ? ((joint / total) * 100).toFixed(1) : 0;

            const legendContainer = document.getElementById('contribution-legend');
            legendContainer.innerHTML = `
                <div class="flex items-center justify-between text-xs">
                    <span class="flex items-center gap-1.5"><span class="w-3 h-3 bg-indigo-500 rounded-full"></span>${escapeHtml(husbandName)} 投入</span>
                    <span class="font-mono text-slate-300 font-bold">$${formatNumber(husband)} (${husbandPct}%)</span>
                </div>
                <div class="flex items-center justify-between text-xs">
                    <span class="flex items-center gap-1.5"><span class="w-3 h-3 bg-pink-500 rounded-full"></span>${escapeHtml(wifeName)} 投入</span>
                    <span class="font-mono text-slate-300 font-bold">$${formatNumber(wife)} (${wifePct}%)</span>
                </div>
                <div class="flex items-center justify-between text-xs">
                    <span class="flex items-center gap-1.5"><span class="w-3 h-3 bg-amber-500 rounded-full"></span>共同存款</span>
                    <span class="font-mono text-slate-300 font-bold">$${formatNumber(joint)} (${jointPct}%)</span>
                </div>
            `;

            if (contributionChartInstance) contributionChartInstance.destroy();

            contributionChartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: [husbandName, wifeName, '共同存款'],
                    datasets: [{
                        data: [husband, wife, joint],
                        backgroundColor: ['#6366f1', '#ec4899', '#f59e0b'],
                        borderWidth: 0,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    cutout: '70%'
                }
            });
        }

        export function renderAssetAllocationChart(cash, inventoryList) {
            const ctx = document.getElementById('assetAllocationChart').getContext('2d');
            
            let stockTotal = 0;
            const labels = ['現金'];
            const data = [cash];
            const colors = ['#10b981'];

            inventoryList.forEach((inv, index) => {
                stockTotal += Number(inv.market_value || 0);
                labels.push(`${inv.stock_code} ${inv.stock_name || ''}`);
                data.push(Number(inv.market_value || 0));
                const hue = (210 + (index * 45)) % 360;
                colors.push(`hsl(${hue}, 80%, 60%)`);
            });

            const grandTotal = cash + stockTotal;
            const listContainer = document.getElementById('asset-allocation-list');
            
            let listHtml = `
                <div class="flex justify-between items-center text-xs pb-1 border-b border-slate-800">
                    <span class="text-slate-400">資產類別 / 股票</span>
                    <span class="text-slate-400">總值 (比例)</span>
                </div>
                <div class="flex justify-between items-center text-xs">
                    <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 bg-emerald-500 rounded-full"></span>現金</span>
                    <span class="font-semibold text-slate-200 font-mono">$${formatNumber(cash)} (${grandTotal > 0 ? ((cash/grandTotal)*100).toFixed(1) : 0}%)</span>
                </div>
            `;

            inventoryList.forEach((inv, index) => {
                const color = colors[index + 1];
                const pct = grandTotal > 0 ? ((inv.market_value / grandTotal) * 100).toFixed(1) : 0;
                listHtml += `
                    <div class="flex justify-between items-center text-xs">
                        <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full" style="background-color: ${color}"></span>${escapeHtml(inv.stock_code)} ${escapeHtml(inv.stock_name || '台股')}</span>
                        <span class="font-semibold text-slate-200 font-mono">$${formatNumber(inv.market_value)} (${pct}%)</span>
                    </div>
                `;
            });
            listContainer.innerHTML = listHtml;

            if (assetAllocationChartInstance) assetAllocationChartInstance.destroy();

            assetAllocationChartInstance = new Chart(ctx, {
                type: 'pie',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: colors,
                        borderWidth: 0,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } }
                }
            });
        }

