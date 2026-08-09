// Light/dark theme toggle. Defaults to light regardless of OS preference;
// runs early (before first paint) so there's no flash of the wrong theme.
(function () {
  var THEME_KEY = 'reseller-insights:theme';
  var theme = 'light';
  try {
    if (localStorage.getItem(THEME_KEY) === 'dark') theme = 'dark';
  } catch (err) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);

  function updateButton() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    var isDark = theme === 'dark';
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function applyTheme(t) {
    theme = t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (err) { /* ignore */ }
    updateButton();
  }

  function init() {
    updateButton();
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        applyTheme(theme === 'dark' ? 'light' : 'dark');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
