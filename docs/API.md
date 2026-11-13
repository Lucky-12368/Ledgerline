# API reference

Base path `/api`. JSON in and out. Auth: `Authorization: Bearer <token>` from `POST /auth/login`. Amounts are **integer paise as strings** (`"250000"` = Rs 2,500.00). Balances and ids are returned as strings.

Errors: `{ "error": { "code", "message", "requestId" } }`. Every response carries `X-Request-Id`.

Money endpoints require `Idempotency-Key` (8-128 chars of `A-Za-z0-9_.:-`). Keys are scoped per user and remembered forever (stored on the append-only transaction row). Same key + same body returns the original result with `Idempotent-Replay: true` and moves nothing. Same key + different body returns `422 idempotency_key_reuse`. A business refusal (e.g. insufficient funds) is a recorded outcome; replaying that key returns the same refusal, use a new key to try again.

## Auth
| Endpoint | Who | Effect on money |
|---|---|---|
| `POST /auth/login` `{email,password}` | anyone (10 failures / 15 min / ip+email, per instance) | none |
| `GET /me` | any logged-in user | none |

## Accounts
| Endpoint | Who | Notes |
|---|---|---|
| `GET /accounts` | holder: own accounts; admin/auditor: all incl. EXTERNAL | none |
| `POST /accounts` `{name, ownerEmail?}` | admin | creates a zero-balance account |
| `GET /accounts/:id` | member holder, admin, auditor | 403 for other holders |
| `GET /accounts/:id/statement?limit&before` | member holder, admin, auditor | every debit, credit and refused attempt, with running balance and initiator |
| `POST /accounts/:id/members` `{email}` | admin | grants a holder the right to debit the account |
| `POST /accounts/:id/freeze` / `unfreeze` | admin | frozen accounts refuse all movements; takes the account row lock |

## Money movement (all need `Idempotency-Key`)
| Endpoint | Who | Body | Effect |
|---|---|---|---|
| `POST /deposits` | admin (any account) or member holder (own) | `{accountId, amount}` | credits account, debits EXTERNAL |
| `POST /withdrawals` | member holder only | `{accountId, amount}` | debits account, credits EXTERNAL |
| `POST /transfers` | member holder of the source only | `{fromAccountId, toAccountId, amount}` | debits source, credits destination; nets to zero |

Responses: `201 {transaction}` posted; `422 {error:{code:"refused",reason}, transaction}` refused (`insufficient_funds`, `account_frozen`); `403` not allowed (logged in `audit_log` as `denied`); `404` destination missing or is the system account; `400` invalid input; `503 busy` lock timeout (retry with the same key).

## Oversight (admin and auditor, read-only)
| Endpoint | Returns |
|---|---|
| `GET /reconciliation` | `{ok, problems[], ledgerDigest, checkedEntries}`: ledger sums to zero, each txn has 2 balanced legs, cached balances equal sum of entries, no negatives, balances equal deposits minus withdrawals, hash chains intact |
| `GET /transactions?limit` | latest transactions incl. refused |
| `GET /audit?limit` | logins, failed logins, admin actions, denials, large-amount flags |
| `GET /idempotency-hits?limit` | every request answered from a stored result |

`GET /healthz` (no auth) reports database connectivity.
