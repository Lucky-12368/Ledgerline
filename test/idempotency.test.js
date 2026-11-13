'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uuid } = require('./helpers');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('a replayed request moves money once and returns the first result', async () => {
  const a = await t.newAccount('idem-a', [t.users.alice.id], 10000);
  const b = await t.newAccount('idem-b', [t.users.bob.id], 0);
  const key = uuid();
  const body = { fromAccountId: a, toAccountId: b, amount: '2500' };
  const r1 = await t.call('alice', 'POST', '/transfers', body, key);
  const r2 = await t.call('alice', 'POST', '/transfers', body, key);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r2.data.transaction.id, r1.data.transaction.id);
  assert.equal(r2.headers.get('idempotent-replay'), 'true');
  assert.equal(r1.headers.get('idempotent-replay'), null);
  assert.equal(await t.balance(a), 7500n);
  assert.equal(await t.balance(b), 2500n);
  const hits = await t.pool.query('SELECT * FROM idempotency_hits WHERE transaction_id = $1', [r1.data.transaction.id]);
  assert.equal(hits.rowCount, 1, 'the duplicate must be visible in the data');
});

test('the same key fired concurrently still moves money once', async () => {
  const a = await t.newAccount('idem-conc-a', [t.users.alice.id], 10000);
  const b = await t.newAccount('idem-conc-b', [t.users.bob.id], 0);
  const key = uuid();
  const rs = await Promise.all(Array.from({ length: 10 }, () =>
    t.call('alice', 'POST', '/transfers', { fromAccountId: a, toAccountId: b, amount: '1000' }, key)));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(new Set(rs.map((r) => r.data.transaction.id)).size, 1);
  assert.equal(await t.balance(a), 9000n);
  assert.equal(await t.balance(b), 1000n);
  const n = await t.pool.query('SELECT count(*)::int AS n FROM transactions WHERE idempotency_key = $1', [key]);
  assert.equal(n.rows[0].n, 1);
  const hits = await t.pool.query('SELECT count(*)::int AS n FROM idempotency_hits WHERE transaction_id = $1', [rs[0].data.transaction.id]);
  assert.equal(hits.rows[0].n, 9);
});

test('reusing a key with a different request is rejected and moves nothing', async () => {
  const a = await t.newAccount('idem-reuse', [t.users.alice.id], 10000);
  const key = uuid();
  assert.equal((await t.call('alice', 'POST', '/withdrawals', { accountId: a, amount: '100' }, key)).status, 201);
  const r = await t.call('alice', 'POST', '/withdrawals', { accountId: a, amount: '200' }, key);
  assert.equal(r.status, 422);
  assert.equal(r.data.error.code, 'idempotency_key_reuse');
  assert.equal(await t.balance(a), 9900n);
});

test('a refused request replays as the same refusal and is not re-evaluated', async () => {
  const a = await t.newAccount('idem-refused', [t.users.alice.id], 100);
  const key = uuid();
  const r1 = await t.call('alice', 'POST', '/withdrawals', { accountId: a, amount: '500' }, key);
  await t.call('admin', 'POST', '/deposits', { accountId: a, amount: '100000' }, uuid()); // now it would succeed
  const r2 = await t.call('alice', 'POST', '/withdrawals', { accountId: a, amount: '500' }, key);
  assert.equal(r1.status, 422);
  assert.equal(r2.status, 422);
  assert.equal(r2.data.transaction.id, r1.data.transaction.id);
  assert.equal(await t.balance(a), 100100n);
});

test('idempotency keys are scoped per user: one user cannot replay or collide with another', async () => {
  const a = await t.newAccount('idem-scope-a', [t.users.alice.id], 1000);
  const b = await t.newAccount('idem-scope-b', [t.users.bob.id], 1000);
  const key = uuid();
  const r1 = await t.call('alice', 'POST', '/withdrawals', { accountId: a, amount: '100' }, key);
  const r2 = await t.call('bob', 'POST', '/withdrawals', { accountId: b, amount: '100' }, key);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.notEqual(r1.data.transaction.id, r2.data.transaction.id);
});

test('the Idempotency-Key header is mandatory and validated', async () => {
  const a = await t.newAccount('idem-missing', [t.users.alice.id], 1000);
  for (const key of [undefined, 'short', 'has spaces in it!!', 'x'.repeat(200)]) {
    const r = await t.call('alice', 'POST', '/withdrawals', { accountId: a, amount: '100' }, key);
    assert.equal(r.status, 400);
  }
  assert.equal(await t.balance(a), 1000n);
});
