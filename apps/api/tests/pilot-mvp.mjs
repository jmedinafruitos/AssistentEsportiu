import assert from "node:assert/strict";

const baseUrl = process.env.PILOT_API_URL?.replace(/\/$/, "");
const email = process.env.PILOT_EMAIL;
const password = process.env.PILOT_PASSWORD;
if (!baseUrl || !email || !password) throw new Error("Set PILOT_API_URL, PILOT_EMAIL and PILOT_PASSWORD");

async function request(path, options = {}, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

const health = await request("/health");
assert.equal(health.status, "ok");
const session = await request("/v1/session", { method: "POST", body: JSON.stringify({ email, password }) });
const me = await request("/v1/me", {}, session.token);
const { teams } = await request("/v1/teams", {}, session.token);
assert.ok(teams.length, "Pilot user needs at least one authorized team");
const team = teams.find((candidate) => candidate.name === process.env.PILOT_TEAM) ?? teams[0];

await request(`/v1/teams/${team.id}/plan`, {}, session.token);
await request(`/v1/teams/${team.id}/records`, {}, session.token);
await request(`/v1/teams/${team.id}/assistant-results`, {}, session.token);

if (process.env.PILOT_CONFIRM_WRITES === "yes") {
  await request(`/v1/teams/${team.id}/records`, {
    method: "POST",
    body: JSON.stringify({
      type: "training", happenedAt: new Date().toISOString(),
      summary: "Validació pilot automatitzada del registre de sessió",
      outcome: "Flux completat", nextObjectives: ["Revisió manual per coordinació"],
    }),
  }, session.token);
}

if (me.global_access) await request("/v1/coordinator/overview", {}, session.token);
console.log(JSON.stringify({ status: "ok", user: me.email, team: team.name, writes: process.env.PILOT_CONFIRM_WRITES === "yes" }));
