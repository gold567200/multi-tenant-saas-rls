// =============================================================================
// lib/db.ts  --  The one place tenant context is bound to a DB connection.
//
// `withTenant()` opens a transaction, drops the connection down to the
// non-privileged `app_user` role, sets the `app.current_tenant` GUC that the
// RLS policies read, runs your callback, then commits. Because every statement
// inside the callback runs under that role + GUC, Postgres itself guarantees
// the callback can only touch the current tenant's rows.
// =============================================================================

import { Pool, type Client, type PoolClient } from "pg";

/** Non-privileged role the app runs tenant queries as (see the SQL migration). */
export const APP_ROLE = "app_user";

/** The session setting (GUC) the RLS policies key off. */
export const TENANT_GUC = "app.current_tenant";

/** Used by the app, the setup script, and the test when DATABASE_URL is unset. */
export const DEFAULT_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/app";

/** Hides the password when a connection string is printed in a log/message. */
export function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:@/]+):[^@/]*@/, "://$1:***@");
}

type AnyPgClient = Client | PoolClient;

// Basic guard so a malformed tenant id becomes a clean error instead of a
// confusing "invalid input syntax for type uuid" from deep inside a policy.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Bind the current tenant to a DB session.
 *
 *  1. `SET LOCAL ROLE app_user` drops any privileged connection down to the
 *     restricted role. RLS is bypassed for superusers and table owners, so
 *     this step is what makes the policies actually apply.
 *  2. `set_config(..., true)` sets the `app.current_tenant` GUC that every RLS
 *     policy compares `tenant_id` against. It is parameterised, so the tenant
 *     id can never be interpolated into SQL.
 *
 * Both use the transaction-local (`LOCAL` / is_local = true) form, so they are
 * automatically reset on COMMIT/ROLLBACK. That is what makes this safe on a
 * pooled connection: the tenant context cannot leak to the next request that
 * happens to reuse the same physical connection.
 */
export async function setTenantContext(
  client: AnyPgClient,
  tenantId: string,
): Promise<void> {
  if (!isUuid(tenantId)) {
    throw new Error(`Invalid tenant id: ${JSON.stringify(tenantId)}`);
  }
  // APP_ROLE is a trusted constant (not user input), so inlining it is safe;
  // role names cannot be bound as query parameters.
  await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await client.query(`SELECT set_config($1, $2, true)`, [TENANT_GUC, tenantId]);
}

// ---------------------------------------------------------------------------
// App-facing pool + helper
// ---------------------------------------------------------------------------

let pool: Pool | undefined;

/** Lazily-created singleton pool (so importing this module needs no DB). */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    });
  }
  return pool;
}

/**
 * Run `fn` inside a transaction scoped to a single tenant.
 *
 * Every query issued through the client passed to `fn` is subject to the RLS
 * policies for `tenantId` -- reads see only that tenant's rows, and writes that
 * would touch another tenant are rejected by the database.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // ===================================================================
    // PER-REQUEST TENANT CONTEXT IS SET HERE.
    // In a real app `tenantId` comes from the authenticated session
    // (a JWT claim, a signed cookie, the request subdomain) -- never from
    // user-controlled input.
    // ===================================================================
    await setTenantContext(client, tenantId);

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
