-- =============================================================================
-- seed.sql  --  Demo data for the Next.js page.
--
-- Run as a privileged role (the docker `postgres` superuser), so these inserts
-- bypass RLS. The app then reads this data back as the restricted `app_user`
-- role and only ever sees a single tenant at a time.
--
-- Idempotent: ON CONFLICT DO NOTHING + fixed tenant UUIDs mean re-running is a
-- no-op. The two tenant UUIDs below are mirrored in app/page.tsx for the demo
-- tenant switcher.
-- =============================================================================

INSERT INTO tenants (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme Corp'),
  ('22222222-2222-2222-2222-222222222222', 'Globex Inc')
ON CONFLICT (id) DO NOTHING;

-- Set the tenant GUC before each tenant's rows so this seed still works even if
-- it is ever run as the (FORCE RLS) table owner instead of a superuser.
SELECT set_config('app.current_tenant', '11111111-1111-1111-1111-111111111111', false);
INSERT INTO users (tenant_id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner@acme.example')
ON CONFLICT DO NOTHING;
INSERT INTO projects (tenant_id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme Website Redesign'),
  ('11111111-1111-1111-1111-111111111111', 'Acme Mobile App'),
  ('11111111-1111-1111-1111-111111111111', 'Acme Data Warehouse')
ON CONFLICT DO NOTHING;

SELECT set_config('app.current_tenant', '22222222-2222-2222-2222-222222222222', false);
INSERT INTO users (tenant_id, email) VALUES
  ('22222222-2222-2222-2222-222222222222', 'owner@globex.example')
ON CONFLICT DO NOTHING;
INSERT INTO projects (tenant_id, name) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Globex CRM Migration'),
  ('22222222-2222-2222-2222-222222222222', 'Globex Billing Revamp')
ON CONFLICT DO NOTHING;

-- Clear the GUC again so the seeding session leaves no ambient tenant behind.
SELECT set_config('app.current_tenant', '', false);
