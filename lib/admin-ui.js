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
  let input = '';
  if (f.type === 'textarea') input = `<textarea name="${esc(f.key)}" rows="4" ${req}>${esc(v)}</textarea>`;
  else if (f.type === 'select') input = `<select name="${esc(f.key)}" ${req}>${(f.options || []).map(o => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  else if (f.type === 'checkbox') input = `<label class="check"><input type="checkbox" name="${esc(f.key)}" value="1" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
  else input = `<input type="${esc(f.type || 'text')}" name="${esc(f.key)}" value="${esc(v)}" ${req}${f.hint ? ` placeholder="${esc(f.hint)}"` : ''}>`;
  if (f.type === 'checkbox') return `<div class="field">${input}${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</div>`;
  return `<div class="field"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</div>`;
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
  return `<div class="kpis">${items.map(i => `<div class="kpi"><div class="n">${i.n}</div><div class="l">${esc(i.l)}</div></div>`).join('')}</div>`;
}

function filtersHtml(action, fields, values = {}, csrf = '') {
  return `<form method="GET" action="${action}" class="filters">${fields.map(f => {
    if (f.type === 'select') return `<select name="${esc(f.key)}"><option value="">${esc(f.label)}: all</option>${(f.options || []).map(o => `<option value="${esc(o)}" ${String(values[f.key]) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    const t = f.type === 'date' ? 'date' : 'text';
    return `<input type="${t}" name="${esc(f.key)}" value="${esc(values[f.key] || '')}" placeholder="${esc(f.label)}">`;
  }).join('')}<button class="btn btn-sm" type="submit">Filter</button></form>`;
}

const NAV = [
  ['Dashboard', ''],
  ['Draws', '/draws'],
  ['Tickets', '/tickets'],
  ['Users', '/users'],
  ['OTP Codes', '/otp'],
  ['Agents', '/agents'],
  ['Deposits', '/deposits'],
  ['Withdrawals', '/withdrawals'],
  ['Payment Methods', '/methods'],
  ['Reports', '/reports'],
  ['Support', '/support'],
  ['Extensions', '/extensions'],
  ['Notifications', '/notifications'],
  ['Pages & Content', '/pages'],
  ['Cron Jobs', '/cron'],
  ['Settings', '/settings'],
  ['Audit Trail', '/audit'],
];

function layout({ adminPath, section, title, body, csrf, flash = {}, assetV = '1' }) {
  const nav = NAV.map(([label, p]) => {
    const active = (p === '' && section === '') || (p && section === p);
    return `<a href="${adminPath}${p}" class="${active ? 'active' : ''}">${esc(label)}</a>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Admin</title><link rel="stylesheet" href="/style.css?v=${esc(assetV)}"></head>
<body class="adm-body">
<div class="adm">
  <aside class="adm-side">
    <div class="adm-brand">🎰 Control Room</div>
    <nav>${nav}</nav>
    <div class="adm-side-foot">
      <a href="/" target="_blank">View site ↗</a>
      <form method="POST" action="/logout" style="margin-top:8px"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-g btn-sm" type="submit">Sign out</button></form>
    </div>
  </aside>
  <main class="adm-main">
    <div class="adm-top"><h1>${esc(title)}</h1></div>
    ${flash.error ? `<div class="alert a-err">${esc(flash.error)}</div>` : ''}
    ${flash.success ? `<div class="alert a-ok">${esc(flash.success)}</div>` : ''}
    ${body}
  </main>
</div>
<script src="/app.js?v=${esc(assetV)}" defer></script>
</body></html>`;
}

function card(title, inner, actions = '') {
  return `<div class="card"><div class="card-h"><h3>${esc(title)}</h3><div>${actions}</div></div><div class="card-b">${inner}</div></div>`;
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

module.exports = { badge, statusBadge, table, fieldHtml, formHtml, kpis, filtersHtml, layout, card, paginate, NAV };
