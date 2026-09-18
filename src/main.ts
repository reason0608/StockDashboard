import './styles.css';
import { createApp } from 'vue';
import DividendsPage from './pages/DividendsPage.vue';
import { handlers, initializeDashboard } from './legacy/dashboard.js';
import { initializeRouter, toggleTab } from './router';

// 既有表單改用白名單事件綁定，無需將函式掛到 window 或執行字串。
const actions: Record<string, Function> = { ...handlers, toggleTab };
document.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
  const handler = actions[element.dataset.action!];
  if (handler) element.addEventListener(element.dataset.event || 'click', event => {
    handler(element.dataset.arg ?? event);
  });
});
createApp(DividendsPage).mount('#dividends-app');
initializeRouter();
initializeDashboard().catch(error => {
  console.error(error);
  document.getElementById('connection-error-banner')?.classList.remove('hidden');
});
