-- OPTIONAL hardening (run as the database owner, e.g. psql -v app_password="'...'" -f db/roles.sql).
-- Gives the web app a role that physically cannot rewrite history or change schema/triggers,
-- even if the application is compromised. Point DATABASE_URL at this role for the running service;
-- keep the owner role only for migrate/seed.
CREATE ROLE ledgerline_app LOGIN PASSWORD :app_password;
GRANT USAGE ON SCHEMA public TO ledgerline_app;
GRANT SELECT, INSERT ON users, account_members, accounts, transactions, entries, idempotency_hits, audit_log TO ledgerline_app;
GRANT UPDATE (balance, last_seq, last_hash, status) ON accounts TO ledgerline_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ledgerline_app;
