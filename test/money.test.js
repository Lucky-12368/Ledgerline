'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uuid } = require('./helpers');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('concurrent withdrawals never overdraw the account', async () => {
  const acct = await t.newAccount('race-withdraw', [t.users.alice.id], 10000);
  const rs = await Promise.all(Array.from({ length: 20 }, () =>
    t.call('alice', 'POST', '/withdrawals', { accountId: acct, amount: '3000' }, uuid())));
  assert.equal(rs.filter((r) => r.status === 201).length, 3);
  assert.equal(rs.filter((r) => r.status === 422).length, 17);
  assert.equal(rs.filter((r) => r.status >= 500).length, 0);
  assert.equal(await t.balance(acct), 1000n);
  const st = await t.call('alice', 'GET', `/accounts/${acct}/statement?limit=200`);
  assert.equal(st.data.entries.filter((e) => e.status === 'refused').length, 17);
});

test('concurrent transfers cannot spend the same money twice', async () => {
  const a = await t.newAccount('race-a', [t.users.alice.id], 10000);
  const b = await t.newAccount('race-b', [t.users.bob.id], 0);
  const c = await t.newAccount('race-c', [t.users.bob.id], 0);
  const rs = await Promise.all([
    t.call('alice', 'POST', '/transfers', { fromAccountId: a, toAccountId: b, amount: '10000' }, uuid()),
    t.call('alice', 'POST', '/transfers', { fromAccountId: a, toAccountId: c, amount: '10000' }, uuid()),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 422]);
  assert.equal(await t.balance(a), 0n);
  assert.equal((await t.balance(b)) + (await t.balance(c)), 10000n);
});

test('opposite-direction transfers do not deadlock and conserve money', async () => {
  const a = await t.newAccount('dl-a', [t.users.alice.id], 100000);
  const b = await t.newAccount('dl-b', [t.users.bob.id], 100000);
  const calls = [];
  for (let i = 0; i < 20; i++) {
    calls.push(t.call('alice', 'POST', '/transfers', { fromAccountId: a, toAccountId: b, amount: '100' }, uuid()));
    calls.push(t.call('bob', 'POST', '/transfers', { fromAccountId: b, toAccountId: a, amount: '70' }, uuid()));
  }
  const rs = await Promise.all(calls);
  assert.ok(rs.every((r) => r.status === 201), 'all transfers should post');
  assert.equal((await t.balance(a)) + (await t.balance(b)), 200000n);
  assert.equal(await t.balance(a), 100000n - 20n * 100n + 20n * 70n);
});

test('money is conserved across a random mixed workload (ledger sums to zero, cache equals ledger)', async () => {
  const accts = {
    alice: [await t.newAccount('mix-a1', [t.users.alice.id], 50000), await t.newAccount('mix-a2', [t.users.alice.id], 50000)],
    bob: [await t.newAccount('mix-b1', [t.users.bob.id], 50000), await t.newAccount('mix-b2', [t.users.bob.id], 50000)],
  };
  const all = [...accts.alice, ...accts.bob];
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  const calls = [];
  for (let i = 0; i < 80; i++) {
    const who = pick(['alice', 'bob']);
    const mine = accts[who];
    const amount = String(1 + Math.floor(Math.random() * 30000)); // some will be refused
    const op = pick(['deposit', 'withdrawal', 'transfer', 'transfer']);
    if (op === 'deposit') calls.push(t.call(who, 'POST', '/deposits', { accountId: pick(mine), amount }, uuid()));
    else if (op === 'withdrawal') calls.push(t.call(who, 'POST', '/withdrawals', { accountId: pick(mine), amount }, uuid()));
    else {
      const from = pick(mine); let to = pick(all); if (to === from) to = pick(all.filter((x) => x !== from));
      calls.push(t.call(who, 'POST', '/transfers', { fromAccountId: from, toAccountId: to, amount }, uuid()));
    }
  }
  const rs = await Promise.all(calls);
  assert.equal(rs.filter((r) => r.status >= 500).length, 0);
  assert.equal(rs.filter((r) => ![201, 422].includes(r.status)).length, 0);

  const sum = (await t.pool.query('SELECT COALESCE(SUM(amount),0) AS s FROM entries')).rows[0].s;
  assert.equal(BigInt(sum), 0n, 'ledger must sum to zero');
  const drift = await t.pool.query(`SELECT a.id FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
                                    GROUP BY a.id HAVING a.balance <> COALESCE(SUM(e.amount),0)`);
  assert.equal(drift.rowCount, 0, 'cached balance must equal sum of entries');
  const rec = await t.call('auditor', 'GET', '/reconciliation');
  assert.equal(rec.status, 200);
  assert.equal(rec.data.ok, true, JSON.stringify(rec.data.problems));
});

test('invalid amounts are rejected and move nothing', async () => {
  const acct = await t.newAccount('amounts', [t.users.alice.id], 5000);
  for (const amount of ['1.5', '-5', '0', '1e3', 'abc', null, 12.5, '99999999999999999999', '', ' 5']) {
    const r = await t.call('alice', 'POST', '/withdrawals', { accountId: acct, amount }, uuid());
    assert.equal(r.status, 400, `amount ${JSON.stringify(amount)} should be 400`);
  }
  assert.equal(await t.balance(acct), 5000n);
});

test('frozen accounts refuse movements, and the refusal is recorded', async () => {
  const acct = await t.newAccount('frozen', [t.users.alice.id], 5000);
  assert.equal((await t.call('admin', 'POST', `/accounts/${acct}/freeze`)).status, 200);
  const r = await t.call('alice', 'POST', '/withdrawals', { accountId: acct, amount: '100' }, uuid());
  assert.equal(r.status, 422);
  assert.equal(r.data.error.reason, 'account_frozen');
  assert.equal(await t.balance(acct), 5000n);
  await t.call('admin', 'POST', `/accounts/${acct}/unfreeze`);
  assert.equal((await t.call('alice', 'POST', '/withdrawals', { accountId: acct, amount: '100' }, uuid())).status, 201);
});

test('statement lists debits, credits and refusals with running balance and initiator', async () => {
  const a = await t.newAccount('stmt-a', [t.users.alice.id], 1000);
  const b = await t.newAccount('stmt-b', [t.users.bob.id], 0);
  await t.call('alice', 'POST', '/transfers', { fromAccountId: a, toAccountId: b, amount: '400' }, uuid());
  await t.call('alice', 'POST', '/withdrawals', { accountId: a, amount: '9999' }, uuid()); // refused
  const st = (await t.call('alice', 'GET', `/accounts/${a}/statement`)).data.entries;
  assert.equal(st.length, 3); // funding, transfer out, refused
  const [refused, out, funding] = st;
  assert.equal(refused.status, 'refused');
  assert.equal(refused.balanceAfter, null);
  assert.equal(out.amount, '-400');
  assert.equal(out.balanceAfter, '600');
  assert.equal(out.initiatedBy, 'alice@t.test');
  assert.equal(funding.balanceAfter, '1000');
  assert.equal(funding.initiatedBy, 'admin@t.test');
});
