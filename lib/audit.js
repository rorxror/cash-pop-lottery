'use strict';
/* Audit trail — every admin/staff action is logged here.
   v14: hash-chained. Each row carries prev_hash (the previous row's hash)
   and hash = sha256(prev_hash | action | entity | entity_id | detail |
   created_at | actor). Any edit, deletion, or reordering of history breaks
   the chain, so tampering is detectable by verifying forward from genesis.
   Pre-v14 rows have empty hashes; verification starts at the first chained
   row. Inserts are serialized through an in-process mutex so concurrent
   requests cannot fork the chain (single-instance deployments; a
   multi-instance deployment would need a DB-side sequence — noted in the
   threat model). */
const { now, sha256 } = require('./util');

let chain = Promise.resolve();

async function log(db, { actorId = null, actorRole = '', action, entity = '', entityId = '', detail = {}, ip = '' }) {
  const job = chain.then(async () => {
    try {
      const created = now();
      const detailStr = JSON.stringify(detail);
      const last = await db.get("SELECT hash FROM audit_log WHERE hash IS NOT NULL AND hash != '' ORDER BY id DESC LIMIT 1").catch(() => null);
      const prev = (last && last.hash) || 'GENESIS';
      const hash = sha256([prev, action, entity, String(entityId), detailStr, String(created), String(actorId || '')].join('|'));
      await db.run(
        'INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, detail, ip, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [actorId, actorRole, action, entity, String(entityId), detailStr, ip, created, prev, hash]
      );
    } catch (e) { console.error('audit log failed:', e.message); }
  });
  chain = job.catch(() => {});
  return job;
}

/* Verify the chain forward. Returns { ok, checked, firstBadId, reason }. */
async function verifyChain(db) {
  const rows = await db.query("SELECT id, prev_hash, hash, action, entity, entity_id, detail, created_at, actor_id FROM audit_log WHERE hash IS NOT NULL AND hash != '' ORDER BY id ASC");
  let prev = null, checked = 0;
  for (const r of rows) {
    if (prev !== null && r.prev_hash !== prev) return { ok: false, checked, firstBadId: r.id, reason: 'prev_hash mismatch' };
    const expect = sha256([r.prev_hash, r.action, r.entity, String(r.entity_id), String(r.detail), String(r.created_at), String(r.actor_id || '')].join('|'));
    if (expect !== r.hash) return { ok: false, checked, firstBadId: r.id, reason: 'hash mismatch' };
    prev = r.hash; checked++;
  }
  return { ok: true, checked, firstBadId: null, reason: '' };
}

module.exports = { log, verifyChain };
