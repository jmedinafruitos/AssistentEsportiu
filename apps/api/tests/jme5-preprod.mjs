import assert from "node:assert/strict";

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function authenticate(email) {
  const { response, body } = await request("/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(response.status, 200, `session failed for ${email}`);
  return body.token;
}

const adminToken = await authenticate("jordi@medina.cat");
const coachToken = await authenticate("bielcordon@gmail.com");

const adminResult = await request("/v1/strategy-contexts", {
  headers: { authorization: `Bearer ${adminToken}` },
});
assert.equal(adminResult.response.status, 200);
assert.ok(adminResult.body.contexts.length >= 8, "admin must see all active contexts");

const coachResult = await request("/v1/strategy-contexts", {
  headers: { authorization: `Bearer ${coachToken}` },
});
assert.equal(coachResult.response.status, 200);
assert.ok(coachResult.body.contexts.some((context) => context.scope === "club"));
assert.ok(coachResult.body.contexts.some((context) => context.category === "Prebenjamín"));
assert.ok(coachResult.body.contexts.every((context) =>
  context.scope === "club" || context.category === "Prebenjamín" || context.team === "Prebenjamín"
), "coach must only receive applicable strategy context");

const teamResult = await request("/v1/teams", {
  headers: { authorization: `Bearer ${coachToken}` },
});
const assignedTeam = teamResult.body.teams[0];
const resolvedResult = await request(`/v1/teams/${assignedTeam.id}/context`, {
  headers: { authorization: `Bearer ${coachToken}` },
});
assert.equal(resolvedResult.response.status, 200);
assert.ok(resolvedResult.body.contexts.some((context) => context.scope === "club"));
assert.ok(resolvedResult.body.contexts.some((context) => context.scope === "category"));

const clubContext = coachResult.body.contexts.find((context) => context.scope === "club");
const forbiddenUpdate = await request(`/v1/strategy-contexts/${clubContext.id}`, {
  method: "PATCH",
  headers: { authorization: `Bearer ${coachToken}`, "content-type": "application/json" },
  body: JSON.stringify({ content: clubContext.content, version: clubContext.version, confirm: true }),
});
assert.equal(forbiddenUpdate.response.status, 403, "coach must not update strategy context");

console.log("JME-5 preproduction strategy-context checks passed");
