-- HISTORICAL, DATA-ONLY migration, kept so this folder matches the moonshots
-- project's recorded migration history (supabase_migrations.schema_migrations,
-- version 20260927000050). Already applied on moonshots (kucwpmtkctafzkivuqtu) during
-- MS-001. Never re-run it, and never apply it anywhere else. The statements
-- below are the recorded ones, verbatim.
delete from public.submissions where id in ('00000000-0000-4000-8000-0000000000ae'::uuid,'00000000-0000-4000-8000-0000000000af'::uuid,'00000000-0000-4000-8000-0000000000aa'::uuid,'00000000-0000-4000-8000-0000000000ab'::uuid,'00000000-0000-4000-8000-0000000000ac'::uuid,'00000000-0000-4000-8000-0000000000ad'::uuid);