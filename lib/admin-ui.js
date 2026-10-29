'use strict';
/* Programmatic admin panel renderer. All admin pages share one layout and a
   small set of builders (table, form, badges, KPIs) so styling stays
   consistent — no ad-hoc markup per page. */
const { esc } = require('./util');

function badge(text, kind = 'muted') {
  const map = { ok: 'b-ok', err: 'b-err', warn: 'b-warn', info: 'b-info', muted: 'b-muted' };
  return `<span class="badge ${map[kind] || 'b-muted'}">${esc(text)}</span>`;
}
function statusBadge(s) {
  const m = {
    active: 'ok', approved: 'ok', settled: 'ok', won: 'ok', sent: 'ok', ok: 'ok', verified: 'ok', published: 'ok',
    pending: 'warn', open: 'warn', scheduled: 'info', answered: 'info',
    banned: 'err', rejected: 'err', revoked: 'err', closed: 'muted', lost: 'muted', failed: 'err', error: 'err', expired: 'muted',
  };
  return badge(s, m[String(s)] || 'muted');
}

function table(headers, rows, opts = {}) {
  const h = headers.map(x => `<th>${esc(x)}</th>`).join('');
  const b = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl-wrap"><table class="tbl${opts.cls ? ' ' + opts.cls : ''}"><thead><tr>${h}</tr></thead><tbody>${b || `<tr><td colspan="${headers.length}" class="muted">No records.</td></tr>`}</tbody></table></div>`;
}

function fieldHtml(f, values = {}) {
  const v = values[f.key] !== undefined ? values[f.key] : (f.value || '');
  const req = f.required ? 'required' : '';
  /* SCAN fix (D-13): labels are programmatically associated (for/id) —
     they were visual-only across every generated admin form. */
  const fid = 'f_' + String(f.key || 'x').replace(/[^A-Za-z0-9_-]/g, '_');
  let input = '';
  if (f.type === 'textarea') input = `<textarea id="${fid}" name="${esc(f.key)}" rows="4" ${req}>${esc(v)}</textarea>`;
  else if (f.type === 'select') input = `<select id="${fid}" name="${esc(f.key)}" ${req}>${(f.options || []).map(o => { const ov = (o && typeof o === 'object') ? o.v : o; const ol = (o && typeof o === 'object') ? o.l : o; return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
  else if (f.type === 'checkbox') input = `<label class="check"><input type="checkbox" name="${esc(f.key)}" value="1" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
  else input = `<input id="${fid}" type="${esc(f.type || 'text')}" name="${esc(f.key)}" value="${esc(v)}" ${req}${f.hint ? ` placeholder="${esc(f.hint)}"` : ''}>`;
  if (f.type === 'checkbox') return `<div class="field">${input}${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</div>`;
  return `<div class="field"><label for="${fid}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</div>`;
}

function formHtml(action, fields, { values = {}, submit = 'Save', method = 'POST', csrf = '', extra = '', grid = true } = {}) {
  return `<form method="${method}" action="${action}" class="adm-form">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <div class="${grid ? 'form-grid' : ''}">${fields.map(f => fieldHtml(f, values)).join('')}</div>
    ${extra}
    <div class="mt"><button class="btn btn-p" type="submit">${esc(submit)}</button></div>
  </form>`;
}

function kpis(items) {
  return `<div class="kpis">${items.map(i => {
    const inner = `<div class="n">${i.n}</div><div class="l">${esc(i.l)}</div>`;
    return i.href ? `<a class="kpi kpi-link" href="${esc(i.href)}">${inner}</a>` : `<div class="kpi">${inner}</div>`;
  }).join('')}</div>`;
}

function filtersHtml(action, fields, values = {}, csrf = '') {
  return `<form method="GET" action="${action}" class="filters">${fields.map(f => {
    /* SCAN fix (C-14): hidden fields let a filter form preserve the
       page's other active filters (tab/agent) across a search submit. */
    if (f.type === 'hidden') return `<input type="hidden" name="${esc(f.key)}" value="${esc(values[f.key] || '')}">`;
    if (f.type === 'select') return `<select name="${esc(f.key)}" aria-label="${esc(f.label)}"><option value="">${esc(f.label)}: all</option>${(f.options || []).map(o => `<option value="${esc(o)}" ${String(values[f.key]) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    const t = f.type === 'date' ? 'date' : 'text';
    return `<input type="${t}" name="${esc(f.key)}" value="${esc(values[f.key] || '')}" placeholder="${esc(f.label)}" aria-label="${esc(f.label)}">`;
  }).join('')}<button class="btn btn-sm" type="submit">Filter</button></form>`;
}

/* U-26: the sidebar is grouped by operator workflow (daily money and
   support high, system low) and filtered per staff role. `roles` lists
   the staff roles whose WORK lives on that page (its POST actions in
   lib/rbac.js, or a handler-level gate); an entry with no `roles` is
   shown to every staff role. Filtering is rendering only — rbac.js
   still governs what each role may actually do, and GET readability
   is unchanged. Super sees everything. */
const NAV_GROUPS = [
  ['Overview', [
    ['Dashboard', '', null],
    ['Reports', '/reports', null],
  ]],
  ['Money In & Out', [
    ['Deposits', '/deposits', ['finance']],
    ['Withdrawals', '/withdrawals', ['finance']],
    ['Payment Methods', '/methods', ['finance']],
    ['Approvals', '/approvals', ['finance', 'risk']],
    ['Reconciliation', '/reconciliation', ['finance']],
    ['Limits & Controls', '/limits', ['finance']],
  ]],
  ['Players & Agents', [
    ['Users', '/users', ['risk']],
    ['Agents', '/agents', ['finance']],
  ]],
  ['Games', [
    ['Draws', '/draws', ['risk']],
    ['Tickets', '/tickets', null],
    ['Scratch', '/scratch', ['finance']],
    ['Automation', '/automation', []],
  ]],
  ['Support', [
    ['Support Tickets', '/support', ['support']],
    ['Canned Replies', '/support/canned-replies', ['support']],
    ['Contact Messages', '/contact-messages', ['support']],
  ]],
  ['Bonuses & Growth', [
    ['Bonuses', '/bonuses', ['finance']],
    ['Referrals', '/referrals', null],
    ['Notifications', '/notifications', ['support']],
  ]],
  ['Security & Compliance', [
    ['KYC', '/kyc', ['finance']],
    ['Fraud Flags', '/flags', ['risk']],
    ['OTP Codes', '/otp', []],
    ['Login History', '/login-history', null],
    ['Staff', '/staff', []],
    ['Security', '/security', null],
    ['My Account', '/my-account', null],
    ['Audit Trail', '/audit', []],
  ]],
  ['Settings & System', [
    ['Settings', '/settings', []],
    ['Extensions', '/extensions', []],
    ['Pages & Content', '/pages', []],
    ['Cron Jobs', '/cron', []],
    ['Data — Import & Export', '/data', null],
  ]],
];
/* Flat list (label, path) in group order — kept for any consumer that
   only needs the destination set. */
const NAV = NAV_GROUPS.flatMap(([, items]) => items.map(([label, p]) => [label, p]));

function navHtml(adminPath, section, role) {
  const show = (roles) => {
    if (role === undefined || role === null || role === '' || role === 'super') return true;
    if (roles === null) return true;
    return roles.includes(role);
  };
  return NAV_GROUPS.map(([group, items]) => {
    const links = items.filter(([, , roles]) => show(roles)).map(([label, p]) => {
      const active = (p === '' && section === '') || (p && section === p);
      return `<a href="${adminPath}${p}" class="${active ? 'active' : ''}">${esc(label)}</a>`;
    }).join('');
    if (!links) return '';
    return `<div class="adm-group" style="margin:14px 12px 4px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.55">${esc(group)}</div>${links}`;
  }).join('');
}

function layout({ adminPath, section, title, body, csrf, flash = {}, assetV = '1', role, subtitle = '' }) {
  const nav = navHtml(adminPath, section, role);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>${esc(title)} — Admin</title><link rel="stylesheet" href="/style.css?v=${esc(assetV)}"><link rel="stylesheet" href="/admin.css?v=${esc(assetV)}"></head>
<body class="adm-body">
<div class="adm">
  <aside class="adm-side">
    <div class="adm-brand">🎰 Control Room</div>
    <nav>${nav}</nav>
    <div class="adm-side-foot">
      <a href="/" target="_blank">View site ↗</a>
      <form method="POST" action="${esc(adminPath)}/logout" style="margin-top:8px"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-g btn-sm" type="submit">Sign out</button></form>
    </div>
  </aside>
  <main class="adm-main">
    <div class="adm-top"><h1>${esc(title)}</h1>${subtitle ? `<p class="adm-sub">${esc(subtitle)}</p>` : ''}</div>
    ${flash.error ? `<div class="alert a-err">${esc(flash.error)}</div>` : ''}
    ${flash.success ? `<div class="alert a-ok">${esc(flash.success)}</div>` : ''}
    ${body}
  </main>
</div>
<script src="/app.js?v=${esc(assetV)}" defer></script>
</body></html>`;
}

function card(title, inner, actions = '', id = '') {
  return `<div class="card"${id ? ` id="${esc(id)}"` : ''}><div class="card-h"><h3>${esc(title)}</h3><div>${actions}</div></div><div class="card-b">${inner}</div></div>`;
}

function paginate(base, page, perPage, total) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return '';
  const q = (p) => `${base}${base.includes('?') ? '&' : '?'}page=${p}`;
  let h = '<div class="pagination">';
  if (page > 1) h += `<a class="btn btn-sm" href="${q(page - 1)}">← Prev</a>`;
  h += `<span class="muted">Page ${page} of ${pages}</span>`;
  if (page < pages) h += `<a class="btn btn-sm" href="${q(page + 1)}">Next →</a>`;
  return h + '</div>';
}

module.exports = { badge, statusBadge, table, fieldHtml, formHtml, kpis, filtersHtml, layout, card, paginate, NAV, NAV_GROUPS, navHtml };
