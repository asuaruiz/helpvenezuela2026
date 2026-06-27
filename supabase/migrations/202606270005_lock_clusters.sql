-- clusters quedó legible por anon tras el hardening inicial (solo se le activó RLS).
-- El acceso público va exclusivamente por public_search_clusters / public_cluster_with_records
-- (security definer), así que se revoca el acceso directo de anon a la tabla.
begin;
alter table if exists public.clusters enable row level security;
revoke all on table public.clusters from anon;
commit;
