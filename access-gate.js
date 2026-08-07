// Lightweight access gate — keeps casual/accidental visitors and search
// engines out. This is NOT real security: the page source is public, so
// anyone determined enough can read this file and find the hash. It's a
// deterrent, not a lock. Once entered correctly, the unlock is remembered
// in this browser (localStorage) so the team doesn't retype it every visit.

(function () {
  var UNLOCK_KEY = 'reseller-insights:unlocked';
  var PASSWORD_HASH = 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3'; // sha256("123")

  var alreadyUnlocked = false;
  try { alreadyUnlocked = localStorage.getItem(UNLOCK_KEY) === '1'; } catch (err) { /* ignore */ }
  if (alreadyUnlocked) return;

  document.documentElement.style.visibility = 'hidden';

  function sha256Hex(text) {
    var data = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  function showGate() {
    document.documentElement.style.visibility = '';
    var gate = document.createElement('div');
    gate.id = 'access-gate';
    gate.innerHTML =
      '<form id="access-gate-form">' +
        '<p class="access-gate-label">Reseller Insights</p>' +
        '<p class="access-gate-hint">Internal tool — enter the team password.</p>' +
        '<input type="password" id="access-gate-input" autocomplete="off" autofocus>' +
        '<button type="submit">Enter</button>' +
        '<p class="access-gate-error" id="access-gate-error" hidden>Wrong password — try again.</p>' +
      '</form>';
    document.body.appendChild(gate);

    var form = document.getElementById('access-gate-form');
    var input = document.getElementById('access-gate-input');
    var error = document.getElementById('access-gate-error');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      sha256Hex(input.value).then(function (hash) {
        if (hash === PASSWORD_HASH) {
          try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (err) { /* ignore */ }
          gate.remove();
        } else {
          error.hidden = false;
          input.value = '';
          input.focus();
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showGate);
  } else {
    showGate();
  }
})();
