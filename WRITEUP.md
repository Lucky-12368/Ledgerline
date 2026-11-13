# Write-up

> Draft skeleton. The sections about AI use, mistakes found and unfinished work must be written by you from what actually happened.

## What I built
LedgerLine: a double-entry money system (Node/Express/PostgreSQL, vanilla JS UI) with three roles (admin, holder, auditor), accounts, deposits, withdrawals and transfers in integer paise, per-account statements that include refused attempts, an append-only hash-chained ledger, per-user idempotency keys, and a reconciliation endpoint that re-proves the books on demand.

## What I deliberately did not build
Reversals/refunds, holds, scheduled transfers, multi-currency, overdraft, maker-checker approvals, AI anomaly flagging (a fixed large-amount rule exists instead). Reason: each is another way to lose a rupee, and a small correct system beats a large leaky one. See `THREATS.md` for accepted risks.

## Integrity and concurrency model
1. One database transaction per request.
2. Advisory lock on `(user, idempotency key)`: a duplicate waits for the first, then replays its stored result. `UNIQUE (initiated_by, idempotency_key)` backs it up.
3. Authorisation is decided from the database inside the transaction.
4. Account rows locked `FOR UPDATE` in ascending id order; balance check and debit happen under the lock.
5. Two legs, summing to zero, written together; a deferred trigger rejects anything else at COMMIT.
6. Balance cache is updated as `balance + delta` and asserted against the value computed under the lock.
7. Ledger tables have triggers against UPDATE/DELETE/TRUNCATE; entries are hash-chained per account; `/api/reconciliation` verifies everything.

Where the check and the debit live: `src/ledger.js`, inside the `run()` function in `move()`: the funds check is in the loop right after the `LOCK:` comment block, and the debit is the `UPDATE accounts ... balance + $2` in the posting loop, same transaction, same held locks.

## How I used AI, and where it was wrong
TODO: fill in from PROMPTS.md. Be specific; "it was fine" scores nothing.

## What is unfinished / known gaps
- TODO: record the result of the README mutation checks (which tests failed when each lock/check was removed).
- The tests were authored without access to a Postgres instance and must be run and fixed if anything fails.
- EXTERNAL account is a throughput hot spot (T9). Rate limiting is minimal (T20, T33). `ledgerDigest` is not published anywhere automatically (T26).
- No UI for the auditor beyond the oversight tab; no pagination UI on statements.

## Demo video checklist (5 min)
1. Log in as each role (30 s). 2. Deposit/transfer; show statement with running balance and initiator. 3. Double-click / replay the same request (curl with the same key) and show the duplicate in the auditor view. 4. Fire two concurrent withdrawals with a small script and show one refusal on the statement. 5. Try a transfer from someone else's account: 403. 6. Show `UPDATE entries ...` failing in psql, then the reconciliation page. 7. Walk through `move()` in `src/ledger.js`.
