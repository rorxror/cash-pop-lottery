/* Cash Pop — player site interactions (vanilla JS, no deps) */
(function () {
  'use strict';

  /* ---------- Money formatting (minor units -> currency string) ---------- */
  function fmtMoney(minor, code) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD' }).format((minor || 0) / 100);
    } catch (e) {
      return ((minor || 0) / 100).toFixed(2) + ' ' + (code || '');
    }
  }

  /* ---------- (a) Playslip ---------- */
  var form = document.getElementById('playForm');
  if (form) {
    var cur = form.getAttribute('data-cur') || 'USD';
    var ballBox = document.getElementById('ballBox');
    var inputs = Array.prototype.slice.call(ballBox.querySelectorAll('.ball-input'));
    var wagerSel = document.getElementById('wagerSel');
    var numDrawsSel = document.getElementById('numDrawsSel');
    var popCount = document.getElementById('popCount');
    var slPops = document.getElementById('slPops');
    var slWager = document.getElementById('slWager');
    var slDraws = document.getElementById('slDraws');
    var totalAmt = document.getElementById('totalAmt');
    var totalAmtBtn = document.getElementById('totalAmtBtn');
    var prizePreview = document.getElementById('prizePreview');
    var prizeData = [];
    try { prizeData = JSON.parse(document.getElementById('prizeData').textContent || '[]'); } catch (e) { prizeData = []; }

    function selectedPops() { return inputs.filter(function (i) { return i.checked; }); }
    function drawType() {
      var r = form.querySelector('input[name="draw_type"]:checked');
      return r ? r.value : 'DAY';
    }
    function multFor(pops) {
      for (var i = 0; i < prizeData.length; i++) {
        if (Number(prizeData[i].pops) === pops) return Number(prizeData[i].mult);
      }
      return 0;
    }
    function recalc() {
      var pops = selectedPops().length;
      var wager = Number(wagerSel.value) || 0;
      var draws = Number(numDrawsSel.value) || 1;
      var dt = drawType();
      var mult = dt === 'BOTH' ? 2 : 1;
      var total = pops * wager * draws * mult;
      var dtLabel = dt === 'BOTH' ? 'Both (Day+Eve)' : dt === 'EVE' ? 'Evening' : 'Day';

      popCount.textContent = pops;
      slPops.textContent = pops;
      slWager.textContent = fmtMoney(wager, cur);
      slDraws.textContent = draws + ' x ' + dtLabel;
      totalAmt.textContent = fmtMoney(total, cur);
      if (totalAmtBtn) totalAmtBtn.textContent = fmtMoney(total, cur);

      var m = multFor(pops);
      if (prizePreview) {
        prizePreview.textContent = pops > 0 && m > 0
          ? 'Per-pop prize if your number hits: ' + fmtMoney(wager * m, cur) + ' (x' + m + ')'
          : 'Select at least one pop to see the prize preview.';
      }
    }
    function pickRandom(n) {
      inputs.forEach(function (i) { i.checked = false; });
      var pool = inputs.slice();
      for (var k = 0; k < n && pool.length; k++) {
        var idx = Math.floor(Math.random() * pool.length);
        pool.splice(idx, 1)[0].checked = true;
      }
      recalc();
    }
    ballBox.addEventListener('change', recalc);
    wagerSel.addEventListener('change', recalc);
    numDrawsSel.addEventListener('change', recalc);
    form.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'draw_type') recalc();
    });
    document.getElementById('quickPick').addEventListener('click', function () { pickRandom(5); });
    document.getElementById('coverAll').addEventListener('click', function () {
      inputs.forEach(function (i) { i.checked = true; });
      recalc();
    });
    document.getElementById('clearBalls').addEventListener('click', function () {
      inputs.forEach(function (i) { i.checked = false; });
      recalc();
    });
    form.addEventListener('submit', function (e) {
      if (selectedPops().length === 0) {
        e.preventDefault();
        alert('Please pick at least one pop.');
      }
    });
    recalc();
  }

  /* ---------- (b) Countdowns ---------- */
  function tick() {
    var now = Date.now();
    document.querySelectorAll('.countdown[data-close-at]').forEach(function (el) {
      var closeAt = Number(el.getAttribute('data-close-at'));
      if (!closeAt || isNaN(closeAt)) { el.textContent = '--:--:--'; return; }
      var ms = closeAt - now;
      if (ms <= 0) { el.textContent = 'Closing...'; return; }
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400); s -= d * 86400;
      var h = Math.floor(s / 3600); s -= h * 3600;
      var m = Math.floor(s / 60); s -= m * 60;
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      el.textContent = (d > 0 ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
    });
  }
  if (document.querySelector('.countdown[data-close-at]')) {
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- (c) Cookie banner ---------- */
  var banner = document.getElementById('cookie-banner');
  if (banner) {
    var KEY = 'cp_cookie_ok';
    try {
      if (localStorage.getItem(KEY) === '1') {
        banner.setAttribute('hidden', '');
      } else {
        banner.removeAttribute('hidden');
      }
    } catch (e) { banner.removeAttribute('hidden'); }
    var okBtn = document.getElementById('cookie-ok');
    if (okBtn) okBtn.addEventListener('click', function () {
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      banner.setAttribute('hidden', '');
    });
    var noBtn = document.getElementById('cookie-no');
    if (noBtn) noBtn.addEventListener('click', function () {
      try { localStorage.setItem(KEY, '0'); } catch (e) {}
      banner.setAttribute('hidden', '');
    });
  }

  /* ---------- (d) Deposit / withdraw charge preview ---------- */
  ['depAmount', 'wdAmount'].forEach(function (id) {
    var amt = document.getElementById(id);
    var prev = document.getElementById('chargePreview');
    if (!amt || !prev) return;
    function update() {
      var v = Number(amt.value) || 0; // minor units
      var fixed = Number(amt.getAttribute('data-fixed')) || 0;
      var pct = Number(amt.getAttribute('data-percent')) || 0;
      var code = amt.getAttribute('data-currency') || 'USD';
      var charge = fixed + Math.round(v * pct / 100);
      prev.textContent = v > 0
        ? 'Charge: ' + fmtMoney(charge, code) + ' — you will be credited ' + fmtMoney(Math.max(0, v - charge), code)
        : '';
    }
    amt.addEventListener('input', update);
    update();
  });

  /* ---------- (e) Mobile nav toggle ---------- */
  var navToggle = document.getElementById('navToggle');
  var mainNav = document.getElementById('mainNav');
  if (navToggle && mainNav) {
    navToggle.addEventListener('click', function () {
      var open = mainNav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* User menu dropdown */
  var userMenu = document.getElementById('userMenu');
  var userMenuBtn = document.getElementById('userMenuBtn');
  if (userMenu && userMenuBtn) {
    userMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = userMenu.classList.toggle('open');
      userMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!userMenu.contains(e.target)) userMenu.classList.remove('open');
    });
  }

  /* ---------- (f) Confirm on [data-confirm] ---------- */
  document.querySelectorAll('[data-confirm]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (!window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
    });
  });
})();
