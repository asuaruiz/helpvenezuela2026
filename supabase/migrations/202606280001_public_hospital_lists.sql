-- Lectura pública (anon) de las listas subidas (hospital_lists tiene RLS y anon revocado).
-- Devuelve cada lista con conteos derivados de su JSON `extracted`.
create or replace function public.public_hospital_lists(p_limit int default 50, p_offset int default 0)
returns table (
  id bigint,
  hospital text,
  uploaded_by text,
  created_at timestamptz,
  n_items int,
  n_located int,
  extracted jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    h.id,
    h.hospital,
    h.uploaded_by,
    h.created_at,
    coalesce(jsonb_array_length(h.extracted), 0) as n_items,
    (
      select count(*)::int
      from jsonb_array_elements(coalesce(h.extracted, '[]'::jsonb)) e
      where e->>'resultado' in ('creado_localizado', 'vinculado_localizado', 'ya_localizado')
    ) as n_located,
    h.extracted
  from public.hospital_lists h
  order by h.created_at desc
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

grant execute on function public.public_hospital_lists(int, int) to anon;
