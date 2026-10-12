'use strict';
/* Tiny DB abstraction: SQLite (node:sqlite, built-in) by default, MySQL optional.
   Switching is config-only via DB_DRIVER env var. Uniform async interface:
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

function openDB() {
  const driver = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
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
  return { driver, db: new SqliteDB(process.env.SQLITE_PATH || './data/cashpop.sqlite') };
}

module.exports = { openDB };
