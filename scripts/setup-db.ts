// =============================================================================
// scripts/setup-db.ts  --  Wait for Postgres, apply the migration, seed demo data.
//
// Used by `npm run db:setup` and (after `docker compose up -d`) by `npm run db:up`.
// Safe to run repeatedly: the migration and seed are both idempotent.
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { DEFAULT_DATABASE_URL, redactUrl } from "../lib/db";

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, "../db/migrations/001_init.sql"),
  "utf8",
);
const seedSql = readFileSync(join(here, "../db/seed.sql"), "utf8");

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

async function waitForDb(maxMs = 30_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < maxMs) {
    const client = new Client({
      connectionString: url,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.end();
      } catch {
        /* ignore */
      }
      await sleep(1_000);
    }
  }
  throw new Error(
    `PostgreSQL never became ready at ${redactUrl(url)} within ${maxMs}ms: ${String(lastErr)}`,
  );
}

async function main(): Promise<void> {
  console.log(`Waiting for PostgreSQL at ${redactUrl(url)} ...`);
  await waitForDb();

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    console.log("Applying migration db/migrations/001_init.sql ...");
    await client.query(migrationSql);
    console.log("Seeding demo data db/seed.sql ...");
    await client.query(seedSql);
    console.log("Database ready.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
