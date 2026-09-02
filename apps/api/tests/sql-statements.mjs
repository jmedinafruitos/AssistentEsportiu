import assert from "node:assert/strict";
import test from "node:test";
import { splitSqlStatements } from "../dist/sql-statements.js";

test("splits statements while preserving semicolons in strings and dollar blocks", () => {
  const sql = `
    CREATE TABLE sample (value text);
    INSERT INTO sample VALUES ('one;two');
    DO $$ BEGIN
      PERFORM 1;
    END $$;
  `;

  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 3);
  assert.match(statements[1], /one;two/);
  assert.match(statements[2], /PERFORM 1;/);
});

test("ignores semicolons in comments", () => {
  const statements = splitSqlStatements("-- first; comment\nSELECT 1; /* second; comment */ SELECT 2;");
  assert.equal(statements.length, 2);
});
