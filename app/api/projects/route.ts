import { NextResponse, type NextRequest } from "next/server";
import { isUuid, withTenant } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // `pg` needs the Node.js runtime, not Edge.

// GET /api/projects?tenant=<uuid>
//
// The tenant id is read from the query string (or an `x-tenant-id` header) only
// to keep the demo easy to try. In production it MUST come from the
// authenticated request context (session/JWT/subdomain), never from the client.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const tenantId =
    req.nextUrl.searchParams.get("tenant") ?? req.headers.get("x-tenant-id");

  if (!tenantId || !isUuid(tenantId)) {
    return NextResponse.json(
      { error: "Provide a valid tenant id via ?tenant= or x-tenant-id header." },
      { status: 400 },
    );
  }

  try {
    // RLS guarantees these rows all belong to `tenantId` -- the SQL below has
    // no tenant filter of its own; the database applies one.
    const projects = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT id, name, created_at FROM projects ORDER BY name",
      );
      return rows;
    });
    return NextResponse.json({ tenant: tenantId, projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Database unavailable.", detail: message },
      { status: 503 },
    );
  }
}
