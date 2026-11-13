# THREATS.md

Status key: **Closed** = mitigated in code and covered by a named test. **Mitigated** = reduced, not eliminated. **Accepted** = knowingly left open.
This is a draft written alongside the code; **re-verify each row against your own test runs before submitting and edit anything that is not true.**

## Money and balance integrity

| # | Threat | What stops it | Test | Status |
|---|---|---|---|---|
| T1 | Two withdrawals race, both see enough, account overdrawn | Balance checked and debited under `SELECT ... FOR UPDATE` in one transaction; `CHECK (balance >= 0)` as backstop | `concurrent withdrawals never overdraw the account` | Closed |
| T2 | Two transfers from the same account race | Same lock; both lock the source row so the second sees the post-debit balance | `concurrent transfers cannot spend the same money twice` | Closed |
| T3 | A->B and B->A at the same instant deadlock | Locks always taken in ascending account id; deadlock/serialization errors retried (safe because of idempotency keys) | `opposite-direction transfers do not deadlock...` | Closed |
| T4 | Lost update / stale write corrupts a balance | Balance updated with `balance = balance + delta` and the result asserted equal to the value computed under the lock; reconciliation compares cache to SUM(entries) | `money is conserved across a random mixed workload` | Closed |
| T5 | Money created or destroyed by a half-written posting (crash between debit and credit) | One transaction; deferred constraint trigger requires exactly two legs summing to zero and a `posted` parent at COMMIT | `a half-written posting (one leg only) cannot commit` | Closed |
| T6 | Floats, rounding, overflow, negative or exponent amounts | BIGINT paise; amounts accepted only as `^[1-9][0-9]{0,15}$` (or a safe integer), capped at 1e12; BigInt arithmetic in Node | `invalid amounts are rejected and move nothing` | Closed |
| T7 | Moving money to/from the EXTERNAL system account directly | Destination checks reject system account; nobody is a member of it so it cannot be debited | `depositing into or transferring to the EXTERNAL...` | Closed |
| T8 | Frozen account still moves money | Status read under the row lock; refusal recorded | `frozen accounts refuse movements...` | Closed |
| T9 | Hot row: every deposit/withdrawal locks the single EXTERNAL row, serialising them | Not fixed. A production system would shard EXTERNAL into N counter accounts. Correctness is unaffected, throughput is | none | **Accepted** |

## Exactly once

| # | Threat | What stops it | Test | Status |
|---|---|---|---|---|
| T10 | Retry after timeout / double-click pays twice | `UNIQUE (initiated_by, idempotency_key)`; second call returns the stored transaction | `a replayed request moves money once...` | Closed |
| T11 | Duplicate arrives while the first is still in flight | `pg_advisory_xact_lock` on `(user:key)` makes it wait, then replay the committed result; unique violation (23505) triggers a re-run as a backstop | `the same key fired concurrently still moves money once` | Closed |
| T12 | Key reused with a different amount/destination to confuse or hijack | Request hash stored; mismatch returns 422 and moves nothing | `reusing a key with a different request is rejected...` | Closed |
| T13a | One user replays or collides with another user's key | Key is unique per `(user, key)`, not global | `idempotency keys are scoped per user...` | Closed |
| T13b | Duplicates are invisible | Every replay writes `idempotency_hits`; auditors can list them | `a replayed request...` (asserts the row) | Closed |
| T13c | A replay returns a stale refusal even though funds now exist | Deliberate: a key identifies one *outcome*, refused included. Retrying after fixing the cause needs a new key. Documented in API.md | `a refused request replays as the same refusal` | **Accepted (by design)** |
| T13d | Replay skips re-authorisation (a user whose access was revoked since can still fetch their own old result) | No money moves on replay; only the original actor can replay their own key. No endpoint exists to remove members anyway | none | **Accepted** |
| T13e | Keys are remembered forever (storage growth) | They live on the append-only transaction row; expiry would re-open double-pay. Trade-off chosen for safety | none | **Accepted** |

## Authorisation

| # | Threat | What stops it | Test | Status |
|---|---|---|---|---|
| T14 | Moving money out of an account you do not own (IDOR) | Membership checked in the service, inside the transaction, from the database on every request; the client's role/ids are never trusted | `one user cannot withdraw from or transfer out of another user's account` | Closed |
| T15 | Admin abuses power to spend user money | Debits require role `holder` AND membership; admin can only create/freeze/fund | `admin cannot spend users' money...` | Closed |
| T16 | Auditor changes anything | Auditor role is rejected by every write endpoint; no write path in oversight endpoints | `admin cannot spend...; auditor cannot move any money`, `role checks...` | Closed |
| T17 | Role escalation by editing the token | Token carries only the user id and is HMAC-signed; role is re-read from the database every request | `unauthenticated, forged and expired-style tokens get 401` | Closed |
| T18 | Reading other users' balances/statements | Membership check; same 403 whether or not the account exists | `holders cannot read balances or statements...` | Closed |
| T19 | Pulling money by "depositing" into someone else's account as a holder | Holders may deposit only into own accounts | `a user can receive money from another user but never pull it` | Closed |
| T20 | Password guessing | scrypt hashes; constant-ish time for unknown emails; 10 failures / 15 min per ip+email | none | **Mitigated** (limiter is in-memory, per instance, resets on restart) |
| T21 | Token theft via XSS | UI builds DOM with textContent only; CSP `default-src 'self'`; 1 h token expiry. Token is in `sessionStorage` and there is no server-side revocation | none | **Mitigated** |
| T22 | Membership changes mid-request | Membership is read inside the transaction before locking; revocation endpoint does not exist | none | **Accepted** |

## Ledger and audit trail

| # | Threat | What stops it | Test | Status |
|---|---|---|---|---|
| T23 | A ledger row is altered or deleted through the API | No endpoint can; none exists | n/a | Closed |
| T24 | ...or through SQL by the application's DB role | Triggers reject UPDATE/DELETE/TRUNCATE on transactions, entries, idempotency_hits, audit_log. Optional `db/roles.sql` removes the privileges entirely | `ledger tables reject UPDATE, DELETE and TRUNCATE` | Closed against the app; see T25 |
| T25 | A DB superuser/owner disables the trigger and edits a row | Detected, not prevented: per-account SHA-256 hash chain over (txn, kind, initiator, account, amount, balance, seq, prev). `/api/reconciliation` recomputes and flags it | `an edit made behind the application's back (triggers disabled) is detected` | **Mitigated** |
| T26 | The same owner edits a row *and* recomputes the whole chain and the account heads | Not detectable from inside the database. Mitigation is to publish `ledgerDigest` somewhere the DB owner cannot rewrite (a signed daily note, email, a second system). Not automated | none | **Accepted** |
| T27 | Refused attempts vanish (rolled back with the failed request) | Refusals are inserted and COMMITTED as `refused` transactions | `statement lists debits, credits and refusals...` | Closed |
| T28 | Authorisation denials leave no trace on the account | They go to `audit_log` (`denied`), not the account statement: they are not ledger events. Audit rows are append-only too | `one user cannot withdraw...` (asserts audit rows) | Closed |
| T29 | `audit_log` growth from spam (denials, failed logins) | Not rate-limited beyond the login limiter | none | **Accepted** |
| T30 | Ordering ambiguity from clock skew | Order is by id/seq, never timestamps | n/a | Closed |

## Platform

| # | Threat | What stops it | Status |
|---|---|---|---|
| T31 | SQL injection | Parameterised queries only; ids and amounts regex-validated | Closed |
| T32 | Mass assignment | Handlers read named fields only | Closed |
| T33 | Request flooding holds locks (DoS) | `lock_timeout` 5 s -> 503 `busy`; body limit 10 kB; no global rate limiter | **Mitigated** |
| T34 | Seed credentials left on a live system | Documented in README as demo-only; change `SEED_PASSWORD` / rotate | **Accepted** for the demo |
| T35 | Admin can alter who may debit an account (add a member) | Logged in `audit_log`; no maker-checker approval | **Accepted** |

## Deliberately not built

Reversals/refunds, holds and authorisations, scheduled/batch transfers, multi-currency, overdraft, maker-checker approvals, and AI anomaly flagging. Large-amount flagging is a fixed rule (`FLAG_THRESHOLD_PAISE`), not AI. **No machine moves money in this system.** Each omission shrinks the surface that could lose a rupee.
