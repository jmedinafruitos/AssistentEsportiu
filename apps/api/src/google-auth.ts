import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// Hand-rolled service-account JWT-bearer flow (RFC 7523), shared by every
// Google API this app talks to (Drive — JME-35, Calendar — JME-30). A
// single token exchange ahead of a handful of REST calls doesn't justify
// pulling in the full googleapis SDK.
export async function getGoogleAccessToken(serviceAccountEmail: string, privateKeyPem: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: serviceAccountEmail, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signingInput = `${header}.${claims}`;
  // Render (and most env-var stores) can't hold real newlines, so the key is
  // stored with literal "\n" escapes and unescaped here.
  const privateKey = privateKeyPem.replace(/\\n/g, "\n");
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  const assertion = `${signingInput}.${base64url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GOOGLE_AUTH_ERROR_${response.status}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}
