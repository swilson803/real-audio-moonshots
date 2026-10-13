alter table public.submissions
  add column if not exists emailed_at timestamptz;