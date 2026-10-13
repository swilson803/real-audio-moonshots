-- MS-001 Clearance Queue
-- Target: the moonshots Supabase project ONLY. Never apply to Real Audio production.

create table public.submissions (
  id                uuid        primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  email             text        not null,
  original_filename text        not null,
  storage_path      text        not null,
  status            text        not null default 'queued'
                    check (status in ('queued', 'checking', 'done', 'failed')),
  youtube_result    text        not null default 'pending'
                    check (youtube_result in ('pending', 'clear', 'claimed', 'muted', 'error')),
  youtube_note      text,
  tiktok_result     text        not null default 'pending'
                    check (tiktok_result in ('pending', 'clear', 'claimed', 'muted', 'error')),
  tiktok_note       text,
  instagram_result  text        not null default 'pending'
                    check (instagram_result in ('pending', 'clear', 'claimed', 'muted', 'error')),
  instagram_note    text
);

alter table public.submissions enable row level security;

revoke all on table public.submissions from anon, authenticated;

grant insert (id, email, original_filename, storage_path)
  on table public.submissions to anon, authenticated;
grant select on table public.submissions to anon, authenticated;

grant select, insert, update, delete on table public.submissions to service_role;

create policy "submissions_insert_anyone"
  on public.submissions
  for insert
  to anon, authenticated
  with check (status = 'queued');

create policy "submissions_select_by_id"
  on public.submissions
  for select
  to anon, authenticated
  using (
    id::text = (current_setting('request.headers', true)::json ->> 'x-submission-id')
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'clearance-uploads', 'clearance-uploads', false,
  52428800,
  array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a']
);

create policy "clearance_uploads_insert_anyone"
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'clearance-uploads');