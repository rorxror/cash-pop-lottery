'use strict';
/* Audit trail — every admin/staff action is logged here. */
const { now } = require('./util');

async function log(db, { actorId = null, actorRole = '', action, entity = '', entityId = '', detail = {}, ip = '' }) {
  try {
    await db.run(
      'INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [actorId, actorRole, action, entity, String(entityId), JSON.stringify(detail), ip, now()]
    );
  } catch (e) { console.error('audit log failed:', e.message); }
}

module.exports = { log };
