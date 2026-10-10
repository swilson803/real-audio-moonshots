-- MS-007 processing off the Worker: job status and cost columns on
-- ms006_scans.
-- Target: the moonshots Supabase project ONLY (kucwpmtkctafzkivuqtu).
-- Never apply to Real Audio production (uprfsmwbsvzuoiyfgtgx).
-- NOT APPLIED. Nobody applies this until Spencer approves it at schema review.
-- Apply it as one file (apply_migration), never `supabase db push`: moonshots
-- recorded MS-006's migration as version 20261008192425, not the repo's
-- 20261007000000.
--
-- A scan is now a job: POST /api/scan stores the soundtrack in R2, inserts
-- the row as 'queued' and queues it; the queue consumer marks it 'working',
-- the Processor container checks it, and the row ends 'done' (found /
-- matches as in MS-006) or 'failed' (error). The Worker's cron fails jobs
-- left open past 15 minutes (ms006_scans_open). The default 'done' keeps
-- MS-006's single insert valid while the old and new code overlap in a
-- deploy.
-- No new tables or functions; RLS (on, no policies) and grants (service_role
-- only) are unchanged.

alter table public.ms006_scans
  add column status      text        not null default 'done'
                         check (status in ('queued', 'working', 'done', 'failed')),
  add column attempts    smallint    not null default 0,
  add column updated_at  timestamptz not null default now(),
  add column error       text
                         check (error is null or error in ('unreadable', 'no-audio', 'too-long', 'internal')),
  -- What the processor measured for the job (cost reporting).
  add column proc_ms     integer,
  add column cpu_ms      integer,
  add column peak_mb     integer,
  add column separation  boolean;

-- Only a finished job can have found anything.
alter table public.ms006_scans
  add constraint ms006_scans_found_when_done
  check (status = 'done' or (found = false and matches = '[]'::jsonb));

-- The sweep's lookup of open jobs.
create index ms006_scans_open on public.ms006_scans (updated_at)
  where status in ('queued', 'working');
