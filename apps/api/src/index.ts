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
    `SELECT u.id, u.name, u.email, u.role, COALESCE(json_agg(t.name) FILTER (WHERE t.id IS NOT NULL), '[]') AS teams
     FROM users u
     LEFT JOIN team_assignments ta ON ta.user_id = u.id
     LEFT JOIN teams t ON t.id = ta.team_id
     WHERE u.id = $1
     GROUP BY u.id`,
    [identity.sub],
  );
  if (!result.rowCount) return { message: "User not found" };
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
