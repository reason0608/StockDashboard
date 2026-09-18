/** 將外部文字轉成安全的 HTML 文字／屬性內容；value 為任何顯示值。 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 以台灣格式顯示數字，decimals 指定小數位數，回傳顯示文字。 */
export function formatNumber(num, decimals = 0) {
  return Number(num || 0).toLocaleString('zh-TW', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
