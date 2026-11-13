'use strict';
const express = require('express');
const { pool, withTx } = require('./db');
const { AppError } = require('./errors');
const {
  verifyPassword, dummyVerify, signToken, authenticate, requireRole, limiter,
} = require('./auth');
const L = require('./ledger');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const auth = authenticate;

// ---------- auth ----------
router.post('/auth/login', ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const k = `${req.ip}|${email}`;
  if (limiter.blocked(k)) throw new AppError(429, 'too_many_attempts', 'Too many failed attempts; try again later');
  const r = await pool.query('SELECT id, email, role, password_hash FROM users WHERE email = $1', [email]);
  let ok = false;
  if (r.rowCount) ok = await verifyPassword(password, r.rows[0].password_hash);
  else await dummyVerify(password);
  if (!ok) {
    limiter.fail(k);
    await L.audit(pool, r.rowCount ? r.rows[0].id : null, 'login_failed', { email }, req.id);
    throw new AppError(401, 'bad_credentials', 'Invalid email or password');
  }
  limiter.reset(k);
  const u = r.rows[0];
  await L.audit(pool, u.id, 'login', {}, req.id);
  res.json({ token: signToken(u.id), user: { id: u.id, email: u.email, role: u.role } });
}));

router.get('/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- accounts ----------
router.get('/accounts', auth, ah(async (req, res) => {
  res.json({ accounts: await L.listAccounts(req.user) });
}));

router.post('/accounts', auth, requireRole('admin'), ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 80) throw new AppError(400, 'invalid_name', 'name is required (max 80 chars)');
  const owner = req.body?.ownerEmail ? String(req.body.ownerEmail).trim().toLowerCase() : null;
  const account = await withTx(async (c) => {
    const a = (await c.query('INSERT INTO accounts(name) VALUES ($1) RETURNING id, name, balance, status, is_system', [name])).rows[0];
    if (owner) {
      const u = await c.query("SELECT id FROM users WHERE email = $1 AND role = 'holder'", [owner]);
      if (!u.rowCount) throw new AppError(400, 'bad_owner', 'ownerEmail must be an existing account holder');
      await c.query('INSERT INTO account_members(account_id, user_id) VALUES ($1, $2)', [a.id, u.rows[0].id]);
    }
    await L.audit(c, req.user.id, 'account_created', { accountId: a.id, name, owner }, req.id);
    return a;
  });
  res.status(201).json({ account: L.presentAccount(account) });
}));

router.get('/accounts/:id', auth, ah(async (req, res) => {
  const a = await L.loadAccountFor(req.user, L.parseId(req.params.id, 'id'));
  res.json({ account: L.presentAccount(a) });
}));

router.get('/accounts/:id/statement', auth, ah(async (req, res) => {
  const id = L.parseId(req.params.id, 'id');
  await L.loadAccountFor(req.user, id);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const before = req.query.before ? L.parseId(String(req.query.before), 'before') : null;
  res.json({ accountId: id, entries: await L.statement(id, { limit, before }) });
}));

router.post('/accounts/:id/members', auth, requireRole('admin'), ah(async (req, res) => {
  const id = L.parseId(req.params.id, 'id');
  const email = String(req.body?.email || '').trim().toLowerCase();
  await withTx(async (c) => {
    const a = await c.query('SELECT is_system FROM accounts WHERE id = $1', [id]);
    if (!a.rowCount || a.rows[0].is_system) throw new AppError(404, 'account_not_found', 'Account not found');
    const u = await c.query("SELECT id FROM users WHERE email = $1 AND role = 'holder'", [email]);
    if (!u.rowCount) throw new AppError(400, 'bad_member', 'email must be an existing account holder');
    await c.query('INSERT INTO account_members(account_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, u.rows[0].id]);
    await L.audit(c, req.user.id, 'member_added', { accountId: id, email }, req.id);
  });
  res.status(201).json({ ok: true });
}));

for (const [verb, status] of [['freeze', 'frozen'], ['unfreeze', 'active']]) {
  router.post(`/accounts/:id/${verb}`, auth, requireRole('admin'), ah(async (req, res) => {
    const id = L.parseId(req.params.id, 'id');
    await withTx(async (c) => {
      // Row lock: serialises with in-flight money movements on this account.
      const a = await c.query('SELECT is_system FROM accounts WHERE id = $1 FOR UPDATE', [id]);
      if (!a.rowCount || a.rows[0].is_system) throw new AppError(404, 'account_not_found', 'Account not found');
      await c.query('UPDATE accounts SET status = $2 WHERE id = $1', [id, status]);
      await L.audit(c, req.user.id, `account_${verb}`, { accountId: id }, req.id);
    });
    res.json({ ok: true, status });
  }));
}

// ---------- money movement ----------
const moneyRoute = (kind, path, roles, read) =>
  router.post(path, auth, requireRole(...roles), ah(async (req, res) => {
    const key = L.parseKey(req.get('Idempotency-Key'));
    const b = req.body || {};
    const amount = L.parseAmount(b.amount);
    const ids = read(b);
    let out;
    try {
      out = await L.move({ actor: req.user, kind, ...ids, amount, key, requestId: req.id });
    } catch (e) {
      if (e instanceof AppError && e.status === 403) {
        await L.audit(pool, req.user.id, 'denied', { kind, ...ids, amount: amount.toString() }, req.id).catch(() => {});
      }
      throw e;
    }
    if (out.replay) res.set('Idempotent-Replay', 'true');
    const transaction = L.presentTxn(out.txn);
    if (out.txn.status === 'refused') {
      return res.status(422).json({
        error: { code: 'refused', reason: out.txn.refusal_reason, message: `Refused: ${out.txn.refusal_reason}`, requestId: req.id },
        transaction,
      });
    }
    res.status(201).json({ transaction });
  }));

moneyRoute('deposit', '/deposits', ['admin', 'holder'], (b) => ({ toId: L.parseId(b.accountId, 'accountId') }));
moneyRoute('withdrawal', '/withdrawals', ['holder'], (b) => ({ fromId: L.parseId(b.accountId, 'accountId') }));
moneyRoute('transfer', '/transfers', ['holder'], (b) => {
  const fromId = L.parseId(b.fromAccountId, 'fromAccountId');
  const toId = L.parseId(b.toAccountId, 'toAccountId');
  if (fromId === toId) throw new AppError(400, 'same_account', 'Cannot transfer to the same account');
  return { fromId, toId };
});

// ---------- oversight (admin + auditor, read-only) ----------
const oversight = [auth, requireRole('admin', 'auditor')];

router.get('/reconciliation', ...oversight, ah(async (_req, res) => res.json(await L.reconcile())));

router.get('/transactions', ...oversight, ah(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const r = await pool.query('SELECT * FROM transactions ORDER BY id DESC LIMIT $1', [limit]);
  res.json({ transactions: r.rows.map(L.presentTxn) });
}));

router.get('/audit', ...oversight, ah(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const r = await pool.query('SELECT id, actor_id, action, detail, request_id, created_at FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
  res.json({ events: r.rows });
}));

router.get('/idempotency-hits', ...oversight, ah(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const r = await pool.query(
    `SELECT h.id, h.transaction_id, h.request_id, h.seen_at, t.kind, t.status, t.idempotency_key
       FROM idempotency_hits h JOIN transactions t ON t.id = h.transaction_id ORDER BY h.id DESC LIMIT $1`, [limit]);
  res.json({ hits: r.rows });
}));

module.exports = router;
