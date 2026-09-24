import pg from "pg";
import { config } from "../config.js";

// BIGINT (oid 20) arrives as a string by default; every bigint column here is an
// epoch-millis or byte count that fits in a JS number.
pg.types.setTypeParser(20, (value: string) => Number(value));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("[db] idle client error", err);
});
