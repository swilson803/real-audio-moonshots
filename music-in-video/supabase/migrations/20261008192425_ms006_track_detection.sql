-- MS-006 Music in this video: catalog fingerprints and scan results.
-- Target: the moonshots Supabase project ONLY (kucwpmtkctafzkivuqtu).
-- Never apply to Real Audio production (uprfsmwbsvzuoiyfgtgx).
-- NOT APPLIED. Nobody applies this until Spencer approves it.
--
-- Size (moonshots is on Supabase Free, 500 MB): ms006_fp holds ~40 rows per
-- second of catalog audio (public/music/fp.js: ~20 peaks/s x FANOUT 2) at
-- ~74.5 bytes a row with both indexes (measured on PGlite with this file).
-- 224 tracks / ~12.9 h -> ~1.9M rows, ~140 MB. The window-limited ceiling
-- (38.5 peaks/s) is ~3.6M rows, ~267 MB. scripts/build-catalog-index.mjs
-- refuses to go past 3.8M rows (~283 MB).
--
-- Production is only ever READ (anon key, GET) by scripts/build-catalog-index.mjs;
-- what it learns is written here. The Worker reads and writes these tables with
-- the service role. anon and authenticated get nothing: the result page reads a
-- scan through the Worker (GET /api/scans/<id>), never directly.

-- One row per indexed catalog track. tid is a small local key so the
-- fingerprint table stays compact; track_id is production "Tracks".track_id.
-- title / artist / stream_url are copied at index time so result pages never
-- query production metadata; stream_url is "Tracks".track_ref, a public URL in
-- production's public Tracks bucket (the only production request a result page
-- makes, and only when Play is pressed).
create table public.ms006_catalog (
  tid           smallint    primary key,
  track_id      uuid        not null unique,
  title         text        not null,
  artist        text        not null,
  stream_url    text        not null
                check (stream_url like 'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/public/Tracks/%'),
  duration_s    real,
  audio_sha256  text        not null,  -- of the audio bytes, so a rebuild skips unchanged files
  fp_version    smallint    not null,
  hash_count    integer     not null,
  indexed_at    timestamptz not null default now()
);

-- Landmark hashes (public/music/fp.js): 24-bit hash, frame time t (16 ms).
create table public.ms006_fp (
  hash  integer  not null,
  tid   smallint not null references public.ms006_catalog (tid) on delete cascade,
  t     integer  not null
);
create index ms006_fp_hash on public.ms006_fp (hash);
create index ms006_fp_tid_t on public.ms006_fp (tid, t);

-- One row per scan. The video is never uploaded; only the result is kept.
-- A no-match scan is recorded too (found = false) but never gets a link.
-- label is set only for test scans (RA_TEST_...), so test data can be cleared.
create table public.ms006_scans (
  id          text        primary key check (id ~ '^[0-9A-Za-z]{10}$'),
  created_at  timestamptz not null default now(),
  duration_s  real        not null,
  found       boolean     not null,
  matches     jsonb       not null default '[]'::jsonb,
  fp_version  smallint    not null,
  label       text        check (label is null or label like 'RA\_TEST\_%')
);

alter table public.ms006_catalog enable row level security;
alter table public.ms006_fp enable row level security;
alter table public.ms006_scans enable row level security;
-- No policies: anon/authenticated can do nothing. service_role bypasses RLS.
revoke all on table public.ms006_catalog, public.ms006_fp, public.ms006_scans from anon, authenticated;
grant select, insert, update, delete on table public.ms006_catalog, public.ms006_fp, public.ms006_scans to service_role;

-- Stage 1 lookup (mirrors clustersInMemory in src/match.js; keep in step):
-- per (track, 4-frame offset bin), the query times that hit and their exact
-- offsets, bins with >= 2 hits, biggest first, at most 500 rows.
create function public.ms006_match(p_hashes integer[], p_times integer[])
returns table (tid smallint, bin integer, hits integer[], deltas integer[])
language sql
stable
set search_path = public
as $$
  select f.tid,
         floor((q.t - f.t) / 4.0)::integer as bin,
         array_agg(q.t order by q.t, q.t - f.t) as hits,
         array_agg(q.t - f.t order by q.t, q.t - f.t) as deltas
  from unnest(p_hashes, p_times) as q(h, t)
  join public.ms006_fp f on f.hash = q.h
  group by f.tid, floor((q.t - f.t) / 4.0)::integer
  having count(*) >= 2
  order by count(*) desc
  limit 500;
$$;

-- Stage 2: one track's hashes between two times, as one row of arrays (so the
-- 1000-row API cap can't truncate it).
create function public.ms006_track_window(p_tid smallint, p_from integer, p_to integer)
returns table (hashes integer[], times integer[])
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(f.hash order by f.t), '{}'), coalesce(array_agg(f.t order by f.t), '{}')
  from public.ms006_fp f
  where f.tid = p_tid and f.t between p_from and p_to;
$$;

revoke execute on function public.ms006_match(integer[], integer[]) from public, anon, authenticated;
revoke execute on function public.ms006_track_window(smallint, integer, integer) from public, anon, authenticated;
grant execute on function public.ms006_match(integer[], integer[]) to service_role;
grant execute on function public.ms006_track_window(smallint, integer, integer) to service_role;
