-- MS-001 verification. Run against the moonshots project AFTER the migration is
-- applied (SQL editor or psql as postgres). Everything runs in one transaction
-- and is rolled back, so no test rows are left behind. Any failure raises.

begin;

-- 1. Anonymous insert with a file path and email creates a row at queued.
set local role anon;
insert into public.submissions (id, email, original_filename, storage_path)
values ('00000000-0000-4000-8000-000000000001', 'test@example.com', 'song.mp3',
        'clearance-uploads/00000000-0000-4000-8000-000000000001/song.mp3');

-- 1b. Anonymous insert cannot pre-set status or results.
do $$ begin
  insert into public.submissions (email, original_filename, storage_path, status)
  values ('x@example.com', 'x.mp3', 'x', 'done');
  raise exception 'FAIL: anon set status on insert';
exception when insufficient_privilege then null;
end $$;

-- 2. Readable by id without auth (id supplied in the request header).
select set_config('request.headers',
  '{"x-submission-id":"00000000-0000-4000-8000-000000000001"}', true);
do $$ begin
  if (select count(*) from public.submissions) <> 1
     or (select status from public.submissions) <> 'queued'
     or (select youtube_result from public.submissions) <> 'pending' then
    raise exception 'FAIL: row not readable by id, or not queued/pending';
  end if;
end $$;

-- 2b. Without the id, anon sees nothing (no listing).
select set_config('request.headers', '{}', true);
do $$ begin
  if (select count(*) from public.submissions) <> 0 then
    raise exception 'FAIL: anon can list rows without an id';
  end if;
end $$;

-- 3. Anonymous update is rejected.
do $$ begin
  update public.submissions set status = 'done'
  where id = '00000000-0000-4000-8000-000000000001';
  raise exception 'FAIL: anon update was allowed';
exception when insufficient_privilege then null;
end $$;

-- 3b. Anonymous delete is rejected.
do $$ begin
  delete from public.submissions where id = '00000000-0000-4000-8000-000000000001';
  raise exception 'FAIL: anon delete was allowed';
exception when insufficient_privilege then null;
end $$;

-- 4. Service role can update status and results.
reset role;
set local role service_role;
update public.submissions
set status = 'done',
    youtube_result = 'clear',   youtube_note = 'no match',
    tiktok_result = 'muted',    tiktok_note = 'muted at 0:12',
    instagram_result = 'claimed', instagram_note = 'claimed by label'
where id = '00000000-0000-4000-8000-000000000001';
do $$ begin
  if (select status from public.submissions
      where id = '00000000-0000-4000-8000-000000000001') <> 'done' then
    raise exception 'FAIL: service_role update did not persist';
  end if;
end $$;

-- 5. Bucket exists, is private, 50 MB limit, mp3/wav/m4a MIME types only.
do $$ begin
  if not exists (select 1 from storage.buckets
                 where id = 'clearance-uploads' and not public
                   and file_size_limit = 52428800
                   and allowed_mime_types::text[] @> array['audio/mpeg','audio/wav','audio/x-wav','audio/mp4','audio/x-m4a']
                   and allowed_mime_types::text[] <@ array['audio/mpeg','audio/wav','audio/x-wav','audio/mp4','audio/x-m4a']) then
    raise exception 'FAIL: private bucket clearance-uploads missing or misconfigured';
  end if;
end $$;

-- 5b. Anon can upload an object but cannot read it back; service_role can.
set local role anon;
insert into storage.objects (bucket_id, name)
values ('clearance-uploads', '00000000-0000-4000-8000-000000000001/song.mp3');
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'clearance-uploads') <> 0 then
    raise exception 'FAIL: anon can read clearance-uploads objects';
  end if;
end $$;
reset role;
set local role service_role;
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'clearance-uploads') <> 1 then
    raise exception 'FAIL: service_role cannot read clearance-uploads objects';
  end if;
end $$;
reset role;

reset role;
select 'MS-001 verify: ALL PASS' as result;
rollback;
