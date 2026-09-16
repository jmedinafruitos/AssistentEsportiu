-- JME-43: WebAuthn/passkey biometric login (Face ID / Touch ID / empremta)
-- as an alternative to the password login from JME-18. Password stays as
-- the fallback for devices/browsers without a registered passkey.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL,
  public_key BYTEA NOT NULL,
  sign_count BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials (user_id);

-- Single-use, short-lived challenges for both ceremonies. user_id is null
-- for a login challenge issued against an email the server won't confirm
-- exists (see /v1/webauthn/login/options) — same anti-enumeration spirit
-- as the DUMMY_PASSWORD_HASH comparison already used by /v1/session.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_idx ON webauthn_challenges (expires_at);
