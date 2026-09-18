# StockDashboard

Vue 3 + TypeScript + Vite 前端專案，既有帳務畫面以獨立 JavaScript 模組保留，新增股息追蹤以 Vue 元件實作。建置後仍部署到：

https://reason0608.github.io/StockDashboard/

## 本機開發

需要 Node.js 24（包含內建 TypeScript 型別移除供資料腳本使用）。

```sh
npm ci
npm run dev
```

開啟終端機顯示的 `/StockDashboard/` 網址。請勿直接雙擊 index.html。

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run preview
```

TypeScript 使用 5.9，避免 Vue 型別檢查工具尚未相容 TypeScript 7 的問題。套件版本由 package-lock.json 鎖定。

## 功能與相容性

- 原有資產總覽、現金流水、持股、交易及 Google Apps Script 連線保留。
- 保留 `sheet_api_url`、`husband_name`、`wife_name`、`demo_cash_flow`、`demo_transactions` 等既有 localStorage 鍵。
- `#/dashboard`、`#/inventory`、`#/dividends` 等 hash 分頁支援直接開啟、重新整理與瀏覽器返回。
- 股息表顯示除息日、發放日、每股金額、依交易紀錄自動推算的除息股數、稅前總額、匯費、淨額與入帳狀態。
- 年度與月份依發放日統計；未公告發放日暫歸除息年度，不歸入任何月份。
- 除息資格股數自動累計除息日前的買入減賣出；除息日當天交易不列入該次資格，沒有紀錄的日期視為沒有交易。已入帳後保存當時股數快照。
- 每次配息保存股數快照，賣出持股後紀錄仍保留。Demo 與個人模式分開保存。
- 每筆配息自動扣除固定 NT$10 匯費。已確認入帳後以「稅前總額－NT$10」計入總覽累計已落袋股息；同股票同發放日的唯一股息流水會自動去重。
- 股息備份匯入需先檢閱再確認；僅備份股息紀錄，**不含原有帳務或連線設定**。
- 股息紀錄只存於當前瀏覽器，不自動跨裝置、不同瀏覽器同步。原有帳務仍照現有 Sheets 方式同步。

## 股息資料更新

```sh
npm run update:dividends
```

公開來源：

1. [證交所上市除息預告](https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL)
2. [櫃買中心上櫃除息預告](https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost)
3. [證交所 ETF 收益分配](https://www.twse.com.tw/rwd/zh/ETF/etfDiv?response=json)
4. [FinMind 股利政策](https://finmind.github.io/tutor/TaiwanMarket/Fundamental/)：補充發放日與前一年度起的歷史。

官方近期預告自動涵蓋市場公告；ETF 包含來源提供的年度紀錄。FinMind 補充 `config/dividend-symbols.json` 的公開代號清單，以及近期尚未有發放日的代號，每次最多 120 檔。這份清單不是使用者持股，不應填入股數或帳戶資料。清單可擴充以補抓其他股票歷史。

FinMind 無 token 可用性及額度由來源決定，可在 GitHub Secrets 設定 `FINMIND_TOKEN`。只在排程環境使用，不得加上 VITE_ 前綴或寫入前端。無 token 仍嘗試公開讀取，失敗會標示部分缺漏，不影響已成功取得的官方公告。來源使用須遵守其條款，不保證完整涵蓋所有市場、歷史或修正公告。

快照只含公開市場欄位，不上傳持股、交易、姓名或 Sheets URL。更新使用暫存檔再替換；單一來源失敗保留先前資料與成功時間，全部官方來源失敗則中止，避免覆寫正常網站。每筆事件也保留資料時間。官方預告是滾動窗口，歷史自首次排程累積；移出來源的舊事件保留供核對，不推定公告已撤銷或已發放。除息日期改期會成為新事件，需人工核對原快照。

每股金額 × 除息日前自動股數為稅前總額，預估淨額再固定扣除 NT$10 匯費，顯示至小數點後兩位；若稅前總額不足 NT$10，淨額以零計。不另計所得稅、補充保費或券商捨入規則，不預測未公告配息。股票股利及非台幣配息不在本版範圍內。

## GitHub Pages 發布

1. 將本次程式及 package-lock.json 推送至 main。
2. 儲存庫 Settings → Pages → Build and deployment → Source 選 **GitHub Actions**。
3. Actions → **Build and deploy dashboard** → Run workflow，或由 main 推送自動觸發。
4. 成功後原網址不變；股息網址為 `https://reason0608.github.io/StockDashboard/#/dividends`。

工作流程會安裝套件、跑單元測試、更新公開股息、型別檢查、建置、跑瀏覽器測試，最後發布 `dist/`。Pull request 只執行驗證，不更新遠端網站。

每日 UTC 10:23（台北 18:23）更新，排程可能延遲；公開 repo 長期沒有活動時 GitHub 可能停用排程。可手動 Run workflow 恢復並留意 Actions 狀態。股息頁顯示快照及各來源時間，超過三天提示可能過期。

排程透過 `--restore-published` 從既有公開網站快照續接歷史，不需要每天 commit JSON。首次發布或無法取得既有快照時使用儲存庫內基準檔。備份公共快照可避免網站移除或部署回滾後遺失累積歷史。

## 專案結構

```text
index.html                   原有頁面結構與帳務表單
src/main.ts                  前端入口及事件綁定
src/router.ts                GitHub Pages hash 分頁
src/legacy/                  既有帳務與圖表模組
src/pages/DividendsPage.vue   股息畫面
src/domain/dividends.ts      計算、快照、外部檔案驗證
src/services/dividends.ts    同站資料讀取、本機保存、快取
src/shared/                  共用格式化／輸出跳脫
scripts/                     公開資料同步與來源轉換
config/dividend-symbols.json 公開資料補充代號
public/data/dividends.json   已取得的真實公開公告
tests/                       單元與瀏覽器測試
.github/workflows/pages.yml  建置、測試、每日更新與部署
```

`code_artifact.html` 是原有參考檔，未納入建置。

## 後續維護

- 既有 JavaScript 帳務模組逐步遷移 Vue／TypeScript，無須一次重寫。
- 現有 Apps Script 設定仍是原本公開 Web App 存取模型；若需要多人使用、存取控制或跨裝置股息同步，再設計具身分驗證的後端。不要把私人連線 URL 寫入公開原始碼。
- 現有 Demo 庫存成本計算及雲端失敗降級沿用原行為，非本次新增的股息計算。未來若改成依交易自動判定領息股數，需處理歷史缺漏、分割、配股及轉入／轉出。
