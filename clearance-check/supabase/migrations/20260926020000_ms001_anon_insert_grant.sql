-- MS-001 follow-up: grant anon/authenticated INSERT + SELECT on submissions so
-- the anon REST insert body { storage_path, email } works.
-- Target: the moonshots Supabase project (kucwpmtkctafzkivuqtu) ONLY.
-- Never apply to Real Audio production (uprfsmwbsvzuoiyfgtgx).
--
-- Live moonshots ACL is anon=r / authenticated=r (SELECT only), so anon REST
-- inserts are rejected. RLS stays on; no UPDATE/DELETE grant or policy for
-- anon/authenticated. The clearance-uploads bucket is not touched.

-- 1. Privileges: INSERT + SELECT for the API roles, nothing else.
revoke all on table public.submissions from anon, authenticated;
grant insert, select on table public.submissions to anon, authenticated;

-- 2. Insert policy. With a table-level INSERT grant anon could otherwise pre-set
--    the results, so a new row must be queued with every result pending and no
--    notes (tighter than before, not looser).
drop policy "submissions_insert_anyone" on public.submissions;
create policy "submissions_insert_anyone"
  on public.submissions
  for insert
  to anon, authenticated
  with check (
    status = 'queued'
    and youtube_result = 'pending'   and youtube_note is null
    and tiktok_result = 'pending'    and tiktok_note is null
    and instagram_result = 'pending' and instagram_note is null
  );

-- 3. A normal body is storage_path + email only, so original_filename can't be
--    required. When omitted it is filled from the last segment of storage_path.
alter table public.submissions alter column original_filename drop not null;

create function public.submissions_fill_original_filename()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.original_filename is null then
    new.original_filename := regexp_replace(new.storage_path, '^.*/', '');
  end if;
  return new;
end;
$$;

create trigger submissions_fill_original_filename
  before insert on public.submissions
  for each row execute function public.submissions_fill_original_filename();

-- 4. Read by id: same rule as before. request.headers can be '' (not NULL)
--    once a transaction-local setting has ended on a pooled connection, and
--    ''::json raises; nullif turns that into "no header" -> no rows.
drop policy "submissions_select_by_id" on public.submissions;
create policy "submissions_select_by_id"
  on public.submissions
  for select
  to anon, authenticated
  using (
    id::text = (nullif(current_setting('request.headers', true), '')::json ->> 'x-submission-id')
  );
