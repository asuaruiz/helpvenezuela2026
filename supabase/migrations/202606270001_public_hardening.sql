-- Public hardening for the missing-person registry.
-- Goal: anon users can read only sanitized, minimal data through RPCs.
-- Reviewers/operators should use authenticated roles and dedicated policies.

begin;

create extension if not exists pg_trgm with schema extensions;

create or replace function public.redact_public_text(input text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(coalesce(input, ''), '([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)\.[A-Za-z]{2,}', '[email]', 'gi'),
      '(\+?\d[\d\s().-]{6,}\d)', '[telefono]', 'g'
    ),
    ''
  );
$$;

create or replace function public.public_app_stats()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'records', (select count(*) from public.records),
    'clusters', (select count(*) from public.clusters),
    'found', (select count(*) from public.clusters where status = 'found'),
    'multi', (select count(*) from public.clusters where n_sources > 1),
    'conflicts_open', (select count(*) from public.clusters where has_conflict is true and coalesce(resolved, false) is false and confidence in ('alta','media')),
    'open_alta', (select count(*) from public.clusters where has_conflict is true and coalesce(resolved, false) is false and confidence = 'alta'),
    'open_media', (select count(*) from public.clusters where has_conflict is true and coalesce(resolved, false) is false and confidence = 'media'),
    'by_source', (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select source, count(*) n from public.records group by source) s),
    'by_source_found', (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select source, count(*) n from public.records where status = 'found' group by source) s)
  );
$$;

create or replace function public.public_search_clusters(
  p_term text default '',
  p_filter text default '',
  p_limit int default 40,
  p_offset int default 0
)
returns table (
  id text,
  name text,
  age int,
  location text,
  status text,
  sources text[],
  n_sources int,
  n_records int,
  has_conflict boolean,
  resolved boolean,
  resolved_decision text
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.name, c.age, c.location, c.status, c.sources, c.n_sources, c.n_records,
         c.has_conflict, c.resolved, c.resolved_decision
  from public.clusters c
  where
    (coalesce(trim(p_term), '') = '' or c.name ilike '%' || trim(p_term) || '%')
    and (p_filter <> 'missing' or c.status = 'missing')
    and (p_filter <> 'found' or c.status = 'found')
    and (p_filter <> 'conflict' or (c.has_conflict is true and coalesce(c.resolved, false) is false))
    and (p_filter <> 'resolved' or coalesce(c.resolved, false) is true)
  order by
    case when coalesce(trim(p_term), '') = '' then c.name end asc,
    c.n_records desc,
    c.name asc
  limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
$$;

create or replace function public.public_cluster_with_records(p_id text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'cluster', to_jsonb(c),
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'pk', r.pk,
        'cluster_id', r.cluster_id,
        'source', r.source,
        'source_id', r.source_id,
        'name', r.name,
        'age', r.age,
        'gender', r.gender,
        'location', r.location,
        'status', r.status,
        'photo', r.photo,
        'description', public.redact_public_text(r.description),
        'verified', r.verified
      ) order by r.source, r.source_id)
      from public.records r
      where r.cluster_id = c.id
    ), '[]'::jsonb),
    'decisions', '[]'::jsonb
  )
  from public.clusters c
  where c.id = p_id;
$$;

-- Base tables: deny anonymous direct access. Authenticated access is deliberately
-- narrow here; operator/reviewer policies should be added for the production auth model.
alter table if exists public.records enable row level security;
alter table if exists public.clusters enable row level security;
alter table if exists public.decisions enable row level security;
alter table if exists public.hospital_lists enable row level security;
alter table if exists public.cedula_data enable row level security;

revoke all on table public.records from anon;
revoke all on table public.decisions from anon;
revoke all on table public.hospital_lists from anon;
revoke all on table public.cedula_data from anon;

drop policy if exists decisions_insert_authenticated on public.decisions;
create policy decisions_insert_authenticated
  on public.decisions
  for insert
  to authenticated
  with check (
    decision in ('same_located', 'same_deceased', 'same_missing', 'not_same', 'unsure')
  );

drop policy if exists decisions_select_authenticated on public.decisions;
create policy decisions_select_authenticated
  on public.decisions
  for select
  to authenticated
  using (true);

grant execute on function public.public_app_stats() to anon, authenticated;
grant execute on function public.public_search_clusters(text, text, int, int) to anon, authenticated;
grant execute on function public.public_cluster_with_records(text) to anon, authenticated;

-- Existing sensitive RPCs are for reviewers/operators only. This revokes every
-- overload defensively because local code may not know the exact deployed signature.
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('next_candidates', 'cluster_with_records', 'app_stats')
  loop
    execute format('revoke execute on function %s from anon', fn);
  end loop;
end $$;

commit;
