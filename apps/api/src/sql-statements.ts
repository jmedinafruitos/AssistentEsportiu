export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      current += character;
      if (character === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      current += character;
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && !dollarTag && character === "-" && next === "-") {
      current += character + next;
      index += 1;
      lineComment = true;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && !dollarTag && character === "/" && next === "*") {
      current += character + next;
      index += 1;
      blockComment = true;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && character === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        if (!dollarTag) {
          dollarTag = match[0];
        } else if (dollarTag === match[0]) {
          dollarTag = null;
        }
        current += match[0];
        index += match[0].length - 1;
        continue;
      }
    }

    if (!dollarTag && !doubleQuoted && character === "'") {
      current += character;
      if (singleQuoted && next === "'") {
        current += next;
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }

    if (!dollarTag && !singleQuoted && character === '"') {
      current += character;
      if (doubleQuoted && next === '"') {
        current += next;
        index += 1;
      } else {
        doubleQuoted = !doubleQuoted;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && !dollarTag && character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (singleQuoted || doubleQuoted || dollarTag || blockComment) {
    throw new Error("Unterminated SQL construct in migration");
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
