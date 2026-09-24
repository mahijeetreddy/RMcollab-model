import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

// Resolved for both `tsx src/...` and `node dist/...`; the compiler does not
// copy .sql, so fall back to the source tree.
const candidates = [
  new URL("./schema.sql", import.meta.url),
  new URL("../../src/db/schema.sql", import.meta.url),
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadSchema(): Promise<string> {
  for (const candidate of candidates) {
    try {
      return await readFile(fileURLToPath(candidate), "utf8");
    } catch {
      continue;
    }
  }
  throw new Error("schema.sql not found");
}

export async function migrate(attempts = 10, delayMs = 1500): Promise<void> {
  const schema = await loadSchema();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query(schema);
      console.log("[db] schema applied");
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.warn(`[db] migrate attempt ${attempt}/${attempts} failed, retrying`);
      await sleep(delayMs);
    }
  }
}
