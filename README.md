# LedgerLine: money movement with a ledger you can prove

Node.js + Express + PostgreSQL. Vanilla HTML/CSS/JS frontend. Integer paise everywhere (no floats).
Live URL: **TODO: add your Render URL here**

## Quick start (local)

```bash
# 1. Postgres running locally, two empty databases:
createdb ledgerline && createdb ledgerline_test
# 2. Configure
cp .env.example .env      # then export the variables, e.g.:  set -a; . ./.env; set +a
# 3. Install, create schema, seed demo data, run
npm install
npm run migrate
npm run seed
npm start                 # http://localhost:3000
# 4. Tests (real Postgres; DROPS and recreates the schema of TEST_DATABASE_URL)
npm test
```

Requires Node >= 20 (uses the built-in test runner and `fetch`).

## Demo credentials (created by `npm run seed`, password `LedgerLine#2026` unless `SEED_PASSWORD` is set)

| Role | Email | Can |
|---|---|---|
| Administrator | `admin@ledgerline.test` | Create accounts, add members, freeze/unfreeze, deposit into any account, read everything. **Cannot** spend a holder's money. |
| Account holder | `alice@ledgerline.test`, `bob@ledgerline.test` | Deposit into, withdraw from and transfer out of accounts they are a member of; read own accounts/statements. |
| Auditor | `auditor@ledgerline.test` | Read-only: all accounts, statements, transactions, audit log, duplicate-request log, reconciliation. Moves no money. |

**Change or re-seed these before using the deployment for anything real.**

## Deploy on Render

1. Push to GitHub. In Render: **New > Blueprint**, select the repo (uses `render.yaml`: a web service plus a Postgres database).
2. Render injects `DATABASE_URL` and generates `TOKEN_SECRET`. The start command runs `migrate` (idempotent) and `seed` (skips if users exist), then starts the server.
3. Optional hardening: `db/roles.sql` creates an app role that cannot UPDATE/DELETE ledger rows or alter triggers (see THREATS.md T13/T14).

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `TOKEN_SECRET` | yes | >= 32 chars, signs session tokens |
| `PORT` | no | default 3000 |
| `PGSSL` | no | `true` for external managed Postgres |
| `FLAG_THRESHOLD_PAISE` | no | transfers/deposits/withdrawals at or above this are flagged in the audit log (default Rs 50,000) |
| `SEED_PASSWORD` | no | password for seeded demo users |
| `TEST_DATABASE_URL` | tests | database name must contain `test` |

## The integrity model in one paragraph

Double-entry ledger. Each posted transaction has exactly two signed `entries` that sum to zero; deposits and withdrawals use a system account `EXTERNAL` as the other leg, so the whole ledger always sums to zero and the money held by real accounts equals posted deposits minus posted withdrawals. A request runs in one transaction: take an advisory lock on `(user, idempotency key)`; if that key already has a result, return it (and record the duplicate in `idempotency_hits`); otherwise authorise from the database, lock the account rows `FOR UPDATE` in ascending id order, check frozen status and funds under the lock, write the transaction, update balances and append hash-chained entries. Refusals are committed as `refused` transactions so they show on statements. Database constraints back all of it: `CHECK (balance >= 0)`, `UNIQUE (initiated_by, idempotency_key)`, a deferred trigger that rejects any posting without exactly two legs summing to zero, and triggers that reject UPDATE/DELETE/TRUNCATE on ledger tables. `GET /api/reconciliation` re-derives everything and verifies the hash chains. Details and residual risks: `THREATS.md`.

## Prove-it-yourself: mutation checks

The brief says a judge may remove one lock or check and run the tests. Try these and confirm the named tests fail, then revert:

| Remove | Expect failures in |
|---|---|
| `FOR UPDATE` in `src/ledger.js` (the `LOCK:` loop) | `concurrent withdrawals never overdraw...`, `concurrent transfers cannot spend...`, `money is conserved...` |
| the `pg_advisory_xact_lock` line | `the same key fired concurrently still moves money once` (the unique constraint turns this into the 23505 re-run path; also try removing the re-run catch) |
| the `idempotency_hits` insert | `a replayed request moves money once...` |
| `authorise(...)` call | everything in `test/authz.test.js` |
| the `forbid_mutation` triggers (in schema) | `ledger tables reject UPDATE, DELETE and TRUNCATE` |
| `CHECK (is_system OR balance >= 0)` AND the funds check | `concurrent withdrawals...` |

I could not run these in the authoring environment (no Postgres available there). Run them once and record the outcome in your write-up; edit the table if any expectation is wrong.

## Layout

```
src/ledger.js   the only code that moves money (read this first)
src/routes.js   endpoints + role checks         src/auth.js  passwords, tokens, middleware
src/app.js      express wiring, error handling  db/schema.sql tables, constraints, triggers
db/seed.js      demo data via the ledger        test/        concurrency, retry, authz, integrity, tamper
public/         frontend                        docs/API.md  endpoint reference
```

See also: `docs/API.md`, `THREATS.md`, `PROMPTS.md`, `WRITEUP.md`.
