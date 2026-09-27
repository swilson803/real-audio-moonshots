-- MS-001 follow-up: record when the results email was sent.
-- Target: the moonshots Supabase project (kucwpmtkctafzkivuqtu) ONLY.
-- Never apply to Real Audio production (uprfsmwbsvzuoiyfgtgx).
--
-- Additive and nullable, no default. service_role (already granted UPDATE,
-- bypasses RLS) sets it; anon/authenticated gain no UPDATE. MS-002 sends only
-- when status = 'done' and emailed_at is null.
alter table public.submissions add column if not exists emailed_at timestamptz;
