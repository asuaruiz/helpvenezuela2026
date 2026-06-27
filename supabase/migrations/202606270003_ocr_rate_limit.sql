-- Audit/rate-limit events for hospital OCR.

begin;

create table if not exists public.hospital_ocr_events (
  id bigserial primary key,
  client_hash text not null,
  uploaded_by text,
  hospital text,
  image_bytes int,
  status text not null default 'accepted',
  created_at timestamptz not null default now()
);

alter table public.hospital_ocr_events enable row level security;
revoke all on table public.hospital_ocr_events from anon, authenticated;

create index if not exists hospital_ocr_events_client_created_idx
  on public.hospital_ocr_events (client_hash, created_at desc);

create index if not exists hospital_ocr_events_created_idx
  on public.hospital_ocr_events (created_at desc);

commit;
