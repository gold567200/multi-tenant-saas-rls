# Multi-tenant data isolation with PostgreSQL Row-Level Security

A compact, runnable example of the pattern I reach for when building production
multi-tenant SaaS: **enforce "one tenant can never read or write another
tenant's data" at the database layer, with PostgreSQL Row-Level Security (RLS)**
— not only in application code.

> This is an illustrative reference implementation, not a specific deployed or
> client system. It exists to show the technique clearly and to prove it works.

A thin Next.js + TypeScript surface sits on top so you can see where per-request
tenant context is bound to the connection, but the interesting part is the
database: `db/migrations/001_init.sql` and the isolation test in
`tests/isolation.test.ts`.

---

## The threat: cross-tenant data leak

In a multi-tenant app, every tenant's rows live in the same tables, told apart
by a `tenant_id` column. The isolation therefore depends on **every single
query** remembering to add `WHERE tenant_id = $currentTenant`.

Miss it once — a new endpoint, a background job, a reporting query, an ORM
association that loads "all" of something, a raw SQL string — and you serve one
customer another customer's data. This is one of the most common *serious* SaaS
bugs, and it fails open: the happy path looks perfect in the demo while the leak
sits quietly in the one query someone forgot.

App-level checks are necessary but they are a single layer, and the layer is
"did the developer remember, in this exact code path, every time, forever."

## The approach: push the rule into the database

RLS lets PostgreSQL apply a mandatory filter to a table on **every** statement,
no matter what SQL reached it. We:

1. Tag each tenant-scoped row with `tenant_id`.
2. Store the current tenant for the connection in a session setting (a GUC),
   `app.current_tenant`.
3. Enable RLS and attach policies that compare `tenant_id` to that setting, for
   `SELECT`, `INSERT`, `UPDATE`, and `DELETE`.

Now a query like `SELECT * FROM projects` returns only the current tenant's
rows **because the database rewrites it to**, and an
`INSERT ... (tenant_id = <someone else>)` is rejected by the database. The
application can forget the `WHERE` clause and the data still can't leak. That is
defense in depth: the app check is the first line, RLS is the backstop that is
on by default and can't be forgotten.

```sql
-- the predicate every policy shares (see db/migrations/001_init.sql)
tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
```

`current_setting(..., true)` returns `NULL` when the tenant was never set, so an
unset context matches **no rows** — the system **fails closed**: forget to set
the tenant and you see nothing, rather than everything.

---

## What's in here

```
multi-tenant-saas-rls/
├── db/
│   ├── migrations/
│   │   └── 001_init.sql       # schema + RLS policies (SELECT/INSERT/UPDATE/DELETE), idempotent
│   └── seed.sql               # two demo tenants + their projects/users
├── lib/
│   └── db.ts                  # getPool + withTenant(): THE place tenant context is set on the connection
├── app/
│   ├── layout.tsx
│   ├── page.tsx               # lists ONLY the current tenant's projects
│   └── api/projects/route.ts  # GET /api/projects?tenant=<uuid>
├── scripts/
│   └── setup-db.ts            # waits for Postgres, applies the migration, seeds (npm run db:setup)
├── tests/
│   └── isolation.test.ts      # proves cross-tenant reads/writes are blocked; SKIPS cleanly with no DB
├── docker-compose.yml         # Postgres 16
├── .env.example               # DATABASE_URL
└── package.json
```

### How tenant context is set (the one spot that matters)

`lib/db.ts` → `withTenant()` opens a transaction and, per request, binds the
tenant to the connection:

```ts
await client.query("BEGIN");
// drop from the privileged connection role down to the non-privileged app role,
// then set the GUC the RLS policies read — both transaction-local, so they
// auto-reset on COMMIT/ROLLBACK and never leak across pooled connections.
await client.query(`SET LOCAL ROLE app_user`);
await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
// ...your queries here run under RLS for exactly this tenant...
await client.query("COMMIT");
```

Two details that make this correct rather than just plausible:

- **`SET LOCAL ROLE app_user`** — RLS is **bypassed for superusers and the table
  owner**. If your app connects as a superuser (the default `postgres` user
  does), policies silently do nothing. Dropping to a non-privileged role is what
  makes enforcement real. `ALTER TABLE ... FORCE ROW LEVEL SECURITY` in the
  migration additionally subjects the table owner to policies.
- **`SET LOCAL` / `set_config(..., true)`** — both are transaction-scoped, so a
  pooled physical connection can't carry one request's tenant into the next.

---

## Run it

Requires Node 20+ (developed on Node 24). PostgreSQL 13+ (the compose file uses
16).

```bash
npm install
```

### Option A — Docker (one-liner)

Brings up Postgres 16, applies the migration, and seeds demo data:

```bash
npm run db:up      # docker compose up -d  +  scripts/setup-db.ts
```

Then run the app or the test (below). Tear down with `npm run db:down`.

### Option B — your own PostgreSQL

Point `DATABASE_URL` at any Postgres and apply the schema + seed:

```bash
export DATABASE_URL=postgres://user:pass@host:5432/dbname   # see .env.example
npm run db:setup
```

> Migrations/seeding run as a **privileged** role (they `CREATE ROLE app_user`
> and bypass RLS to insert fixtures). The included `DATABASE_URL` uses the docker
> superuser; the app then drops to `app_user` per transaction. In a real
> deployment you'd give `app_user` a password + `LOGIN` and have the app connect
> directly as it.

### The app

```bash
npm run dev      # http://localhost:3000
```

The page lists only the current tenant's projects. Use the two buttons (or
`/?tenant=<uuid>`, or `GET /api/projects?tenant=<uuid>`) to switch tenants and
watch the list change — the query in `app/page.tsx` has **no tenant filter of
its own**; PostgreSQL applies one.

### The isolation test

```bash
npm test
```

This is the point of the repo. It runs **11 checks** against a real PostgreSQL
and proves, from the perspective of the non-privileged `app_user` role, that a
tenant:

- sees only its own rows on `SELECT` (even when selecting another tenant's row
  by primary key → 0 rows);
- sees **nothing** when no tenant is set (fail-closed);
- **cannot `INSERT`** a row for another tenant (RLS `WITH CHECK` rejects it);
- **cannot `UPDATE` or `DELETE`** another tenant's rows (0 rows affected), and
  cannot reassign its own row to another tenant;
- gets the same protection on a second table (`users`), showing the pattern
  generalizes to every tenant-scoped table.

**No database? The test SKIPS cleanly** — it never hangs or hard-fails:

```
﹣ cross-tenant isolation is enforced by RLS # No PostgreSQL reachable at
  postgres://postgres:***@localhost:5432/app. Set DATABASE_URL to a running
  Postgres, or run `npm run db:up` (Docker). Skipping RLS isolation tests.
ℹ pass 0   ℹ fail 0   ℹ skipped 1
```

With a DB present (`npm run db:up` first) you get the real thing:

```
✔ tenant A sees only tenant A projects
✔ tenant A cannot read a tenant B row even by its id
✔ with no tenant set, no rows are visible (fail-closed)
✔ tenant A cannot INSERT a row for tenant B
✔ tenant A cannot UPDATE a tenant B row (0 rows affected)
✔ tenant A cannot reassign its own row to tenant B
✔ tenant A cannot DELETE a tenant B row (0 rows affected)
✔ the users table is isolated the same way
ℹ tests 11   ℹ pass 11   ℹ fail 0
```

The test applies the (idempotent) migration itself and uses its own throwaway
fixtures, so `docker compose up -d && npm test` is enough even without seeding.

---

## Why RLS and not just app-level checks?

App-level tenant filters are the right first line of defense — keep them. RLS is
the second line that catches the day the first line slips:

| | App-level `WHERE tenant_id = …` | Database RLS |
|---|---|---|
| **Coverage** | Only the queries a developer remembered to filter | Every statement against the table, automatically |
| **New code** | Each new query/endpoint/job must re-implement the check | Protected the moment it touches the table |
| **Raw SQL / ORM escape hatches / migrations / analytics** | Easy to bypass the check | Still enforced |
| **Default on a mistake** | Fails **open** (forgot the clause → leak) | Fails **closed** (no tenant set → no rows) |
| **Where the rule lives** | Scattered across the app | One place, next to the data |

RLS is not a replacement for authorization logic, input validation, or careful
code — it's the backstop that turns "we think every query is scoped" into "the
database guarantees it," which is exactly what you want standing between two
customers' data.

---

## Note on zero-setup testing (pg-mem) — why a real database

The ideal would be an in-memory database so `npm test` needs no setup at all.
The obvious candidate is [`pg-mem`](https://github.com/oguimbal/pg-mem), and I
checked whether it can host this test: **it can't, and it's the wrong tool for
*this* job specifically.**

- pg-mem does not implement RLS (`CREATE POLICY`, `ALTER TABLE … ENABLE/FORCE
  ROW LEVEL SECURITY`); unimplemented features are treated as invalid syntax.
- More fundamentally, RLS enforcement is **defined in terms of roles** and the
  superuser/owner **bypass** rules. pg-mem has no role/privilege model, so even
  if it parsed the policies it could not reproduce the behavior that makes RLS
  meaningful.

Testing RLS against something that doesn't implement RLS would prove nothing, so
the test targets a **real** PostgreSQL via `DATABASE_URL` and skips cleanly when
one isn't reachable. (pg-mem remains excellent for fast unit tests of ordinary
query logic — just not for row-level security.)

---

## License

MIT © 2026 Tyler Milam (Golden Rock). See [LICENSE](./LICENSE).
