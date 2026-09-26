-- MS-001 follow-up: make the anon REST insert body { file_path, email } work.
-- Target: the moonshots Supabase project (kucwpmtkctafzkivuqtu) ONLY.
-- Never apply to Real Audio production (uprfsmwbsvzuoiyfgtgx).
--
-- RLS stays on and no policy is weakened: anon/authenticated still insert only
-- (id, email, original_filename, file_path), status must be 'queued', reads
-- still need the x-submission-id header, and there is still no UPDATE/DELETE
-- grant or policy for anon/authenticated. The clearance-uploads bucket and its
-- storage policy are not touched (private, 50 MB, mp3/wav/m4a, anon insert only).

-- 1. The client sends file_path, not storage_path. Renaming keeps the existing
--    column-level INSERT grant (grants follow the column, not its name).
alter table public.submissions rename column storage_path to file_path;

-- 2. A normal body is file_path + email only, so original_filename can't be
--    required. When omitted it is filled from the last segment of file_path.
alter table public.submissions alter column original_filename drop not null;

create function public.submissions_fill_original_filename()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.original_filename is null then
    new.original_filename := regexp_replace(new.file_path, '^.*/', '');
  end if;
  return new;
end;
$$;

create trigger submissions_fill_original_filename
  before insert on public.submissions
  for each row execute function public.submissions_fill_original_filename();

-- 3. Read by id: same rule as before. request.headers can be '' (not NULL)
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
