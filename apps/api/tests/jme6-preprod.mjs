import assert from "node:assert/strict";

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
const passwords = JSON.parse(process.env.TEST_ACCOUNT_PASSWORDS ?? "{}");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function authenticate(email) {
  const password = passwords[email];
  if (!password) throw new Error(`Missing password for ${email} in TEST_ACCOUNT_PASSWORDS`);
  const { response, body } = await request("/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, `session failed for ${email}`);
  assert.equal(typeof body.token, "string");
  return body.token;
}

async function authorizedTeams(token) {
  const { response, body } = await request("/v1/teams", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return body.teams;
}

const adminToken = await authenticate("jordi@medina.cat");
const adminTeams = await authorizedTeams(adminToken);
assert.equal(adminTeams.length, 8, "club_admin must see every preproduction team");

const expectedScopes = new Map([
  ["mennalopez1@gmail.com", ["Benjamín"]],
  ["bielcordon@gmail.com", ["Prebenjamín"]],
  ["keisahcsentmenat@gmail.com", ["Escoleta Iniciació"]],
  ["pratssolejoan@gmail.com", ["FEM13", "FEM15"]],
  ["jcarlospr04@gmail.com", ["Alevín", "Infantil A", "Infantil B"]],
]);

for (const [email, expectedNames] of expectedScopes) {
  const token = await authenticate(email);
  const teams = await authorizedTeams(token);
  assert.deepEqual(teams.map((team) => team.name).sort(), expectedNames.sort(), `${email} team scope`);

  const forbiddenTeam = adminTeams.find((team) => !expectedNames.includes(team.name));
  assert.ok(forbiddenTeam);
  const { response } = await request(`/v1/teams/${forbiddenTeam.id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 403, `${email} must not access ${forbiddenTeam.name}`);
}

console.log("JME-6 preproduction authorization checks passed");
