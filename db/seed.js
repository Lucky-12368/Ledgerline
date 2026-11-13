'use strict';
// Demo data, created through the ledger itself so the books balance from the first rupee. Idempotent.
const crypto = require('crypto');
const { pool } = require('../src/db');
const { hashPassword } = require('../src/auth');
const ledger = require('../src/ledger');

const PASSWORD = process.env.SEED_PASSWORD || 'LedgerLine#2026';

(async () => {
  if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) { console.log('Users exist; skipping seed.'); return; }
  const hash = await hashPassword(PASSWORD);
  const mk = async (email, role) =>
    (await pool.query('INSERT INTO users(email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role', [email, hash, role])).rows[0];
  const admin = await mk('admin@ledgerline.test', 'admin');
  const alice = await mk('alice@ledgerline.test', 'holder');
  const bob = await mk('bob@ledgerline.test', 'holder');
  await mk('auditor@ledgerline.test', 'auditor');

  const acct = async (name, owner, rupees) => {
    const a = (await pool.query('INSERT INTO accounts(name) VALUES ($1) RETURNING id', [name])).rows[0];
    await pool.query('INSERT INTO account_members(account_id, user_id) VALUES ($1,$2)', [a.id, owner.id]);
    await ledger.move({ actor: admin, kind: 'deposit', toId: a.id, amount: BigInt(rupees) * 100n, key: `seed-${crypto.randomUUID()}`, requestId: 'seed' });
    return a.id;
  };
  await acct('Alice Current', alice, 50000);
  await acct('Alice Savings', alice, 120000);
  await acct('Bob Current', bob, 25000);
  console.log('Seeded: admin@, alice@, bob@, auditor@ledgerline.test');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
