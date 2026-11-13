'use strict';
/**
 * The only module that moves money.
 *
 * Concurrency model (explain this in the interview):
 *  1. One DB transaction per request (READ COMMITTED).
 *  2. pg_advisory_xact_lock(actor:key) serialises requests carrying the same idempotency key, so a duplicate
 *     that arrives while the first is in flight waits, then sees the committed result and returns it.
 *     UNIQUE(initiated_by, idempotency_key) is the backstop.
 *  3. Authorisation is decided here, inside the transaction, from the database.
 *  4. Account rows involved are locked with SELECT ... FOR UPDATE in ascending id order (no deadlocks).
 *     The balance check and the debit happen under that lock, in the same transaction.
 *  5. Refusals are written to the ledger and COMMITTED (not rolled back), so they appear on statements.
 *  6. CHECK (balance >= 0), the append-only triggers and the deferred zero-sum trigger are the last line of defence.
 */
const crypto = require('crypto');
const { pool, withTx } = require('./db');
const { AppError } = require('./errors');
const cfg = require('./config');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const cmpBig = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

function parseAmount(v) {
  let s;
  if (typeof v === 'number' && Number.isSafeInteger(v)) s = String(v);
  else if (typeof v === 'string') s = v;
  else throw new AppError(400, 'invalid_amount', 'amount must be a positive integer number of paise');
  if (!/^[1-9][0-9]{0,15}$/.test(s)) throw new AppError(400, 'invalid_amount', 'amount must be a positive integer number of paise');
  const n = BigInt(s);
  if (n > cfg.maxAmount) throw new AppError(400, 'amount_too_large', 'amount exceeds the per-movement limit');
  return n;
}

function parseId(v, field) {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^[1-9][0-9]{0,17}$/.test(s)) throw new AppError(400, 'invalid_account', `${field} must be an account id`);
  return s;
}

function parseKey(v) {
  if (typeof v !== 'string' || !KEY_RE.test(v)) {
    throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key header is required (8-128 chars: letters, digits, _ . : -)');
  }
  return v;
}

function entryHash(prev, txn, accountId, delta, balanceAfter, seq) {
  return sha([prev || '', txn.id, txn.kind, txn.initiated_by, accountId, delta, balanceAfter, seq].join('|'));
}

async function audit(db, actorId, action, detail, requestId) {
  await db.query('INSERT INTO audit_log(actor_id, action, detail, request_id) VALUES ($1, $2, $3::jsonb, $4)',
    [actorId, action, JSON.stringify(detail || {}), requestId || null]);
}

// Authorisation is decided by the server, from the database, on every money-moving request.
async function authorise(c, actor, kind, fromId, toId) {
  const deny = (m) => { throw new AppError(403, 'forbidden', m || 'Not allowed'); };
  const isMember = async (id) =>
    (await c.query('SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2', [id, actor.id])).rowCount === 1;
  const destination = async (id) => {
    const r = await c.query('SELECT is_system FROM accounts WHERE id = $1', [id]);
    if (!r.rowCount || r.rows[0].is_system) throw new AppError(404, 'account_not_found', 'Destination account not found');
  };

  if (kind === 'deposit') {
    // Admin funds any account; a holder may fund their own. Auditors never move money.
    if (!(actor.role === 'admin' || (actor.role === 'holder' && (await isMember(toId))))) deny('You may only deposit into your own accounts');
    await destination(toId);
  } else {
    // Debits (withdrawal / transfer out) require the holder role AND membership. Admin cannot spend users' money.
    if (actor.role !== 'holder' || !(await isMember(fromId))) deny('You may only debit accounts you are a member of');
    if (kind === 'transfer') await destination(toId);
  }
}

async function insertTxn(c, t) {
  const r = await c.query(
    `INSERT INTO transactions(kind, status, refusal_reason, amount, from_account, to_account,
                              initiated_by, idempotency_key, request_hash, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [t.kind, t.status, t.reason || null, t.amount.toString(), t.fromId, t.toId, t.actor.id, t.key, t.reqHash, t.requestId]);
  return r.rows[0];
}

/**
 * kind: 'deposit' (toId) | 'withdrawal' (fromId) | 'transfer' (fromId, toId). amount: BigInt paise.
 * Returns { txn, replay }. txn.status is 'posted' or 'refused' (a refusal is a recorded outcome, not an exception).
 */
async function move({ actor, kind, fromId = null, toId = null, amount, key, requestId }) {
  const reqHash = sha(JSON.stringify([kind, fromId, toId, amount.toString()]));
  try {
    return await run();
  } catch (e) {
    // Backstop: unique violation on the idempotency key means a concurrent twin committed first. Re-run to replay it.
    if (e.code === '23505' && e.constraint === 'uq_txn_idem') return run();
    throw e;
  }

  function run() {
    return withTx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${actor.id}:${key}`]);

      const prior = await c.query('SELECT * FROM transactions WHERE initiated_by = $1 AND idempotency_key = $2', [actor.id, key]);
      if (prior.rowCount) {
        const t = prior.rows[0];
        if (t.request_hash !== reqHash) {
          throw new AppError(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used for a different request');
        }
        await c.query('INSERT INTO idempotency_hits(transaction_id, request_id) VALUES ($1, $2)', [t.id, requestId]);
        return { txn: t, replay: true };
      }

      await authorise(c, actor, kind, fromId, toId);

      const extId = (await c.query('SELECT id FROM accounts WHERE is_system')).rows[0].id;
      const legs = kind === 'deposit' ? [{ id: toId, delta: amount }, { id: extId, delta: -amount }]
        : kind === 'withdrawal' ? [{ id: fromId, delta: -amount }, { id: extId, delta: amount }]
          : [{ id: fromId, delta: -amount }, { id: toId, delta: amount }];
      legs.sort((a, b) => cmpBig(a.id, b.id));

      // LOCK: ascending id order. Removing FOR UPDATE must make the concurrency tests fail.
      const locked = new Map();
      for (const leg of legs) {
        const r = await c.query(
          'SELECT id, balance, status, is_system, last_seq, last_hash FROM accounts WHERE id = $1 FOR UPDATE', [leg.id]);
        if (!r.rowCount) throw new AppError(404, 'account_not_found', 'Account not found');
        locked.set(leg.id, r.rows[0]);
      }

      const base = { kind, amount, fromId, toId, actor, key, reqHash, requestId };
      let reason = null;
      for (const leg of legs) {
        const a = locked.get(leg.id);
        if (a.is_system) continue;
        if (a.status === 'frozen') { reason = 'account_frozen'; break; }
        // CHECK: balance is tested under the row lock, in the same transaction as the debit below.
        if (leg.delta < 0n && BigInt(a.balance) + leg.delta < 0n) { reason = 'insufficient_funds'; break; }
      }
      if (reason) {
        const txn = await insertTxn(c, { ...base, status: 'refused', reason });
        return { txn, replay: false };
      }

      const txn = await insertTxn(c, { ...base, status: 'posted' });
      for (const leg of legs) {
        const a = locked.get(leg.id);
        const seq = BigInt(a.last_seq) + 1n;
        const newBal = BigInt(a.balance) + leg.delta;
        const hash = entryHash(a.last_hash, txn, leg.id, leg.delta, newBal, seq);
        const upd = await c.query(
          'UPDATE accounts SET balance = balance + $2::bigint, last_seq = $3, last_hash = $4 WHERE id = $1 RETURNING balance',
          [leg.id, leg.delta.toString(), seq.toString(), hash]);
        // Invariant: under the lock nobody else can have changed the balance.
        if (BigInt(upd.rows[0].balance) !== newBal) throw new Error('invariant violated: balance changed under lock');
        await c.query(
          `INSERT INTO entries(transaction_id, account_id, amount, balance_after, seq, prev_hash, row_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [txn.id, leg.id, leg.delta.toString(), newBal.toString(), seq.toString(), a.last_hash, hash]);
      }
      if (amount >= cfg.flagThreshold) {
        await audit(c, actor.id, 'flag', { reason: 'large_amount', transactionId: txn.id, amount: amount.toString() }, requestId);
      }
      return { txn, replay: false };
    });
  }
}

const presentTxn = (t) => ({
  id: t.id, kind: t.kind, status: t.status, refusalReason: t.refusal_reason, amount: String(t.amount),
  fromAccount: t.from_account, toAccount: t.to_account, initiatedBy: t.initiated_by, createdAt: t.created_at,
});

const presentAccount = (a) => ({ id: a.id, name: a.name, balance: String(a.balance), status: a.status, isSystem: !!a.is_system });

async function loadAccountFor(user, id) {
  const r = await pool.query('SELECT id, name, balance, status, is_system FROM accounts WHERE id = $1', [id]);
  if (user.role === 'holder') {
    const m = await pool.query('SELECT 1 FROM account_members WHERE account_id = $1 AND user_id = $2', [id, user.id]);
    if (!m.rowCount) throw new AppError(403, 'forbidden', 'Not your account'); // same answer whether or not it exists
  }
  if (!r.rowCount) throw new AppError(404, 'account_not_found', 'Account not found');
  return r.rows[0];
}

async function listAccounts(user) {
  const r = user.role === 'holder'
    ? await pool.query(`SELECT a.id, a.name, a.balance, a.status, a.is_system FROM accounts a
                        JOIN account_members m ON m.account_id = a.id WHERE m.user_id = $1 ORDER BY a.id`, [user.id])
    : await pool.query('SELECT id, name, balance, status, is_system FROM accounts ORDER BY id');
  return r.rows.map(presentAccount);
}

// Every debit, credit and refused attempt on the account, newest first, with running balance and initiator.
async function statement(accountId, { limit = 50, before = null } = {}) {
  const r = await pool.query(
    `SELECT t.id AS transaction_id, t.kind, t.status, t.refusal_reason, t.amount AS requested_amount, t.created_at,
            u.email AS initiated_by, e.amount AS signed_amount, e.balance_after, e.seq
       FROM transactions t
       JOIN users u ON u.id = t.initiated_by
       LEFT JOIN entries e ON e.transaction_id = t.id AND e.account_id = $1
      WHERE (e.id IS NOT NULL
             OR (t.status = 'refused' AND ((t.kind = 'deposit' AND t.to_account = $1)
                                        OR (t.kind <> 'deposit' AND t.from_account = $1))))
        AND ($2::bigint IS NULL OR t.id < $2::bigint)
      ORDER BY t.id DESC LIMIT $3`,
    [accountId, before, limit]);
  return r.rows.map((x) => ({
    transactionId: x.transaction_id, kind: x.kind, status: x.status, refusalReason: x.refusal_reason,
    amount: x.signed_amount === null ? String(x.requested_amount) : String(x.signed_amount), // signed for posted rows
    balanceAfter: x.balance_after === null ? null : String(x.balance_after),
    seq: x.seq, initiatedBy: x.initiated_by, createdAt: x.created_at,
  }));
}

/** Proves the books balance: conservation, cache == ledger, no negatives, hash chains intact. */
async function reconcile() {
  const problems = [];
  const one = async (q) => (await pool.query(q)).rows;

  const total = (await one('SELECT COALESCE(SUM(amount),0) AS s FROM entries'))[0].s;
  if (BigInt(total) !== 0n) problems.push({ check: 'ledger_sums_to_zero', detail: `sum=${total}` });

  const unbalanced = await one('SELECT transaction_id FROM entries GROUP BY transaction_id HAVING SUM(amount) <> 0 OR COUNT(*) <> 2');
  if (unbalanced.length) problems.push({ check: 'transactions_balance', detail: unbalanced.slice(0, 20) });

  const drift = await one(`SELECT a.id, a.balance, COALESCE(SUM(e.amount),0) AS derived
                             FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
                            GROUP BY a.id HAVING a.balance <> COALESCE(SUM(e.amount),0)`);
  if (drift.length) problems.push({ check: 'balance_equals_sum_of_entries', detail: drift.slice(0, 20) });

  const neg = await one('SELECT id, balance FROM accounts WHERE NOT is_system AND balance < 0');
  if (neg.length) problems.push({ check: 'no_negative_balances', detail: neg });

  const cons = (await one(`SELECT
      COALESCE((SELECT SUM(balance) FROM accounts WHERE NOT is_system),0) AS held,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='deposit' AND status='posted'),0)
    - COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='withdrawal' AND status='posted'),0) AS net_external`))[0];
  if (BigInt(cons.held) !== BigInt(cons.net_external)) {
    problems.push({ check: 'balances_equal_deposits_minus_withdrawals', detail: cons });
  }

  // Hash chain: detects edits made behind the application's back (e.g. with triggers disabled).
  const rows = await one(`SELECT e.account_id, e.seq, e.amount, e.balance_after, e.prev_hash, e.row_hash,
                                 t.id AS txn_id, t.kind, t.initiated_by
                            FROM entries e JOIN transactions t ON t.id = e.transaction_id
                           ORDER BY e.account_id, e.seq`);
  const heads = new Map();
  let cur = null; let prevHash = null; let expectSeq = 0n; let bal = 0n;
  for (const r of rows) {
    if (cur !== r.account_id) { cur = r.account_id; prevHash = null; expectSeq = 0n; bal = 0n; }
    expectSeq += 1n; bal += BigInt(r.amount);
    const want = entryHash(prevHash, { id: r.txn_id, kind: r.kind, initiated_by: r.initiated_by }, r.account_id, r.amount, r.balance_after, r.seq);
    if (BigInt(r.seq) !== expectSeq) problems.push({ check: 'hash_chain', detail: `account ${r.account_id}: seq gap at ${r.seq}` });
    else if ((r.prev_hash || null) !== prevHash || want !== r.row_hash) problems.push({ check: 'hash_chain', detail: `account ${r.account_id}: row seq ${r.seq} altered` });
    else if (BigInt(r.balance_after) !== bal) problems.push({ check: 'hash_chain', detail: `account ${r.account_id}: running balance wrong at seq ${r.seq}` });
    prevHash = r.row_hash;
    heads.set(r.account_id, { seq: r.seq, hash: r.row_hash });
  }
  const accts = await one('SELECT id, last_seq, last_hash FROM accounts ORDER BY id');
  for (const a of accts) {
    const h = heads.get(a.id);
    if (BigInt(a.last_seq) !== BigInt(h ? h.seq : 0) || (a.last_hash || null) !== (h ? h.hash : null)) {
      problems.push({ check: 'chain_head_matches_account', detail: `account ${a.id}` });
    }
  }
  const digest = sha(accts.map((a) => `${a.id}:${a.last_seq}:${a.last_hash || ''}`).join('\n'));
  return { ok: problems.length === 0, problems: problems.slice(0, 50), ledgerDigest: digest, checkedEntries: rows.length };
}

module.exports = {
  move, audit, reconcile, statement, listAccounts, loadAccountFor,
  parseAmount, parseId, parseKey, presentTxn, presentAccount,
};
