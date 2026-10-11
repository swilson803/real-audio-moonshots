# music-in-video

MS-006: a creator picks a finished video on `/music/`; the page finds the Real
Audio tracks in it and gives one link, `/v/<id>`, listing every found track in
order with its start time, title, artist and a stream button, plus a one-tap
copy of `music in this video: <link>` for the video description. No account.
MS-007 moves the processing off the Worker into a container behind a queue,
gets start times from the matched track's waveform, and makes the header
plain brand type.

Shares the clearance-check Worker and domain (copyrighttester.real.audio):
`src/worker.js` handles `/music/`, `/v/<id>`, `POST /api/scan`,
`GET /api/scans/<id>` and `GET /api/scans/<id>/status`, consumes the
`ms007-jobs` queue (and its dead-letter queue), runs a sweep on the cron, and
passes every other request, and the cron, to
`clearance-check/src/worker.js` unchanged. The root `wrangler.jsonc` points
here; `npm run build` at the root (Wrangler's `build.command`) merges
`clearance-check/public` and `public/` into `dist/` and fails on any path
collision.

## The picture never leaves the device; the soundtrack is deleted once checked
`public/music/extract.js` reads the file in slices in the browser (mp4box.js +
WebCodecs for MP4/MOV/M4V with AAC; decodeAudioData for WebM or without
WebCodecs), averages the channels and resamples to 16 kHz, and keeps only
the soundtrack as 16-bit samples (`public/music/body.js`: an `MS7A` header
plus the samples, ~1.9 MB a minute, 38.4 MB at the 20-minute cap). That is
the POST /api/scan body; the picture is never sent.

## Processing off the Worker (MS-007)
- `POST /api/scan` (`src/scan.js`): checks the body, stores it in R2
  (`UPLOADS`, `uploads/<id>`), inserts the `ms006_scans` row as `queued` and
  sends `{ id }` to the `JOBS` queue; 202 `{ id }`.
- The queue consumer (batches of 1, up to 3 at once) marks the row
  `working` and streams the upload to the Processor container
  (`src/container.js`, `processor/server.mjs`, `processor/Dockerfile`:
  `basic`, Node 20, no npm dependencies, no ffmpeg). The container runs
  `src/process.js`: fingerprint (`fp.js` `QUERY`) -> `src/match.js` through
  the moonshots RPCs (`src/moonshots.js`, with MS-006's read retries; a
  fresh client per job) -> start times (`src/refine.js`) -> JSON with
  `proc_ms` / `cpu_ms` / `peak_mb`. The
  result is written (`done`, the MS-006 row shape) and the upload deleted.
- Busy or broken (cold container, database timeouts, a crash): the job is
  retried with backoff (15 s x attempt, max 60 s; 4 retries), then the
  dead-letter queue fails it. Permanent errors (`unreadable`, `no-audio`,
  `too-long`) fail it at once. Every path deletes the upload; the cron sweep
  fails jobs open > 15 min and deletes uploads > 30 min old with no open job;
  an R2 lifecycle rule deletes anything left after a day.
- The upload page polls `/api/scans/<id>/status` with no time limit: "Still
  working… this can take up to a minute." after 5 s, then the result (or
  the error line if the job failed). `/v/<id>` answers 202 while the job is
  open, and the result page shows the same "Still working…" until it's done.

## Music/speech separation (MS-007: tried, dropped)
Demucs v4 htdemucs (two stems, CPU) on the uploaded soundtrack, the stem
matched with the same matcher and thresholds. Experiment (offline replica,
all 83 clips, one pass per arm, arm choice locked on the practice clips):
original 59 hits / 56 within 1 s; stem only 60 / 57; original + stem 65 /
61; 0 wrong tracks in each pass. But Demucs shifts its input by a random
0-0.5 s each run, and the production-path check on the practice clips with
another draw named a wrong track on a no-music clip (speech + synthetic
music). The no-wrong-tracks record isn't reproducible, so separation is not
in the processor. Tooling and results: /workspace/ms007/build/separation.

## Start times (`src/refine.js`, MS-007)
Tracks are used unedited, so the soundtrack holds a copy of the matched
track's waveform under the voice. For each row the matcher accepted, at
8 kHz on first-differenced audio: the lag from PHAT cross-correlation of 30 s
of the video against the whole track (the matcher can line a row up with a
repeat of the music, so its own alignment isn't used); per 0.25 s window the
track's least-squares gain and its standard error (x2); the start is the
likelihood change point between "no track" and "the track at its median
strong gain" (strong: gain / SE > 5). Guard rails keep the matcher's start
without waveform evidence; rows are never added, dropped or renamed, and no
match threshold is touched. `REFINE` was locked on the 45 practice clips and
is pinned by `test/unit/refine.test.mjs` (with the confidence threshold).
The reference is a private copy of the catalog at 8 kHz mono 16-bit
(`scripts/build-ref-audio.mjs`, 742 MB, built from the index build's local
audio cache; `src/ref.js` reads it from R2 with a read-only token).
The 1-second target comes from a vendor test (ACRCloud): 56% right track
overall, 58% at -20 dB, no wrong tracks across 83 clips, start within 1 s on
81 of 84 window matches, median error 0.02 s.

## Matching (`public/music/fp.js`, `src/match.js`)
Landmark fingerprints: spectral peaks picked per frequency band after a
running-mean whitening, paired into 24-bit hashes.
- The index (`fingerprint()` defaults, FP_VERSION 1): one bin per band and
  frame, each peak paired with the next 2. Unchanged since the index build
  (a golden-digest test pins it).
- The video (`QUERY`, phase 2 round B): the 3 strongest bins per band and
  frame, kept if fewer than 3 stronger within the window, so music peaks
  behind a louder voice survive (a superset of the index's peaks); each
  peak paired with the next 4; no near-simultaneous pairs below 600 Hz
  (most of the lookup's work, little identity); plus a denser peak list
  (+-4 frames, rise >= 0.15) for verification only.
- Stage 1 (Postgres `ms006_match`, one call per ~60 s of video,
  `slicedLookup`): hash hits by track and time offset; candidates from 3
  hits, the 16 strongest.
- Stage 2 (the processor; MS-006: the Worker): single-peak coincidences of the video with each
  candidate's track at its alignment, against the chance distribution at 24
  off-alignment shifts (z >= 6, ratio >= 2); the audible stretch is where a
  ~4 s window beats chance, its start and end Poisson change points; each
  second goes to the locally strongest alignment (music repeats); rows
  need 30 coincidences and z >= 5 over their own span; touching rows of one
  track merge.
`clustersInMemory` / `trackWindowInMemory` mirror the two RPCs (tests, the
replica); `test/unit/sql.test.mjs` checks they agree.

Accuracy (round B, offline replica of the real index, LibriSpeech voice,
music 20 dB under it, right track +-1 s and nothing else): dev 20/30 over
three dev sets (8/10 on the phase-2 dev set); 17/17 negatives clean
(voice only, synthetic music, real music left out of the index); sweep
-12/-16/-20/-24/-28 dB 5/5, 2/5, 4/5, 4/5, 3/5. Misses are quiet clips whose
first seconds (or all) are inaudible under the voice to peak landmarks.

Cold start (MS-006 fix 1, now behind the queue): the first `ms006_match`
after the database has been idle can hit PostgREST's 8 s statement timeout
(500, code 57014). The processor retries moonshots reads on that and on
502/503/504/520-524/network errors (`RETRY` in `src/moonshots.js`: 3 tries
per read, 1 s then 2 s apart, at most 20 retries and no new try after 40 s
per job; a fresh client per job) and answers 503 busy past the cap; the
queue retries the job, and the page keeps showing "Still working…".

Cost (measured 2026-10-09 on the build machine, each job in a fresh Node
process, database answers replayed; /workspace/ms007/build/measure): the
processor takes ~1.2 CPU-s per minute of audio; a 5-minute soundtrack 4.86
CPU-s and 261 MB peak, a 20-minute one 13.5 CPU-s and 535 MB (fits the
`basic` container: 1/4 vCPU, 1 GiB). With a 5 s boot, ~8 s of database
waits and the 60 s sleep timeout (estimates), a 5-minute video costs about
$0.00052 at list prices (container memory, CPU, disk and its Durable
Object; queue, R2 and request operations ~$0.00002). At 50 or 500 videos a
month that's all inside Workers Paid's included usage, so $5.00 a month (the
Workers Paid minimum, which the account already pays); the 742 MB reference
copy is inside R2's free 10 GB.

## Supabase: moonshots only
`supabase/migrations/` is the one folder for every migration recorded on the
moonshots project, each named `<recorded version>_<recorded name>.sql` with
exactly the recorded statements (the repo was fixed to match the database,
Oct 10 2026; the database's history was not rewritten):
- `20260926233155_ms001_clearance_queue`, `20260927000016_ms001_anon_insert_grant`,
  `20260927024850_ms001_emailed_at`: MS-001 (clearance-check), moved here
  from `clearance-check/supabase/migrations`.
- `20260927000050_ms001_cleanup_probe_rows`,
  `20260927024904_ms001_cleanup_approved_keep_none`: historical, data-only,
  already applied; never re-run (a header comment says so).
- `20261008192425_ms006_track_detection` (was `20261007000000_…`, same
  content), applied to moonshots only on 2026-10-08:
`ms006_catalog`, `ms006_fp`, `ms006_scans`, RPCs `ms006_match` and
`ms006_track_window`. RLS on, no policies: anon/authenticated get nothing; the
Worker uses the moonshots service role from the `SUPABASE_SECRET_KEY` Secret
already set on it for the clearance cron (`SUPABASE_SERVICE_ROLE_KEY` also
works; a JWT key for another project is refused).

`supabase/migrations/20261009000000_ms007_processing.sql` (MS-007, written,
NOT applied anywhere; Spencer reviews it first; apply as one file, never
`supabase db push`): `ms006_scans` gains `status` (queued / working / done /
failed, default done), `attempts`, `updated_at`, `error`, `proc_ms`,
`cpu_ms`, `peak_mb`, `separation`, a found-only-when-done check and the
open-jobs index. Tested on PGlite (`test/unit/sql-ms007.test.mjs`).

## Cloudflare (MS-007)
Bindings: `UPLOADS` (R2 `ms007-uploads`), `JOBS` (queue `ms007-jobs`, dead
letters to `ms007-jobs-dlq`), `PROCESSOR` (the container, `basic`, up to 3),
vars `R2_REF_BUCKET` / `CLOUDFLARE_ACCOUNT_ID`, secrets
`R2_REF_ACCESS_KEY_ID` / `R2_REF_SECRET_ACCESS_KEY` (read-only on
`ms007-catalog-ref`). They are NOT in the root `wrangler.jsonc` yet: Wrangler
creates a missing R2 bucket named in config on deploy and on
`versions upload`, so the bindings wait for the resources, which wait for
Spencer. The resource runbook and the config patch are in /workspace/ms007
(cloudflare_runbook.md, build/wrangler-ms007-bindings.patch). Until then
`POST /api/scan` answers 503 naming the missing bindings.

Size: Supabase Free (500 MB). `ms006_fp` is ~40 rows per second of catalog
audio at ~74.5 bytes a row with its indexes (measured on PGlite): about
1.9M rows / 140 MB for the 224-track catalog (~12.9 h). FANOUT is 2, not 3,
for this (a third fewer rows, no loss on the synthetic sweep).
`build-catalog-index.mjs` stops before 3.8M rows (~283 MB).

Production (`uprfsmwbsvzuoiyfgtgx`) is only ever read: by
`scripts/build-catalog-index.mjs` (with `--tracks-file`: keyless GET of the
public `Tracks` bucket only; otherwise also anon GET of `Tracks`/`Albums`/
`Artists`; `scripts/lib/targets.mjs` throws on anything else) and by the
result page's Play button streaming a track's public `track_ref`.

## Scripts
- `scripts/build-catalog-index.mjs`: fingerprint the catalog into moonshots
  (header of the file has every option). Track list from a file
  (`--tracks-file`, no production REST, no production key) or production
  REST (`PROD_SUPABASE_ANON_KEY`); audio from the public Tracks bucket,
  keyless, cached in `--cache-dir` (one download per track, ever), under an
  egress budget (`--max-egress-bytes`, default 5,900,000,000). Crash-safe and
  resumable; per-track failures are listed in the `--report`. Stops before
  3.8M `ms006_fp` rows. Exit 0 / 2 (some tracks failed) / 1 (aborted).
- `scripts/make-test-videos.mjs`: the RA_TEST_ videos for the DONE WHEN checks
  (two tracks under voice-over, no catalog music x2, ten quiet beds at -20 dB
  plus ten dev ones, optional level sweep) with local ffmpeg and a manifest of
  expected results. Audio from `--catalog-dir` (the index build cache); it
  refuses to run without it unless `--allow-prod-download`. Voice-over:
  LibriSpeech test-clean (CC BY 4.0, openslr.org/12), `--speech-dir`.
  Output stays outside git (it contains catalog audio).
- `scripts/tune.mjs`: round-B tuning loop against the real index, Node only,
  DB answers cached; `--set NAME=VALUE` tries matcher overrides
  (`TUNABLES` in `src/match.js`).
- `scripts/clear-test-scans.mjs`: delete the `RA_TEST_` scans from moonshots.
- `scripts/replica.mjs`: the offline replica of the index (fingerprints of
  the cached catalog, matched in memory; `--index-opts` builds an
  experimental index variant).
- `scripts/make-negatives.mjs`: extra negative videos (one LibriSpeech
  speaker each; voice only, synthetic music, real catalog music left out
  of the index).
- Manifest kinds come from file names (`scripts/lib/kinds.mjs`):
  `RA_TEST_quiet_*` acceptance, `RA_TEST_dev_quiet_*` dev,
  `RA_TEST_sweep_*` sweep.
- `scripts/build-assets.mjs`: the asset merge (root `npm run build`).
- `scripts/build-ref-audio.mjs` (MS-007): the 8 kHz catalog reference copy
  plus `manifest.json` (ids, bytes, sha256), from the local audio cache:
  `--cache-dir /workspace/ms006/audio-cache --out /workspace/ms007/ref`.
- `scripts/score.mjs` (MS-007): the local scored run. Each clip goes the
  production way minus the network: soundtrack read like the page
  (`scripts/lib/soundtrack.mjs`), body to an R2 stand-in, `src/process.js`
  against the offline replica and the local reference copy, upload deleted
  and checked gone. CSV in the MS-006 results' columns plus the new start
  error. `--split practice` takes `--set` REFINE overrides; `--split all` /
  `scored` take the frozen REFINE and refuse to run twice into one `--out`.

## Phase 2 (run by Builder; env var names only, values from Builder's env)
Files live in `/workspace/ms006` (outside the repo). Production is only ever
read, keyless, for the one index-build download; everything after reuses
the cache.

1. Index (the only production egress; rerun the same command to resume):
   ```
   MOONSHOTS_SUPABASE_URL=… MOONSHOTS_SERVICE_ROLE_KEY=… \
   node scripts/build-catalog-index.mjs \
     --tracks-file /workspace/ms006/prod_catalog_tracks.json \
     --cache-dir /workspace/ms006/audio-cache \
     --report /workspace/ms006/index-report.json
   ```
   (`--dry-run` first lists the tracks and their cache state with no network.)
2. Test videos (offline, from the cache):
   ```
   node scripts/make-test-videos.mjs --catalog-dir /workspace/ms006/audio-cache \
     --speech-dir /workspace/ms006/librispeech --out /workspace/ms006/videos \
     [--only two_tracks,no_music,quiet,dev] [--two-tracks ID,ID]
   ```
3. Tuning on the dev videos only (round B). Offline, on a replica of the
   index rebuilt from the cache (no keys, no network):
   ```
   node scripts/replica.mjs --cache-dir /workspace/ms006/audio-cache --out /workspace/ms006/replica
   node scripts/make-negatives.mjs --catalog-dir /workspace/ms006/audio-cache \
     --speech-dir /workspace/ms006/librispeech/LibriSpeech/test-clean --out /workspace/ms006/videos-dev-neg
   node scripts/tune.mjs --replica /workspace/ms006/replica --catalog-dir /workspace/ms006/audio-cache \
     --manifest /workspace/ms006/videos/manifest.json --manifest /workspace/ms006/videos-dev-neg/manifest.json \
     --kind dev,sweep,no_music,two_tracks --out /workspace/ms006/replica/tune [--set NAME=VALUE …]
   ```
   or against the real index (dev / sweep / no_music only; leave-one-out
   negatives are replica-only):
   ```
   SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/tune.mjs \
     --manifest /workspace/ms006/videos/manifest.json --kind dev,sweep,no_music \
     --out /workspace/ms006/tune [--set NAME=VALUE …]
   ```
   `--kind quiet` (the acceptance set) is refused unless `--allow-acceptance`.
4. Browser suite against the real index (`npm run build` first):
   ```
   SUPABASE_URL=… SUPABASE_SECRET_KEY=… VIDEOS=/workspace/ms006/videos \
   CATALOG=/workspace/ms006/audio-cache OUT=/workspace/ms006/e2e-real \
   SELECT=two_tracks,no_music,quiet node test/e2e-real.mjs
   ```
   Scans are labelled `RA_TEST_ms006_<video>`; Play audio comes from the
   cache; one keyless HEAD per two-track result track checks the real URL.
5. Clean up the test scans:
   ```
   MOONSHOTS_SUPABASE_URL=… MOONSHOTS_SERVICE_ROLE_KEY=… node scripts/clear-test-scans.mjs --dry-run
   MOONSHOTS_SUPABASE_URL=… MOONSHOTS_SERVICE_ROLE_KEY=… node scripts/clear-test-scans.mjs
   ```

## Tests
- `npm test`: unit tests on synthetic audio made in `test/synth.mjs`
  (fingerprint, matcher incl. clean / no-match / quiet-bed cases, start times
  and the REFINE / threshold lock, the upload body, the processor, the
  reference readers incl. SigV4 against AWS's example, both migrations on
  PGlite, the Worker's upload / queue / dead-letter / sweep / status routes
  and clearance passthrough, production guards and the index builder). No
  network. Node loads the Worker with `test/cf-register.mjs` (a stub for
  `cloudflare:workers`, the one Workers-only module).
- `npm run e2e`: Chrome (`/opt/google/chrome/chrome` or `CHROMIUM`) through
  the real pages, with synthetic videos from `make-test-videos.mjs`, a fake
  moonshots, and local stand-ins for R2, the queue and the container running
  the real processor (`test/harness.mjs`, `test/local-cloud.mjs`,
  `test/fake-moonshots.mjs`); the checks are `test/browser-suite.mjs`, shared
  with `test/e2e-real.mjs`, including the slow paths (cold container plus
  database timeouts, a crash, a 90 s job, retries used up), the result
  page's working state and the header (DOM and one-colour pixels).
  Screenshots to `SHOTS` (default `test/out/shots`); work files under TMPDIR.
- `npm run e2e:real`: the same against the real moonshots index (needs the
  MS-007 migration applied and Builder's moonshots key; pending Spencer's
  approval). `npm run e2e:real:smoke`: that script offline, on synthetic
  media and the fake moonshots (which blocks every other host).

## Not final
- `src/match.js` defaults and the `QUERY` preset are tuned (round B) on an
  offline replica of the real index with 30 dev videos and 17 negatives;
  the acceptance videos (`RA_TEST_quiet_*`) were never used.

Third-party files: mp4box.js (BSD-3-Clause, `public/music/vendor/mp4box/LICENSE`),
Patrick Hand and Inter (SIL OFL 1.1, `public/music/fonts/`).
