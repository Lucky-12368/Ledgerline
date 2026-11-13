'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('ledger tables reject UPDATE, DELETE and TRUNCATE (append-only)', async () => {
  const acct = await t.newAccount('immutable', [t.users.alice.id], 1000);
  await t.call('alice', 'GET', `/accounts/${acct}`); // also writes nothing; ensures rows exist from funding
  for (const sql of [
    'UPDATE entries SET amount = amount + 1',
    'DELETE FROM entries',
    'TRUNCATE entries CASCADE',
    "UPDATE transactions SET status = 'refused'",
    'DELETE FROM transactions',
    'TRUNCATE transactions CASCADE',
    "UPDATE audit_log SET action = 'x'",
    'DELETE FROM idempotency_hits',
  ]) {
    if (sql.includes('audit_log')) await t.call('alice', 'POST', '/auth/login', { email: 'nobody@t.test', password: 'x' });
    await assert.rejects(t.pool.query(sql), /append-only/, sql);
  }
});

test('the database itself refuses a negative balance', async () => {
  const acct = await t.newAccount('floor', [t.users.alice.id], 100);
  await assert.rejects(t.pool.query('UPDATE accounts SET balance = -1 WHERE id = $1', [acct]), /no_overdraft/);
});

test('a half-written posting (one leg only) cannot commit', async () => {
  const acct = await t.newAccount('halfpost', [t.users.alice.id], 0);
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    const tx = await c.query(
      `INSERT INTO transactions(kind, status, amount, to_account, initiated_by, idempotency_key, request_hash, request_id)
       VALUES ('deposit','posted',100,$1,$2,'half-post-key-1','h','r') RETURNING id`, [acct, t.users.admin.id]);
    await c.query(
      `INSERT INTO entries(transaction_id, account_id, amount, balance_after, seq, row_hash) VALUES ($1,$2,100,100,1,'x')`,
      [tx.rows[0].id, acct]);
    await assert.rejects(c.query('COMMIT'), /exactly 2 legs/);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
});

test('the idempotency unique constraint holds even if the application is bypassed', async () => {
  const acct = await t.newAccount('uniq', [t.users.alice.id], 0);
  const ins = () => t.pool.query(
    `INSERT INTO transactions(kind, status, refusal_reason, amount, from_account, initiated_by, idempotency_key, request_hash, request_id)
     VALUES ('withdrawal','refused','x',1,$1,$2,'dup-key-123456','h','r')`, [acct, t.users.alice.id]);
  await ins();
  await assert.rejects(ins(), /uq_txn_idem/);
});
