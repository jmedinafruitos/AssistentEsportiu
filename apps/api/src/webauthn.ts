import { Queryable } from "./db.js";

// A WebAuthn RP ID must be the exact hostname the PWA is served from (no
// scheme, no port) and stays fixed for the life of every registered
// passkey — changing it invalidates every credential. JME-17 already
// validated app.sentmenat.cat end-to-end, so production always resolves
// there; the localhost fallback only matters for local `npm run dev`.
export function resolveRpConfig(webOrigin: string | undefined) {
  const origin = webOrigin ?? "http://localhost:5173";
  return { rpName: "Assistent Esportiu", rpID: new URL(origin).hostname, origin };
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function storeChallenge(
  db: Queryable,
  challenge: string,
  purpose: "register" | "login",
  userId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at)
     VALUES ($1, $2, $3, now() + interval '5 minutes')`,
    [userId, challenge, purpose],
  );
}

// Consumes (deletes) the most recent unexpired challenge for this user and
// purpose — single-use by construction, since it's gone whether or not the
// caller goes on to verify successfully.
export async function consumeChallenge(
  db: Queryable,
  userId: string,
  purpose: "register" | "login",
): Promise<string | null> {
  const result = await db.query(
    `DELETE FROM webauthn_challenges
     WHERE id = (
       SELECT id FROM webauthn_challenges
       WHERE user_id = $1 AND purpose = $2 AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1
     )
     RETURNING challenge`,
    [userId, purpose],
  );
  return result.rowCount ? (result.rows[0] as { challenge: string }).challenge : null;
}

export async function pruneExpiredChallenges(db: Queryable): Promise<void> {
  await db.query("DELETE FROM webauthn_challenges WHERE expires_at <= now()");
}

export { CHALLENGE_TTL_MS };
