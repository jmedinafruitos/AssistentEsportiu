import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { Pool } from "pg";
import { z } from "zod";

const env = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3000),
}).parse(process.env);

const app = Fastify({ logger: true });
const db = new Pool({ connectionString: env.DATABASE_URL });

await app.register(cors, { origin: false });
await app.register(jwt, { secret: env.JWT_SECRET });

app.get("/health", async () => {
  await db.query("SELECT 1");
  return { status: "ok" };
});

app.get("/v1/me", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const identity = request.user as { sub: string };
  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.sport_role, u.global_access,
       COALESCE((
         SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'season', t.season) ORDER BY t.name)
         FROM teams t
         WHERE t.active = true
           AND (u.global_access OR EXISTS (
             SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
           ))
       ), '[]') AS teams
     FROM users u
     WHERE u.id = $1 AND u.active = true`,
    [identity.sub],
  );
  if (!result.rowCount) return replyNotFound();
  return result.rows[0];
});

const replyNotFound = () => ({ message: "User not found" });

app.get("/v1/teams", { onRequest: [async (request) => request.jwtVerify()] }, async (request) => {
  const identity = request.user as { sub: string };
  const result = await db.query(
    `SELECT t.id, t.name, t.season, c.name AS category
     FROM users u
     JOIN teams t ON t.active = true
       AND (u.global_access OR EXISTS (
         SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
       ))
     JOIN categories c ON c.id = t.category_id
     WHERE u.id = $1 AND u.active = true
     ORDER BY t.name`,
    [identity.sub],
  );
  return { teams: result.rows };
});

app.get("/v1/teams/:teamId", { onRequest: [async (request) => request.jwtVerify()] }, async (request, reply) => {
  const identity = request.user as { sub: string };
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const result = await db.query(
    `SELECT t.id, t.name, t.season, c.name AS category
     FROM users u
     JOIN teams t ON t.id = $2 AND t.active = true
       AND (u.global_access OR EXISTS (
         SELECT 1 FROM team_assignments ta WHERE ta.user_id = u.id AND ta.team_id = t.id
       ))
     JOIN categories c ON c.id = t.category_id
     WHERE u.id = $1 AND u.active = true`,
    [identity.sub, teamId],
  );
  if (!result.rowCount) return reply.code(403).send({ message: "Forbidden" });
  return result.rows[0];
});

app.post("/v1/session", async (request, reply) => {
  const body = z.object({ email: z.string().email() }).parse(request.body);
  const result = await db.query("SELECT id, role FROM users WHERE email = $1 AND active = true", [body.email]);
  if (!result.rowCount) return reply.code(401).send({ message: "Unauthorized" });
  const user = result.rows[0] as { id: string; role: string };
  return { token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: "12h" }) };
});

const shutdown = async () => {
  await db.end();
  await app.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
