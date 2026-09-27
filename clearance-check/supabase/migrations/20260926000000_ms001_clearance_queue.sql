-- MS-001 Clearance Queue
-- Target: the moonshots Supabase project ONLY. Never apply to Real Audio production.
--
-- One row per clearance check. Anonymous visitors can insert a row and read a
-- row by its id. Only the service role (the checking bot) can update.

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

-- Privileges. Supabase grants ALL on new public tables to anon/authenticated by
-- default; strip that so an anonymous UPDATE/DELETE fails with "permission
-- denied" instead of silently matching zero rows.
revoke all on table public.submissions from anon, authenticated;

-- Anyone may insert only these columns. status and the per-platform results
-- always start at their defaults (queued / pending). id is insertable so the
-- client can generate it and go straight to /r/[id].
grant insert (id, email, original_filename, storage_path)
  on table public.submissions to anon, authenticated;
grant select on table public.submissions to anon, authenticated;

grant select, insert, update, delete on table public.submissions to service_role;

-- Insert: anyone, and a new row must be queued.
create policy "submissions_insert_anyone"
  on public.submissions
  for insert
  to anon, authenticated
  with check (status = 'queued');

-- Read by id: a row is visible only when the request names its id in the
-- x-submission-id header, so anonymous clients cannot list other people's rows
-- (and their emails). supabase-js: createClient(url, anonKey,
-- { global: { headers: { 'x-submission-id': id } } }).
create policy "submissions_select_by_id"
  on public.submissions
  for select
  to anon, authenticated
  using (
    id::text = (current_setting('request.headers', true)::json ->> 'x-submission-id')
  );

-- No UPDATE or DELETE policy for anon/authenticated. service_role bypasses RLS.

-- Storage: private bucket for uploaded audio (mp3, wav, m4a), 50 MB max.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'clearance-uploads', 'clearance-uploads', false,
  52428800,
  array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a']
);

-- Anyone may upload into this bucket (MS-002 uploads with the anon key and
-- never reads the file back). No select/update/delete policy for anon or
-- authenticated, so objects cannot be read, listed, overwritten, or removed by
-- clients. service_role bypasses RLS and is the only reader.
create policy "clearance_uploads_insert_anyone"
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'clearance-uploads');
