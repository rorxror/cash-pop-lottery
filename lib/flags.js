'use strict';
/* Device/IP duplicate detection (v14): FLAGS only, never auto-bans.
   A shared device/IP across accounts is a review signal (households, agents,
   VPNs share IPs legitimately), so the system records an account_flags row +
   audit entry and leaves the decision to a human. Best-effort: a flagging
   failure must never block login or registration. */
const { now } = require('./util');

async function checkSharedDevice(db, userId, ip, ua) {
  try {
    if (!ip || !userId) return null;
    const uaSnippet = String(ua || '').slice(0, 255);
    // Other users with a session from the same IP + user agent in the last 30 days.
    const others = await db.query(
      'SELECT DISTINCT user_id FROM sessions WHERE user_id != ? AND user_id != 0 AND ip = ? AND user_agent = ? AND created_at > ?',
      [userId, ip, uaSnippet, now() - 30 * 86400000]);
    if (!others.length) return null;
    const otherId = others[0].user_id;
    // Dedup: one open flag per (user, other user) per 7 days.
    const dup = await db.get(
      "SELECT id FROM account_flags WHERE user_id = ? AND flag_type = 'shared_device' AND reviewed_at IS NULL AND created_at > ? AND LOWER(detail) LIKE LOWER(?)",
      [userId, now() - 7 * 86400000, '%"other_user_id":' + otherId + '%']);
    if (dup) return null;
    const detail = JSON.stringify({ ip, ua: uaSnippet.slice(0, 120), other_user_id: otherId });
    const r = await db.run('INSERT INTO account_flags (user_id, flag_type, detail, created_at) VALUES (?, ?, ?, ?)',
      [userId, 'shared_device', detail, now()]);
    const audit = require('./audit');
    await audit.log(db, { actorId: null, actorRole: 'system', action: 'fraud.flag', entity: 'user', entityId: userId, detail: { flag: 'shared_device', other_user_id: otherId, ip }, ip: ip || '' });
    return r.id;
  } catch (e) { console.error('flag check failed:', e.message); return null; }
}

module.exports = { checkSharedDevice };
