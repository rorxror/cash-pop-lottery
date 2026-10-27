'use strict';
/* Tiny DB abstraction: SQLite (node:sqlite, built-in) by default, MySQL or
   Postgres optional. Switching is config-only via DB_DRIVER env var
   (sqlite | mysql | postgres; DATABASE_URL alone implies postgres).
   Postgres SQL is translated from the app's `?` placeholders to $1, $2, ...
   inside the adapter, so routes and lib code never change. Uniform async interface:
   query(sql, params) -> rows[], get(sql, params) -> row|undefined,
   run(sql, params) -> { id, changes }, transaction(fn) -> fn(tx), execScript(sql). */
const fs = require('node:fs');
const path = require('node:path');

class SqliteDB {
  constructor(filePath) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }
  async query(sql, params = []) { return this.db.prepare(sql).all(...params); }
  async get(sql, params = []) { return this.db.prepare(sql).get(...params); }
  async run(sql, params = []) {
    const r = this.db.prepare(sql).run(...params);
    return { id: Number(r.lastInsertRowid), changes: r.changes };
  }
  async transaction(fn) {
    const tx = {
      query: (s, p = []) => Promise.resolve(this.db.prepare(s).all(...p)),
      get: (s, p = []) => Promise.resolve(this.db.prepare(s).get(...p)),
      run: (s, p = []) => { const r = this.db.prepare(s).run(...p); return Promise.resolve({ id: Number(r.lastInsertRowid), changes: r.changes }); },
    };
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = await fn(tx); this.db.exec('COMMIT'); return out; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  async execScript(sql) { this.db.exec(sql); }
  close() { this.db.close(); }
}

class MysqlDB {
  constructor(cfg) {
    let mysql2;
    try { mysql2 = require('mysql2/promise'); }
    catch { throw new Error('DB_DRIVER=mysql but the mysql2 package is not installed. Run: npm install mysql2'); }
    this.pool = mysql2.createPool({
      host: cfg.host, port: cfg.port || 3306, user: cfg.user,
      password: cfg.password, database: cfg.database,
      waitForConnections: true, connectionLimit: 8, multipleStatements: false,
    });
  }
  async query(sql, params = []) { const [rows] = await this.pool.execute(sql, params); return rows; }
  async get(sql, params = []) { const [rows] = await this.pool.execute(sql, params); return rows[0]; }
  async run(sql, params = []) {
    const [r] = await this.pool.execute(sql, params);
    return { id: Number(r.insertId || 0), changes: r.affectedRows || 0 };
  }
  async transaction(fn) {
    const conn = await this.pool.getConnection();
    const tx = {
      query: async (s, p = []) => { const [rows] = await conn.execute(s, p); return rows; },
      get: async (s, p = []) => { const [rows] = await conn.execute(s, p); return rows[0]; },
      run: async (s, p = []) => { const [r] = await conn.execute(s, p); return { id: Number(r.insertId || 0), changes: r.affectedRows || 0 }; },
    };
    await conn.beginTransaction();
    try { const out = await fn(tx); await conn.commit(); conn.release(); return out; }
    catch (e) { try { await conn.rollback(); } catch {} conn.release(); throw e; }
  }
  async execScript(sql) {
    // Run statements one at a time (no multipleStatements).
    const conn = await this.pool.getConnection();
    try {
      for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
        await conn.query(stmt);
      }
    } finally { conn.release(); }
  }
  close() { return this.pool.end(); }
}

/* Postgres placeholder translation: app SQL uses `?` everywhere (SQLite /
   MySQL style); Postgres wants $1, $2, ... — translated here so NO route or
   lib query has to change. The scanner skips `?` inside string literals,
   quoted identifiers and comments, so a literal '?' in SQL text survives. */
function translatePg(sql) {
  let out = '', n = 0, i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") { // single-quoted literal, '' escapes
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j += 1;
      }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '"') { // quoted identifier, "" escapes
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue; } break; }
        j += 1;
      }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '-' && sql[i + 1] === '-') { // -- line comment
      let j = sql.indexOf('\n', i); if (j === -1) j = sql.length;
      out += sql.slice(i, j); i = j; continue;
    }
    if (c === '/' && sql[i + 1] === '*') { // /* block comment */
      let j = sql.indexOf('*/', i + 2); if (j === -1) j = sql.length - 2;
      out += sql.slice(i, j + 2); i = j + 2; continue;
    }
    if (c === '?') { n += 1; out += '$' + n; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

class PostgresDB {
  constructor(cfg) {
    let pg;
    try { pg = require('pg'); }
    catch { throw new Error('DB_DRIVER=postgres but the pg package is not installed. Run: npm install pg'); }
    // BIGINT (int8) arrives as a string from node-pg by default; SQLite and
    // MySQL return real numbers, and the app does arithmetic/comparisons on
    // COUNT(*)/SUM(...) results — parse int8 as a JS number so all three
    // drivers behave identically (amounts here are far below 2^53).
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    const ssl = cfg.sslMode === 'disable' ? false
      : (cfg.sslMode === 'require' || cfg.sslRequired) ? { rejectUnauthorized: false } : false;
    // Only pass keys that are actually set: an explicit `undefined` must never
    // shadow a value parsed from DATABASE_URL.
    const poolCfg = { ssl, max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 };
    for (const k of ['connectionString', 'host', 'port', 'user', 'password', 'database']) {
      if (cfg[k] !== undefined && cfg[k] !== '') poolCfg[k] = cfg[k];
    }
    this.pool = new pg.Pool(poolCfg);
    this.pool.on('error', (e) => { console.error('[pg pool error]', e); });
  }
  _params(params) { return (params || []).map((p) => (p === undefined ? null : p)); }
  async query(sql, params = []) {
    const r = await this.pool.query(translatePg(sql), this._params(params));
    return r.rows;
  }
  async get(sql, params = []) {
    const r = await this.pool.query(translatePg(sql), this._params(params));
    return r.rows[0];
  }
  async run(sql, params = []) {
    // run() must return { id, changes } like the other drivers. Postgres has
    // no lastInsertRowid, so plain INSERTs get `RETURNING *` appended (a
    // no-op when the statement already has RETURNING, or for UPDATE/DELETE,
    // where rowCount is the changes count). RETURNING * — not RETURNING id —
    // because several tables have no `id` column at all (settings, wallets,
    // migrations_applied, ...): with RETURNING id those inserts would fail
    // with "column id does not exist". Callers read .id only when present.
    let q = sql;
    if (/^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)) q = sql + ' RETURNING *';
    const r = await this.pool.query(translatePg(q), this._params(params));
    return { id: r.rows && r.rows[0] && r.rows[0].id !== undefined ? Number(r.rows[0].id) : 0, changes: r.rowCount || 0 };
  }
  async transaction(fn) {
    const client = await this.pool.connect();
    const tx = {
      query: async (s, p = []) => { const r = await client.query(translatePg(s), this._params(p)); return r.rows; },
      get: async (s, p = []) => { const r = await client.query(translatePg(s), this._params(p)); return r.rows[0]; },
      run: async (s, p = []) => {
        let q = s;
        if (/^\s*INSERT\b/i.test(s) && !/\bRETURNING\b/i.test(s)) q = s + ' RETURNING *';
        const r = await client.query(translatePg(q), this._params(p));
        return { id: r.rows && r.rows[0] && r.rows[0].id !== undefined ? Number(r.rows[0].id) : 0, changes: r.rowCount || 0 };
      },
    };
    await client.query('BEGIN');
    try { const out = await fn(tx); await client.query('COMMIT'); return out; }
    catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
    finally { client.release(); }
  }
  async execScript(sql) {
    // Run statements one at a time (same rule as the MySQL path).
    const client = await this.pool.connect();
    try {
      for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
        await client.query(translatePg(stmt));
      }
    } finally { client.release(); }
  }
  close() { return this.pool.end(); }
}

function openDB() {
  const envDriver = (process.env.DB_DRIVER || '').toLowerCase();
  // Render convention: DATABASE_URL present + no explicit driver = postgres.
  const driver = envDriver || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
  if (driver === 'mysql') {
    return {
      driver,
      db: new MysqlDB({
        host: process.env.MYSQL_HOST || 'localhost',
        port: process.env.MYSQL_PORT, user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
      }),
    };
  }
  if (driver === 'postgres') {
    // SSL: Render Postgres requires it. Localhost demo DBs do not use it.
    // PGSSLMODE=require forces it; otherwise any non-localhost DATABASE_URL
    // host gets it (self-signed Render certs => rejectUnauthorized: false).
    let sslRequired = false;
    try {
      if (process.env.DATABASE_URL) {
        const u = new URL(process.env.DATABASE_URL);
        if (u.hostname && !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) sslRequired = true;
      }
    } catch {}
    const pgCfg = { sslMode: process.env.PGSSLMODE || '', sslRequired };
    if (process.env.DATABASE_URL) pgCfg.connectionString = process.env.DATABASE_URL;
    if (process.env.PGHOST) pgCfg.host = process.env.PGHOST;
    if (process.env.PGPORT) pgCfg.port = parseInt(process.env.PGPORT, 10);
    if (process.env.PGUSER) pgCfg.user = process.env.PGUSER;
    if (process.env.PGPASSWORD) pgCfg.password = process.env.PGPASSWORD;
    if (process.env.PGDATABASE) pgCfg.database = process.env.PGDATABASE;
    return { driver, db: new PostgresDB(pgCfg) };
  }
  return { driver, db: new SqliteDB(process.env.SQLITE_PATH || './data/cashpop.sqlite') };
}

module.exports = { openDB, translatePg };
