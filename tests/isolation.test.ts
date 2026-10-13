// =============================================================================
// tests/isolation.test.ts
//
// Proves the whole point of this repo: with RLS in force, one tenant CANNOT
// read or write another tenant's rows -- the database blocks it, regardless of
// what the query says.
//
// Runs against a REAL PostgreSQL via DATABASE_URL (default: the docker-compose
// instance). If no database is reachable, the suite SKIPS with a clear message
// instead of hanging or hard-failing:
//
//     npm run db:up      # start Postgres 16 in Docker + migrate + seed
//     npm test
//
// Why not pg-mem (zero-setup, in-memory)? pg-mem does not implement RLS
// (CREATE POLICY / ENABLE ROW LEVEL SECURITY) and has no role/privilege model.
// RLS enforcement is defined in terms of roles and the superuser/owner bypass,
// so it cannot be demonstrated faithfully there. See the README.
// =============================================================================

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { APP_ROLE, DEFAULT_DATABASE_URL, redactUrl, setTenantContext } from "../lib/db";

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(join(here, "../db/migrations/001_init.sql"), "utf8");

const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const SKIP_MESSAGE =
  `No PostgreSQL reachable at ${redactUrl(DATABASE_URL)}. ` +
  "Set DATABASE_URL to a running Postgres, or run `npm run db:up` (Docker). " +
  "Skipping RLS isolation tests.";

async function canConnect(): Promise<boolean> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

test("cross-tenant isolation is enforced by RLS", async (t) => {
  // Fail-soft when there is no DB: skip cleanly, never hang or hard-fail.
  if (!(await canConnect())) {
    t.skip(SKIP_MESSAGE);
    return;
  }

  // Two throwaway tenants with random ids, so repeated runs never collide.
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  // Admin connection: used for migration + fixtures. The connection role here
  // (the docker `postgres` superuser) BYPASSES RLS, which is precisely why the
  // tenant-scoped assertions below first `SET LOCAL ROLE app_user`.
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();

  // Helper: run a block as `app_user` with a given tenant, inside a tx that is
  // always rolled back (so writes don't persist and SET LOCAL state is reset).
  async function asTenant<T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await admin.query("BEGIN");
    try {
      await setTenantContext(admin, tenantId);
      return await fn();
    } finally {
      await admin.query("ROLLBACK");
    }
  }

  try {
    // ---- schema + fixtures (as admin / superuser, RLS bypassed) -----------
    await admin.query(migrationSql); // idempotent

    await admin.query(
      "INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)",
      [tenantA, "Tenant A (test)", tenantB, "Tenant B (test)"],
    );
    const aRows = (
      await admin.query(
        "INSERT INTO projects (tenant_id, name) VALUES ($1,$2),($1,$3) RETURNING id",
        [tenantA, "A-1", "A-2"],
      )
    ).rows as { id: string }[];
    const bRows = (
      await admin.query(
        "INSERT INTO projects (tenant_id, name) VALUES ($1,$2),($1,$3) RETURNING id",
        [tenantB, "B-1", "B-2"],
      )
    ).rows as { id: string }[];
    await admin.query(
      "INSERT INTO users (tenant_id, email) VALUES ($1,$2),($3,$4)",
      [tenantA, "a@a.test", tenantB, "b@b.test"],
    );

    const aProjectId = aRows[0]!.id;
    const bProjectId = bRows[0]!.id;

    // ---- SELECT: each tenant sees only its own rows -----------------------
    await t.test("tenant A sees only tenant A projects", async () => {
      const rows = await asTenant(tenantA, async () => {
        return (await admin.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM projects",
        )).rows;
      });
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.tenant_id === tenantA));
    });

    await t.test("tenant B sees only tenant B projects", async () => {
      const rows = await asTenant(tenantB, async () => {
        return (await admin.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM projects",
        )).rows;
      });
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.tenant_id === tenantB));
    });

    // ---- SELECT by primary key still cannot cross the boundary ------------
    await t.test("tenant A cannot read a tenant B row even by its id", async () => {
      const rows = await asTenant(tenantA, async () => {
        return (await admin.query("SELECT id FROM projects WHERE id = $1", [
          bProjectId,
        ])).rows;
      });
      assert.equal(rows.length, 0);
    });

    // ---- fail-closed: no tenant set => nothing visible --------------------
    await t.test("with no tenant set, no rows are visible (fail-closed)", async () => {
      await admin.query("BEGIN");
      try {
        await admin.query(`SET LOCAL ROLE ${APP_ROLE}`); // note: no tenant GUC
        const rows = (await admin.query("SELECT id FROM projects")).rows;
        assert.equal(rows.length, 0);
      } finally {
        await admin.query("ROLLBACK");
      }
    });

    // ---- INSERT is constrained by WITH CHECK ------------------------------
    await t.test("tenant A cannot INSERT a row for tenant B", async () => {
      await assert.rejects(
        asTenant(tenantA, async () => {
          await admin.query(
            "INSERT INTO projects (tenant_id, name) VALUES ($1, $2)",
            [tenantB, "injected-by-A"],
          );
        }),
        /row-level security/i,
      );
    });

    await t.test("tenant A can INSERT a row for itself", async () => {
      const rows = await asTenant(tenantA, async () => {
        return (await admin.query(
          "INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING id",
          [tenantA, "legit-A"],
        )).rows;
      });
      assert.equal(rows.length, 1);
    });

    // ---- UPDATE cannot reach across tenants -------------------------------
    await t.test("tenant A cannot UPDATE a tenant B row (0 rows affected)", async () => {
      const rowCount = await asTenant(tenantA, async () => {
        const res = await admin.query(
          "UPDATE projects SET name = $1 WHERE id = $2",
          ["hijacked", bProjectId],
        );
        return res.rowCount;
      });
      assert.equal(rowCount, 0);
    });

    await t.test("tenant A cannot reassign its own row to tenant B", async () => {
      await assert.rejects(
        asTenant(tenantA, async () => {
          await admin.query("UPDATE projects SET tenant_id = $1 WHERE id = $2", [
            tenantB,
            aProjectId,
          ]);
        }),
        /row-level security/i,
      );
    });

    // ---- DELETE cannot reach across tenants -------------------------------
    await t.test("tenant A cannot DELETE a tenant B row (0 rows affected)", async () => {
      const rowCount = await asTenant(tenantA, async () => {
        const res = await admin.query("DELETE FROM projects WHERE id = $1", [
          bProjectId,
        ]);
        return res.rowCount;
      });
      assert.equal(rowCount, 0);
      // And confirm tenant B's row is still there (seen from B's context).
      const stillThere = await asTenant(tenantB, async () => {
        return (await admin.query("SELECT id FROM projects WHERE id = $1", [
          bProjectId,
        ])).rows;
      });
      assert.equal(stillThere.length, 1);
    });

    // ---- the same policy pattern protects every tenant-scoped table -------
    await t.test("the users table is isolated the same way", async () => {
      const rows = await asTenant(tenantA, async () => {
        return (await admin.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM users",
        )).rows;
      });
      assert.equal(rows.length, 1);
      assert.ok(rows.every((r) => r.tenant_id === tenantA));
    });
  } finally {
    // Clean up fixtures (ON DELETE CASCADE removes the child rows too).
    try {
      await admin.query("DELETE FROM tenants WHERE id = ANY($1)", [
        [tenantA, tenantB],
      ]);
    } catch {
      /* ignore cleanup errors */
    }
    await admin.end();
  }
});
