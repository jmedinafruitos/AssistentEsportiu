-- JME-56: onboarding via a fixed temporary password (TEMP_LOGIN_PASSWORD).
-- true means the user is still logging in on the temporary password and
-- must set their own before using the app.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
