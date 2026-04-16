-- Seed a default tenant for local development

insert into public.tenants (id, name, slug, status, tier) values
  ('00000000-0000-0000-0000-000000000001', 'Development Tenant', 'dev', 'active', 'standard');
