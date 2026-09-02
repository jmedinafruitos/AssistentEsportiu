-- JME-18: replace passwordless login with a password credential.
-- Nullable on purpose: existing users have no password yet. /v1/session
-- rejects login for any account where password_hash is still null, so
-- there is no window where the old email-only login keeps working.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;
