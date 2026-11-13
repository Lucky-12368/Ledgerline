-- LedgerLine schema. All money is BIGINT paise (1 rupee = 100 paise). No floats anywhere.
-- Model: double-entry. Every posted transaction has exactly two signed legs (entries) summing to zero.
-- Deposits/withdrawals use the single system account EXTERNAL as the counter-leg, so
--   SUM(entries.amount) over the whole ledger is always 0, and
--   SUM(balances of real accounts) = posted deposits - posted withdrawals.

CREATE TYPE user_role AS ENUM ('admin', 'holder', 'auditor');

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  is_system  BOOLEAN NOT NULL DEFAULT false,
  balance    BIGINT NOT NULL DEFAULT 0,           -- cache of SUM(entries); reconciled by /api/reconciliation
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  last_seq   BIGINT NOT NULL DEFAULT 0,           -- per-account entry counter (hash chain head)
  last_hash  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No overdraft: enforced by the database even if application code is wrong.
  CONSTRAINT no_overdraft CHECK (is_system OR balance >= 0)
);
CREATE UNIQUE INDEX one_system_account ON accounts (is_system) WHERE is_system;
INSERT INTO accounts (name, is_system) VALUES ('EXTERNAL', true);

-- Who may debit an account (holders only).
CREATE TABLE account_members (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  user_id    BIGINT NOT NULL REFERENCES users(id),
  PRIMARY KEY (account_id, user_id)
);

-- One row per attempt that reached the ledger: posted or refused. Append-only.
CREATE TABLE transactions (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'transfer')),
  status          TEXT NOT NULL CHECK (status IN ('posted', 'refused')),
  refusal_reason  TEXT,
  amount          BIGINT NOT NULL CHECK (amount > 0),
  from_account    BIGINT REFERENCES accounts(id),
  to_account      BIGINT REFERENCES accounts(id),
  initiated_by    BIGINT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Exactly-once backstop: the same actor+key can exist only once, whatever the application does.
  CONSTRAINT uq_txn_idem UNIQUE (initiated_by, idempotency_key),
  CONSTRAINT refusal_has_reason CHECK ((status = 'refused') = (refusal_reason IS NOT NULL)),
  CONSTRAINT shape_matches_kind CHECK (
    (kind = 'deposit'    AND from_account IS NULL     AND to_account IS NOT NULL) OR
    (kind = 'withdrawal' AND from_account IS NOT NULL AND to_account IS NULL) OR
    (kind = 'transfer'   AND from_account IS NOT NULL AND to_account IS NOT NULL AND from_account <> to_account)
  )
);

-- Signed legs: +credit / -debit. Only posted transactions have entries. Append-only, hash-chained per account.
CREATE TABLE entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id),
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  amount         BIGINT NOT NULL CHECK (amount <> 0),
  balance_after  BIGINT NOT NULL,
  seq            BIGINT NOT NULL CHECK (seq >= 1),
  prev_hash      TEXT,
  row_hash       TEXT NOT NULL,
  CONSTRAINT uq_entry_seq UNIQUE (account_id, seq),
  CONSTRAINT uq_entry_leg UNIQUE (transaction_id, account_id)
);
CREATE INDEX entries_txn_idx ON entries (transaction_id);

-- Every time the idempotency layer answered a request from a stored result.
CREATE TABLE idempotency_hits (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id),
  request_id     TEXT NOT NULL,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Logins, admin actions, authorisation denials, review flags.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement: no UPDATE, DELETE or TRUNCATE on ledger tables.
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['transactions', 'entries', 'idempotency_hits', 'audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',
                   t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Conservation, checked at COMMIT: every transaction that has entries must be 'posted',
-- have exactly two legs, and the legs must sum to zero. A half-written posting cannot commit.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_posting_ok() RETURNS trigger AS $$
DECLARE n INT; s BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM transactions WHERE id = NEW.transaction_id AND status = 'posted') THEN
    RAISE EXCEPTION 'entries may only belong to a posted transaction (txn %)', NEW.transaction_id;
  END IF;
  SELECT count(*), COALESCE(sum(amount), 0) INTO n, s FROM entries WHERE transaction_id = NEW.transaction_id;
  IF n <> 2 OR s <> 0 THEN
    RAISE EXCEPTION 'transaction % must have exactly 2 legs summing to zero (has %, sum %)', NEW.transaction_id, n, s;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_posting_ok
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_posting_ok();
