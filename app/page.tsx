import { isUuid, withTenant } from "@/lib/db";

// This page reads live per-tenant data, so render it on the server per request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Demo tenants seeded by db/seed.sql. In a real app you would NOT list tenants
// in the UI or take the tenant from the URL -- it would come from the signed-in
// session. The switcher here only exists to make isolation easy to see.
const DEMO_TENANTS = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Acme Corp" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Globex Inc" },
];

type Project = { id: string; name: string };

export default async function Home({
  searchParams,
}: {
  // Next.js 15+ delivers searchParams as a Promise.
  searchParams: Promise<{ tenant?: string }>;
}) {
  const params = await searchParams;
  const tenantId =
    params.tenant && isUuid(params.tenant)
      ? params.tenant
      : DEMO_TENANTS[0]!.id;

  const current =
    DEMO_TENANTS.find((t) => t.id === tenantId)?.name ?? tenantId;

  let projects: Project[] = [];
  let error: string | null = null;
  try {
    // Everything inside withTenant() runs as `app_user` with
    // app.current_tenant = tenantId, so RLS returns ONLY this tenant's rows.
    projects = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query<Project>(
        "SELECT id, name FROM projects ORDER BY name",
      );
      return rows;
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main>
      <h1>Projects</h1>

      <p style={{ color: "#555" }}>
        Viewing as tenant: <strong>{current}</strong>
      </p>

      <nav style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        {DEMO_TENANTS.map((t) => (
          <a
            key={t.id}
            href={`/?tenant=${t.id}`}
            style={{
              padding: "6px 12px",
              border: "1px solid #ccc",
              borderRadius: 6,
              textDecoration: "none",
              color: t.id === tenantId ? "#fff" : "#111",
              background: t.id === tenantId ? "#111" : "#fff",
            }}
          >
            {t.name}
          </a>
        ))}
      </nav>

      {error ? (
        <p style={{ color: "#b00" }}>
          Could not reach the database. Run <code>npm run db:up</code> (or set{" "}
          <code>DATABASE_URL</code>) and reload.
          <br />
          <small style={{ color: "#999" }}>{error}</small>
        </p>
      ) : projects.length === 0 ? (
        <p style={{ color: "#777" }}>No projects for this tenant.</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      )}

      <hr style={{ margin: "28px 0", border: "none", borderTop: "1px solid #eee" }} />
      <p style={{ color: "#777", fontSize: 14 }}>
        The list above is filtered by PostgreSQL itself via Row-Level Security --
        not by a <code>WHERE tenant_id = ...</code> clause in this query. See{" "}
        <code>db/migrations/001_init.sql</code> and <code>lib/db.ts</code>.
      </p>
    </main>
  );
}
