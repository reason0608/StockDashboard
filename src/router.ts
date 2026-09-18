const tabs = ['dashboard', 'cash-flow', 'inventory', 'dividends', 'transactions', 'settings'];

/** 切換白名單分頁並保存 hash，讓 Pages 重新整理與上一頁都可使用。 */
export function toggleTab(requested: string) {
  const tab = tabs.includes(requested) ? requested : 'dashboard';
  for (const id of tabs) {
    document.getElementById(`tab-content-${id}`)?.classList.toggle('hidden', id !== tab);
    const button = document.getElementById(`tab-btn-${id}`);
    if (button) {
      button.className = `px-4 py-2.5 border-b-2 font-medium text-sm flex items-center gap-2 whitespace-nowrap transition-all ${id === tab ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`;
      button.setAttribute('aria-current', id === tab ? 'page' : 'false');
    }
  }
  if (location.hash !== `#/${tab}`) location.hash = `/${tab}`;
}

/** 綁定瀏覽器返回與直接開啟分頁。 */
export function initializeRouter() {
  const route = () => toggleTab(location.hash.slice(2));
  window.addEventListener('hashchange', route);
  route();
}
