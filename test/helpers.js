'use strict';
// Test harness. Runs against a REAL Postgres: set TEST_DATABASE_URL (database name must contain "test").
// The public schema is dropped and recreated by every test file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL (the database name must contain "test")');
if (!/test/i.test(new URL(url).pathname)) throw new Error('Refusing to run: TEST_DATABASE_URL database name must contain "test"');
process.env.DATABASE_URL = url;
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET || 't'.repeat(48);

const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const ledger = require('../src/ledger');

const PW = 'correct horse battery staple';
const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const uuid = () => crypto.randomUUID();

async function setup() {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(schema);

  const hash = await hashPassword(PW);
  const mk = async (email, role) =>
    ({ ...(await pool.query('INSERT INTO users(email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role', [email, hash, role])).rows[0] });
  const users = {
    admin: await mk('admin@t.test', 'admin'),
    alice: await mk('alice@t.test', 'holder'),
    bob: await mk('bob@t.test', 'holder'),
    auditor: await mk('auditor@t.test', 'auditor'),
  };

  const server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};

  async function call(who, method, p, body, key) {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = `Bearer ${tokens[who] || who}`;
    if (key) headers['Idempotency-Key'] = key;
    const res = await fetch(base + '/api' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data, headers: res.headers };
  }

  for (const [name, u] of Object.entries(users)) {
    const r = await call(null, 'POST', '/auth/login', { email: u.email, password: PW });
    if (r.status !== 200) throw new Error(`login failed for ${name}`);
    tokens[name] = r.data.token;
  }

  // Creates an account (members = user ids) and funds it via the real ledger (admin deposit).
  async function newAccount(name, members = [], fundPaise = 0) {
    const id = (await pool.query('INSERT INTO accounts(name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    for (const m of members) await pool.query('INSERT INTO account_members(account_id, user_id) VALUES ($1,$2)', [id, m]);
    if (fundPaise > 0) {
      await ledger.move({ actor: users.admin, kind: 'deposit', toId: id, amount: BigInt(fundPaise), key: `fund-${uuid()}`, requestId: 'test' });
    }
    return id;
  }
  const balance = async (id) => BigInt((await pool.query('SELECT balance FROM accounts WHERE id = $1', [id])).rows[0].balance);

  async function close() {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await pool.end();
  }
  return { users, tokens, call, newAccount, balance, pool, close, uuid };
}

module.exports = { setup, uuid };
