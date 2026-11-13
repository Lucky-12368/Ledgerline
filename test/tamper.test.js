'use strict';
// Runs last (alphabetical) and deliberately corrupts the ledger as the DB owner would be able to,
// to prove the hash chain + reconciliation notice. Uses its own freshly reset database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uuid } = require('./helpers');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('reconciliation is clean on an untouched ledger', async () => {
  const a = await t.newAccount('tamper-a', [t.users.alice.id], 10000);
  const b = await t.newAccount('tamper-b', [t.users.bob.id], 0);
  await t.call('alice', 'POST', '/transfers', { fromAccountId: a, toAccountId: b, amount: '1234' }, uuid());
  const r = await t.call('auditor', 'GET', '/reconciliation');
  assert.equal(r.data.ok, true, JSON.stringify(r.data.problems));
});

test('an edit made behind the application\'s back (triggers disabled) is detected', async () => {
  await t.pool.query('ALTER TABLE entries DISABLE TRIGGER entries_no_update');
  try {
    await t.pool.query('UPDATE entries SET amount = amount + 1 WHERE id = (SELECT max(id) FROM entries)');
  } finally {
    await t.pool.query('ALTER TABLE entries ENABLE TRIGGER entries_no_update');
  }
  const r = await t.call('auditor', 'GET', '/reconciliation');
  assert.equal(r.data.ok, false);
  assert.ok(r.data.problems.length > 0);
});
