// Sets (or resets) one user's login password. There is no self-service
// reset flow yet (JME-18 is a minimal fix, not the full auth system), so
// this is run manually by an admin against the target database.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/set-password.mjs someone@example.com
//
// The generated password is printed ONCE. It is never logged or stored
// anywhere except as a bcrypt hash in the database — copy it immediately
// and share it with the user out-of-band (not email, not Slack/WhatsApp
// in plaintext if avoidable).
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool } from "pg";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/set-password.mjs <email>");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL to the target database.");
  process.exit(1);
}

function generatePassword() {
  return randomBytes(18).toString("base64url");
}

const password = process.env.PASSWORD || generatePassword();
const passwordHash = await bcrypt.hash(password, 12);

const db = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const result = await db.query(
    "UPDATE users SET password_hash = $2 WHERE email = $1 AND active = true RETURNING id",
    [email, passwordHash],
  );
  if (!result.rowCount) {
    console.error(`No active user found for ${email}`);
    process.exit(1);
  }
  console.log(`Password set for ${email}. Share this value once, then discard it:`);
  console.log(password);
} finally {
  await db.end();
}
