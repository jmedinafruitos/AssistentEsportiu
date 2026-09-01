import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { splitSqlStatements } from "./sql-statements.js";

const env = z.object({ DATABASE_URL: z.string().url() }).parse(process.env);
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const db = new Pool({ connectionString: env.DATABASE_URL, max: 1 });

try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d+.*\.sql$/.test(filename))
    .sort((left, right) => left.localeCompare(right));

  for (const filename of files) {
    const applied = await db.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename],
    );
    if (applied.rowCount) continue;

    const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
    for (const statement of splitSqlStatements(sql)) {
      await db.query(statement);
    }
    await db.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    console.log(JSON.stringify({ event: "migration_applied", filename }));
  }
} finally {
  await db.end();
}
