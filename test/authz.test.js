'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uuid } = require('./helpers');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('one user cannot withdraw from or transfer out of another user\'s account', async () => {
  const alice = await t.newAccount('alice-acct', [t.users.alice.id], 10000);
  const bob = await t.newAccount('bob-acct', [t.users.bob.id], 0);
  const w = await t.call('bob', 'POST', '/withdrawals', { accountId: alice, amount: '100' }, uuid());
  const x = await t.call('bob', 'POST', '/transfers', { fromAccountId: alice, toAccountId: bob, amount: '100' }, uuid());
  assert.equal(w.status, 403);
  assert.equal(x.status, 403);
  assert.equal(await t.balance(alice), 10000n);
  assert.equal(await t.balance(bob), 0n);
  const denied = await t.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'denied'");
  assert.ok(denied.rows[0].n >= 2, 'denials are recorded in the audit log');
});

test('a user can receive money from another user but never pull it', async () => {
  const alice = await t.newAccount('recv-alice', [t.users.alice.id], 0);
  const bob = await t.newAccount('recv-bob', [t.users.bob.id], 1000);
  assert.equal((await t.call('bob', 'POST', '/transfers', { fromAccountId: bob, toAccountId: alice, amount: '300' }, uuid())).status, 201);
  assert.equal(await t.balance(alice), 300n);
  assert.equal((await t.call('bob', 'POST', '/deposits', { accountId: alice, amount: '300' }, uuid())).status, 403);
});

test('admin cannot spend users\' money; auditor cannot move any money', async () => {
  const alice = await t.newAccount('adm-alice', [t.users.alice.id], 5000);
  const other = await t.newAccount('adm-other', [t.users.bob.id], 0);
  for (const who of ['admin', 'auditor']) {
    assert.equal((await t.call(who, 'POST', '/withdrawals', { accountId: alice, amount: '100' }, uuid())).status, 403, who);
    assert.equal((await t.call(who, 'POST', '/transfers', { fromAccountId: alice, toAccountId: other, amount: '100' }, uuid())).status, 403, who);
  }
  assert.equal((await t.call('auditor', 'POST', '/deposits', { accountId: alice, amount: '100' }, uuid())).status, 403);
  assert.equal(await t.balance(alice), 5000n);
});

test('role checks: holders cannot use admin or oversight endpoints', async () => {
  const acct = await t.newAccount('role-acct', [t.users.alice.id], 0);
  assert.equal((await t.call('alice', 'POST', '/accounts', { name: 'x' })).status, 403);
  assert.equal((await t.call('alice', 'POST', `/accounts/${acct}/freeze`)).status, 403);
  assert.equal((await t.call('alice', 'POST', `/accounts/${acct}/members`, { email: 'bob@t.test' })).status, 403);
  assert.equal((await t.call('alice', 'GET', '/audit')).status, 403);
  assert.equal((await t.call('alice', 'GET', '/reconciliation')).status, 403);
  assert.equal((await t.call('auditor', 'POST', '/accounts', { name: 'x' })).status, 403);
  assert.equal((await t.call('auditor', 'GET', '/audit')).status, 200);
  assert.equal((await t.call('admin', 'GET', '/reconciliation')).status, 200);
});

test('holders cannot read balances or statements of accounts they are not members of', async () => {
  const alice = await t.newAccount('priv-alice', [t.users.alice.id], 100);
  assert.equal((await t.call('bob', 'GET', `/accounts/${alice}`)).status, 403);
  assert.equal((await t.call('bob', 'GET', `/accounts/${alice}/statement`)).status, 403);
  assert.equal((await t.call('auditor', 'GET', `/accounts/${alice}/statement`)).status, 200);
  const list = (await t.call('bob', 'GET', '/accounts')).data.accounts;
  assert.ok(list.every((a) => a.id !== alice));
});

test('unauthenticated, forged and expired-style tokens get 401', async () => {
  assert.equal((await t.call(null, 'GET', '/accounts')).status, 401);
  assert.equal((await t.call('not.a.token', 'GET', '/accounts')).status, 401);
  const [body] = t.tokens.alice.split('.');
  assert.equal((await t.call(`${body}.AAAA`, 'GET', '/accounts')).status, 401);
  const forged = Buffer.from(JSON.stringify({ uid: t.users.admin.id, exp: 9999999999 })).toString('base64url');
  assert.equal((await t.call(`${forged}.${t.tokens.alice.split('.')[1]}`, 'GET', '/accounts')).status, 401);
  assert.equal((await t.call(null, 'POST', '/withdrawals', { accountId: '1', amount: '1' }, uuid())).status, 401);
});

test('depositing into or transferring to the EXTERNAL system account is impossible', async () => {
  const ext = (await t.pool.query('SELECT id FROM accounts WHERE is_system')).rows[0].id;
  const alice = await t.newAccount('ext-alice', [t.users.alice.id], 1000);
  assert.equal((await t.call('alice', 'POST', '/transfers', { fromAccountId: alice, toAccountId: ext, amount: '100' }, uuid())).status, 404);
  assert.equal((await t.call('alice', 'POST', '/withdrawals', { accountId: ext, amount: '100' }, uuid())).status, 403);
  assert.equal((await t.call('admin', 'POST', '/deposits', { accountId: ext, amount: '100' }, uuid())).status, 404);
});
