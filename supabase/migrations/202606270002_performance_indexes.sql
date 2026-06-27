-- Indexes for public search, reviewer queue, OCR matching and incremental refresh.

begin;

create extension if not exists pg_trgm with schema extensions;

create index if not exists clusters_name_trgm_idx
  on public.clusters
  using gin (name gin_trgm_ops);

create index if not exists clusters_review_queue_idx
  on public.clusters (has_conflict, resolved, confidence, n_records desc)
  where has_conflict is true;

create index if not exists clusters_status_name_idx
  on public.clusters (status, name);

create index if not exists records_cluster_id_idx
  on public.records (cluster_id);

create index if not exists records_id_number_idx
  on public.records (id_number)
  where id_number is not null;

create index if not exists records_name_norm_age_idx
  on public.records (name_norm, age);

create index if not exists records_source_source_id_idx
  on public.records (source, source_id);

create index if not exists decisions_cluster_id_idx
  on public.decisions (cluster_id);

commit;
