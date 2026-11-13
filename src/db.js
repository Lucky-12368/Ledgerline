'use strict';
const { Pool } = require('pg');
const cfg = require('./config');

const pool = new Pool({ connectionString: cfg.databaseUrl, max: 20, ssl: cfg.ssl });
pool.on('error', (e) => console.error('pg pool error:', e.message));

/**
 * Run fn inside one transaction (READ COMMITTED; correctness comes from explicit row locks, see ledger.js).
 * Deadlocks / serialization failures are retried: every money-moving call carries an idempotency key,
 * so a retry can never move money twice.
 */
async function withTx(fn) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if ((e.code === '40001' || e.code === '40P01') && attempt < 3) continue;
      throw e;
    } finally {
      client.release(broken);
    }
  }
}

module.exports = { pool, withTx };
