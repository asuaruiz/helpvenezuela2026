-- Búsqueda robusta: insensible a acentos y a orden de nombres.
-- Antes: `name ilike '%' || term || '%'` exigía el término completo como subcadena exacta,
-- así "Misaira Pérez" no encontraba a "Misaira Perez" (acento) ni "Perez Misaira" (orden).
-- Ahora: se normalizan acentos (translate, inmutable, sin extensión) y se exige que CADA
-- palabra del término (>=2 letras) aparezca en el nombre, en cualquier orden.
begin;

create or replace function public.norm_text(input text)
returns text
language sql
immutable
as $$
  select translate(lower(coalesce(input, '')),
    'áéíóúüñàèìòùâêîôûäëïöç',
    'aeiouunaeiouaeiouaeioc');
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
  with q as (
    select public.norm_text(trim(coalesce(p_term, ''))) as term
  ),
  tk as (
    select array(
      select t from unnest(string_to_array((select term from q), ' ')) t
      where length(t) >= 2
    ) as arr
  )
  select c.id, c.name, c.age, c.location, c.status, c.sources, c.n_sources, c.n_records,
         c.has_conflict, c.resolved, c.resolved_decision
  from public.clusters c, q, tk
  where
    (
      q.term = ''
      or (cardinality(tk.arr) = 0 and public.norm_text(c.name) like '%' || q.term || '%')
      or (cardinality(tk.arr) > 0 and (
        select bool_and(public.norm_text(c.name) like '%' || t || '%') from unnest(tk.arr) t
      ))
    )
    and (p_filter <> 'missing' or c.status = 'missing')
    and (p_filter <> 'found' or c.status = 'found')
    and (p_filter <> 'conflict' or (c.has_conflict is true and coalesce(c.resolved, false) is false))
    and (p_filter <> 'resolved' or coalesce(c.resolved, false) is true)
  order by
    case when q.term = '' then c.name end asc,
    c.n_records desc,
    c.name asc
  limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
$$;

grant execute on function public.public_search_clusters(text, text, int, int) to anon, authenticated;

commit;
