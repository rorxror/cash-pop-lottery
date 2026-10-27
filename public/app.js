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
    function checkedVal(name, dflt) {
      var r = form.querySelector('input[name="' + name + '"]:checked');
      return r ? r.value : dflt;
    }
    function drawType() { return checkedVal('draw_type', 'DAY'); }
    function wagerVal() { return Number(checkedVal('wager', '0')) || 0; }
    function drawsVal() { return Number(checkedVal('num_draws', '1')) || 1; }
    function multFor(pops) {
      for (var i = 0; i < prizeData.length; i++) {
        if (Number(prizeData[i].pops_count) === pops) return Number(prizeData[i].multiplier);
      }
      return 0;
    }
    function recalc() {
      var pops = selectedPops().length;
      var wager = wagerVal();
      var draws = drawsVal();
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
      var buyBtn = document.getElementById('buyBtn');
      if (buyBtn) buyBtn.disabled = pops === 0;
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
    form.addEventListener('change', function (e) {
      if (e.target && (e.target.name === 'draw_type' || e.target.name === 'wager' || e.target.name === 'num_draws')) recalc();
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

  /* ---------- (a2) Live hero counters ---------- */
  // Counters animate on every page load — logged out AND logged in, identically.
  // Count-up runs from 0 to the TRUE value (real mode: no fake data, the final
  // number is always the real DB total). In marketing mode they keep ticking up
  // afterwards for effect; in real mode they stay pinned to the true value.
  document.querySelectorAll('.live-count').forEach(function (el) {
    var base = parseInt(el.getAttribute('data-count'), 10) || 0;
    var mode = el.getAttribute('data-mode') || 'real';
    var isMoney = el.getAttribute('data-money') === '1';
    var val = base;
    function fmt(v) {
      if (isMoney) return '$' + (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return v.toLocaleString('en-US');
    }
    // Count-up on load: ease-out over ~1.4s, ends exactly at the true value
    var start = null, dur = 1400;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(base * eased));
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = fmt(base);
    }
    requestAnimationFrame(step);
    if (mode === 'marketing') {
      setInterval(function () {
        val += isMoney ? Math.floor(Math.random() * 500) + 100 : (Math.random() < 0.3 ? 1 : 0);
        el.textContent = fmt(val);
      }, 3000);
    }
  });

  /* ---------- (a3) Live stats refresh (real values only) ---------- */
  // Every 30s the homepage asks the server for the TRUE totals. When a real
  // payout or signup lands, numbers tween smoothly to the new real value —
  // they never tick up on their own. Winners ticker rebuilds only when the
  // real winner list actually changes.
  var liveEls = {
    players: document.querySelector('.live-count[data-count]:nth-of-type(1)'),
  };
  var statEls = document.querySelectorAll('.live-count');
  var lastWinsKey = '';
  function tweenNum(el, from, to, isMoney) {
    var start = null, dur = 1000;
    function fmt(v) {
      if (isMoney) return '$' + (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return Math.round(v).toLocaleString('en-US');
    }
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
    }
    requestAnimationFrame(step);
  }
  async function refreshStats() {
    if (document.hidden) return;
    try {
      var r = await fetch('/api/stats', { headers: { 'Accept': 'application/json' } });
      if (!r.ok) return;
      var d = await r.json();
      // Hero stats are in order: players, tickets today, paid out
      var vals = [d.players, d.tickets_today, d.paid_out];
      statEls.forEach(function (el, i) {
        if (vals[i] === undefined) return;
        var cur = parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10);
        if (isNaN(cur)) cur = 0;
        var isMoney = el.getAttribute('data-money') === '1';
        var target = isMoney ? d.paid_out : vals[i];
        // Money el stores cents in data-count; displayed text strips to dollars — compare via target
        var displayed = isMoney ? Math.round(d.paid_out / 100) : vals[i];
        var curDisp = parseInt((el.textContent || '').replace(/[^0-9.]/g, ''), 10);
        if (!isNaN(curDisp) && curDisp !== displayed) {
          var fromVal = isMoney ? curDisp * 100 : curDisp;
          tweenNum(el, fromVal, target, isMoney);
        }
        el.setAttribute('data-count', target);
      });
      // Winners ticker: rebuild only on real change
      var winsKey = JSON.stringify(d.recentWins || []);
      var track = document.getElementById('winnersTicker');
      if (track && winsKey && winsKey !== lastWinsKey) {
        if (lastWinsKey) {
          var items = (d.recentWins || []).map(function (w) {
            return '<span class="ticker-item"><strong>' + w.name + '</strong> won ' + w.amount_fmt + ' <span class="verified-badge">✓ Verified</span></span>';
          }).join('');
          track.innerHTML = items + items; // duplicated for seamless loop
        }
        lastWinsKey = winsKey;
      } else if (track && !lastWinsKey) {
        lastWinsKey = winsKey;
      }
    } catch (e) { /* offline or server hiccup — keep showing last real values */ }
  }
  if (statEls.length) setInterval(refreshStats, 30000);

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
    function syncCookieBody() {
      try { document.body.classList.toggle('has-cookie', !banner.hasAttribute('hidden')); } catch (e) {}
    }
    try {
      if (localStorage.getItem(KEY) !== null) {
        banner.setAttribute('hidden', '');
      } else {
        banner.removeAttribute('hidden');
      }
    } catch (e) { banner.removeAttribute('hidden'); }
    syncCookieBody();
    var okBtn = document.getElementById('cookie-ok');
    if (okBtn) okBtn.addEventListener('click', function () {
      try { localStorage.setItem(KEY, '1'); } catch (e) {}
      banner.setAttribute('hidden', '');
      syncCookieBody();
    });
    var noBtn = document.getElementById('cookie-no');
    if (noBtn) noBtn.addEventListener('click', function () {
      try { localStorage.setItem(KEY, '0'); } catch (e) {}
      banner.setAttribute('hidden', '');
      syncCookieBody();
    });
  }

  /* ---------- (c1) Prevent double form submission (money safety) ---------- */
  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented || !e.target || e.target.tagName !== 'FORM') return;
    var btns = e.target.querySelectorAll('button[type="submit"], input[type="submit"]');
    btns.forEach(function (b) {
      if (b.disabled) return;
      b.disabled = true;
      if (b.tagName === 'BUTTON' && !b.dataset.origText) {
        b.dataset.origText = b.textContent;
        b.textContent = 'Processing\u2026';
      }
    });
  });

  /* ---------- (c2) Slip panel collapse (mobile) ---------- */
  var slipToggle = document.getElementById('slipToggle');
  var totalBox = document.getElementById('totalBox');
  if (slipToggle && totalBox) slipToggle.addEventListener('click', function () {
    var collapsed = totalBox.classList.toggle('collapsed');
    slipToggle.textContent = collapsed ? 'Show' : 'Hide';
  });


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
    navToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = mainNav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // close when a link is tapped or when tapping outside
    mainNav.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        mainNav.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('click', function (e) {
      if (mainNav.classList.contains('open') && !mainNav.contains(e.target) && e.target !== navToggle) {
        mainNav.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- (f) Generic collapsible sections ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.collapse-toggle'), function (btn) {
    var target = document.getElementById(btn.getAttribute('data-target'));
    function syncSection() {
      if (!target) return;
      var sec = btn.closest('section');
      if (sec) sec.classList.toggle('is-collapsed', target.classList.contains('collapsed'));
    }
    syncSection();
    btn.addEventListener('click', function () {
      if (!target) return;
      var hidden = target.classList.toggle('collapsed');
      btn.textContent = hidden ? 'Show' : 'Hide';
      btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      syncSection();
    });
  });

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

/* ---------- (g) Moved inline scripts (v14 CSP: no inline <script> in views) ---------- */
(function () {
  'use strict';

  /* Register: combine dial code + local number into the hidden phone field */
  var registerForm = document.getElementById('registerForm');
  if (registerForm) registerForm.addEventListener('submit', function () {
    var ccEl = document.getElementById('phoneCc');
    var localEl = document.getElementById('phoneLocal');
    var fullEl = document.getElementById('phoneFull');
    if (!ccEl || !localEl || !fullEl) return;
    var cc = ccEl.value.replace(/\D/g, '');
    var local = localEl.value.replace(/\D/g, '');
    fullEl.value = (cc && local) ? ('+' + cc + local) : '';
  });

  /* Login: method tabs (Password / OTP) */
  var methodSegs = document.querySelectorAll('.auth-methods .seg');
  var pwPane = document.getElementById('loginPw');
  var otpPane = document.getElementById('loginOtp');
  methodSegs.forEach(function (b) {
    b.addEventListener('click', function () {
      methodSegs.forEach(function (x) { x.classList.toggle('active', x === b); });
      var m = b.dataset.method;
      if (pwPane) pwPane.hidden = (m !== 'password');
      if (otpPane) otpPane.hidden = (m !== 'otp');
    });
  });

  /* Login: password form routes identifier to email or phone field */
  var pwForm = document.getElementById('pwForm');
  if (pwForm) pwForm.addEventListener('submit', function () {
    var inp = document.getElementById('pwIdentifier');
    if (!inp) return;
    var v = inp.value.trim();
    inp.name = (v.indexOf('@') === -1) ? 'phone' : 'email';
  });

  /* Login: OTP flow (only rendered when admin enabled OTP) */
  var otpPaneEl = document.getElementById('loginOtp');
  if (otpPaneEl) (function () {
    var type = 'phone';
    var phoneOtpOn = otpPaneEl.getAttribute('data-phone-otp') !== 'false';
    var emailOtpOn = otpPaneEl.getAttribute('data-email-otp') !== 'false';
    var segs = document.querySelectorAll('.auth-otp-types .seg');
    var label = document.getElementById('otpLabel');
    var input = document.getElementById('otpIdentifier');
    var hint = document.getElementById('otpHint');
    var step1 = document.getElementById('otpStep1');
    var step2 = document.getElementById('otpStep2');
    var stepProfile = document.getElementById('authStepProfile');
    var err = document.getElementById('otpError');
    var sentTo = document.getElementById('otpSentTo');
    var identifier = '';
    var csrfToken = '';
    function showErr(m) { err.textContent = m; err.hidden = false; }
    function hideErr() { err.hidden = true; }
    var phoneRow = document.getElementById('otpPhoneRow');
    var phoneLocal = document.getElementById('otpPhoneLocal');
    var ccSel = document.getElementById('otpCc');
    function setType(t) {
      type = t;
      segs.forEach(function (b) { b.classList.toggle('active', b.dataset.type === t); });
      if (t === 'phone') {
        label.textContent = 'Phone number';
        phoneRow.hidden = false; input.hidden = true;
        hint.textContent = "We'll text you a 6-digit code.";
      } else {
        label.textContent = 'Email address';
        phoneRow.hidden = true; input.hidden = false; input.type = 'email';
        hint.textContent = "We'll email you a 6-digit code.";
      }
    }
    segs.forEach(function (b) { b.addEventListener('click', function () { setType(b.dataset.type); }); });
    if (document.querySelector('.auth-otp-types .seg[data-type="email"].active')) setType('email');
    var reqBtn = document.getElementById('otpRequestBtn');
    if (reqBtn) reqBtn.addEventListener('click', async function () {
      hideErr();
      if (type === 'phone') {
        var cc = ccSel.value.replace(/\D/g, '');
        var local = phoneLocal.value.replace(/\D/g, '');
        identifier = (cc && local) ? ('+' + cc + local) : '';
      } else {
        identifier = input.value.trim();
      }
      if (!identifier) return showErr(type === 'phone' ? 'Please enter your phone number.' : 'Please enter your email address.');
      var r = await fetch('/login/otp/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: type, identifier: identifier }) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) return showErr(d.error || 'Could not send code. Please try again.');
      sentTo.textContent = identifier;
      step1.hidden = true; step2.hidden = false;
      document.getElementById('otpCode').focus();
    });
    var verifyBtn = document.getElementById('otpVerifyBtn');
    if (verifyBtn) verifyBtn.addEventListener('click', async function () {
      hideErr();
      var code = document.getElementById('otpCode').value.trim();
      if (code.length !== 6) return showErr('Please enter the 6-digit code.');
      var r = await fetch('/login/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: type, identifier: identifier, code: code }) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) return showErr(d.error || 'Invalid code. Please try again.');
      if (d.needsProfile) { if (d.csrf) csrfToken = d.csrf; step2.hidden = true; stepProfile.hidden = false; document.getElementById('authFullName').focus(); return; }
      window.location.href = d.redirect || '/';
    });
    var resend = document.getElementById('otpResend');
    if (resend) resend.addEventListener('click', async function (e) {
      e.preventDefault(); hideErr();
      var r = await fetch('/login/otp/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: type, identifier: identifier }) });
      if (!r.ok) showErr('Could not resend code. Please wait and try again.');
    });
    var back = document.getElementById('otpBack');
    if (back) back.addEventListener('click', function (e) { e.preventDefault(); hideErr(); step2.hidden = true; step1.hidden = false; input.focus(); });
    var profileBtn = document.getElementById('authProfileBtn');
    if (profileBtn) profileBtn.addEventListener('click', async function () {
      hideErr();
      var nm = document.getElementById('authFullName').value.trim();
      if (nm.length < 2) return showErr('Please enter your full name.');
      if (!document.getElementById('authAgree').checked) return showErr('Please accept the Terms & Privacy Policy.');
      var r = await fetch('/login/complete-profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name: nm, agree: true }) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) return showErr(d.error || 'Could not save your profile. Please try again.');
      window.location.href = d.redirect || '/';
    });
  })();

  /* Scratch ticket: foil canvas */
  (function () {
    var canvas = document.getElementById('foil'), area = document.getElementById('scratchArea'), form = document.getElementById('revealForm');
    if (!canvas || !area || !form) return;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var down = false, submitted = false;
    function size() {
      var r = area.getBoundingClientRect();
      canvas.width = Math.max(280, Math.floor(r.width));
      canvas.height = Math.max(220, Math.floor(r.height));
      ctx.globalCompositeOperation = 'source-over';
      var g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      g.addColorStop(0, '#9aa3ad'); g.addColorStop(.5, '#e4e7eb'); g.addColorStop(1, '#7d8792');
      ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#25304c'; ctx.font = '700 22px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('SCRATCH HERE', canvas.width / 2, canvas.height / 2);
      ctx.globalCompositeOperation = 'destination-out';
    }
    function point(e) {
      var r = canvas.getBoundingClientRect(), p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * canvas.width / r.width, y: (p.clientY - r.top) * canvas.height / r.height };
    }
    function scratch(e) {
      if (!down) return;
      e.preventDefault();
      var p = point(e);
      ctx.beginPath(); ctx.arc(p.x, p.y, 26, 0, Math.PI * 2); ctx.fill();
      measure();
    }
    var check = 0;
    function measure(force) {
      if (!force && ++check % 3) return;
      var d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var clear = 0;
      for (var i = 3; i < d.length; i += 16) if (d[i] < 32) clear++;
      var pct = Math.min(100, Math.round(clear / (d.length / 16) * 100));
      document.getElementById('scratchPct').textContent = pct + '%';
      document.getElementById('scratchBar').style.width = pct + '%';
      if (pct >= 60 && !submitted) {
        submitted = true;
        document.getElementById('scratchHint').textContent = 'Revealing your locked result…';
        form.submit();
      }
    }
    canvas.addEventListener('pointerdown', function (e) { down = true; canvas.setPointerCapture(e.pointerId); scratch(e); });
    canvas.addEventListener('pointermove', scratch);
    canvas.addEventListener('pointerup', function () { down = false; measure(true); });
    canvas.addEventListener('pointercancel', function () { down = false; measure(true); });
    size();
  })();

  /* Ticket print button */
  var printBtn = document.getElementById('printBtn');
  if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
})();
