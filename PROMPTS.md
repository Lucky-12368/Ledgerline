# PROMPTS.md

> **Read this first.** The brief requires at least five *dated* entries, written as you go, each linking the commit that fixed the problem, with at least two on money-integrity / concurrency / idempotency. Those entries must record **your** real sessions. They cannot be generated for you after the fact, and inventing them would defeat the point of the file. Below are the template and a checklist of mistakes AI tools commonly make in exactly this kind of code. Use the checklist to *review* AI output, and write an entry whenever you genuinely catch one.

## Entry template (copy per entry, newest first)

### YYYY-MM-DD: short title
- **Area:** integrity / concurrency / idempotency / authz / other
- **Asked:** what you asked the tool to do (paste or summarise the prompt)
- **It produced:** what came back
- **What was wrong:** the specific defect and how you found it (test that failed, race you reproduced, code you read)
- **What I did instead:** the fix, in your words
- **Commit:** link

## Entries

_(none yet: add them as you work)_

## Review checklist: things to check in any AI-written money code

1. **Check-then-act without a lock.** `SELECT balance` then `UPDATE` in the same transaction is still a race under READ COMMITTED. Look for `FOR UPDATE`, or a single conditional `UPDATE ... WHERE balance >= $x`.
2. **Locks in inconsistent order** (A then B in one request, B then A in another) -> deadlock. Look for sorted ids.
3. **Idempotency check outside the transaction**, or a "check then insert" with no unique constraint. Two concurrent twins both pass the check. Look for the unique index and for in-flight handling.
4. **Idempotency key not bound to the request body**, so a key can be replayed with a different amount.
5. **Refusals rolled back with the exception**, so the "refused attempt" never reaches the ledger.
6. **Floats or JS `Number` for money**; `parseFloat`; amounts accepted as `"1e3"` or `"0x10"`.
7. **Authorisation only in the UI or only on the route**, not re-checked against the database inside the transaction; role trusted from the token or request body.
8. **Tests that call the endpoint once** and call it a concurrency test. Check that tests use `Promise.all` against real Postgres and that deleting the lock makes them fail (see README mutation table).
9. **Ledger "immutability" by convention only**: no trigger, no privilege revoke.
10. **Retry on 5xx that is not safe** because the operation has no idempotency key.

For each item above you verify in your own code, you can record it as "checked, here is the code and how I tested it" rather than claiming the AI erred. Do not claim the AI made a mistake it did not make.
