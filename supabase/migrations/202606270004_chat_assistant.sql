-- Public chatbot support: sanitized cédula lookup, session/event audit tables.

begin;

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  client_hash text not null,
  verifier_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.chat_events (
  id bigserial primary key,
  session_id uuid references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content_redacted text,
  tool_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.chat_sessions enable row level security;
alter table public.chat_events enable row level security;

revoke all on table public.chat_sessions from anon, authenticated;
revoke all on table public.chat_events from anon, authenticated;

create index if not exists chat_sessions_client_seen_idx
  on public.chat_sessions (client_hash, last_seen_at desc);

create index if not exists chat_events_session_created_idx
  on public.chat_events (session_id, created_at desc);

create index if not exists chat_events_tool_created_idx
  on public.chat_events (tool_name, created_at desc);

create or replace function public.public_search_by_cedula(p_cedula text)
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
  with clean as (
    select regexp_replace(coalesce(p_cedula, ''), '\D', '', 'g') as cedula
  ),
  hit as (
    select distinct r.cluster_id
    from public.records r, clean
    where clean.cedula ~ '^\d{6,9}$'
      and regexp_replace(coalesce(r.id_number, ''), '\D', '', 'g') = clean.cedula
    limit 5
  )
  select c.id, c.name, c.age, c.location, c.status, c.sources, c.n_sources, c.n_records,
         c.has_conflict, c.resolved, c.resolved_decision
  from public.clusters c
  join hit h on h.cluster_id = c.id
  order by c.n_records desc, c.name asc;
$$;

grant execute on function public.public_search_by_cedula(text) to anon, authenticated;

commit;
