-- HISTORICAL, DATA-ONLY migration, kept so this folder matches the moonshots
-- project's recorded migration history (supabase_migrations.schema_migrations,
-- version 20260927024904). Already applied on moonshots (kucwpmtkctafzkivuqtu) during
-- MS-001. Never re-run it, and never apply it anywhere else. The statements
-- below are the recorded ones, verbatim.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'clearance-uploads' and name = '96e844a2-d144-453d-be5b-278088849e1d/RA_TEST_MS001_retest.mp3';
delete from public.submissions where id = '96e844a2-d144-453d-be5b-278088849e1d';
delete from public.submissions where original_filename like 'RA_TEST_%';
delete from storage.objects where bucket_id = 'clearance-uploads' and name like '%RA_TEST_%';