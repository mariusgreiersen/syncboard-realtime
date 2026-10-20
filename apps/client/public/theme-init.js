// Applies the saved theme before first paint to avoid a flash (kept external for a strict CSP).
try {
  var stored = JSON.parse(localStorage.getItem('syncboard-ui') || '{}').state || {};
  var theme = stored.theme || 'system';
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
} catch {
  /* storage unavailable: keep the light default */
}
