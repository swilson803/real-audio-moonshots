# music-in-video

MS-006: a creator picks a finished video on `/music/`; the page finds the Real
Audio tracks in it and gives one link, `/v/<id>`, listing every found track in
order with its start time, title, artist and a stream button, plus a one-tap
copy of `music in this video: <link>` for the video description. No account.

Shares the clearance-check Worker and domain (copyrighttester.real.audio):
`src/worker.js` handles `/music/`, `/v/<id>`, `POST /api/scan` and
`GET /api/scans/<id>`, and passes every other request, and the cron, to
`clearance-check/src/worker.js` unchanged. The root `wrangler.jsonc` points
here; `npm run build` at the root (Wrangler's `build.command`) merges
`clearance-check/public` and `public/` into `dist/` and fails on any path
collision.

## The video never leaves the device
`public/music/extract.js` reads the file in slices in the browser (mp4box.js +
WebCodecs for MP4/MOV/M4V with AAC; decodeAudioData for WebM or without
WebCodecs), downmixes and resamples to 16 kHz and fingerprints as it decodes.
Only the fingerprint (~20 KB a minute) is POSTed. Nothing stores the video or
its audio; `ms006_scans` keeps only the result.

## Matching (`public/music/fp.js`, `src/match.js`)
Landmark fingerprints: spectral peaks picked per frequency band after a
running-mean whitening (bass and hats keep producing peaks under speech),
paired into 24-bit hashes (each peak with the next 2, `FANOUT`). Stage 1 (Postgres `ms006_match`) groups hash hits
by track and time offset. Stage 2 verifies each candidate alignment with single
peak coincidences, rebuilt from the hashes, against an off-alignment chance
level, gives each second of the video to the locally strongest alignment
(music repeats), and sets start and end from where coincidences are dense.
`clustersInMemory` / `trackWindowInMemory` mirror the two RPCs for tests;
`test/unit/sql.test.mjs` checks they agree.

## Supabase: moonshots only
`supabase/migrations/20261007000000_ms006_track_detection.sql`, applied to
moonshots only on 2026-10-08 (recorded there as version 20261008192425,
ms006_track_detection; the repo file keeps its name):
`ms006_catalog`, `ms006_fp`, `ms006_scans`, RPCs `ms006_match` and
`ms006_track_window`. RLS on, no policies: anon/authenticated get nothing; the
Worker uses the moonshots service role from the `SUPABASE_SECRET_KEY` Secret
already set on it for the clearance cron (`SUPABASE_SERVICE_ROLE_KEY` also
works; a JWT key for another project is refused). No new Worker secrets.

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
- `scripts/build-assets.mjs`: the asset merge (root `npm run build`).
- `scripts/make-headline.mjs`: renders the stand-in headline PNG.

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
3. Tuning on the dev videos only (round B):
   ```
   SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/tune.mjs \
     --manifest /workspace/ms006/videos/manifest.json --kind dev \
     --out /workspace/ms006/tune [--set NAME=VALUE …]
   ```
   (add `--offline` to re-run from the cache only.)
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
  (fingerprint, matcher incl. clean / no-match / quiet-bed cases, the migration
  on PGlite, Worker routes and clearance passthrough, production guards and the
  index builder). No network.
- `npm run e2e`: Chrome (`/opt/google/chrome/chrome` or `CHROMIUM`) through
  the real pages, with synthetic videos from `make-test-videos.mjs` and a fake
  moonshots behind the Worker (`test/harness.mjs`, `test/fake-moonshots.mjs`);
  the checks are `test/browser-suite.mjs`, shared with `test/e2e-real.mjs`;
  screenshots to `SHOTS` (default `/tmp/ms006_shots`).
- `npm run e2e:real:smoke`: `test/e2e-real.mjs` itself, offline, on synthetic
  media and the fake moonshots (which blocks every other host).
- Local Worker: `wrangler dev` from the repo root. On Node 20 use wrangler
  4.86 (the devDependency) with `--compatibility-date 2026-05-03`; its runtime
  predates the config's 2026-09-01.

## Not final
- The headline PNG is a rendered stand-in (Patrick Hand, hatched) for
  Spencer's hand-drawn art.
- Thresholds in `src/match.js` are tuned on synthetic audio only; phase 2
  calibrates them on the dev videos made from the real catalog.

Third-party files: mp4box.js (BSD-3-Clause, `public/music/vendor/mp4box/LICENSE`),
Patrick Hand and Inter (SIL OFL 1.1, `public/music/fonts/`).
