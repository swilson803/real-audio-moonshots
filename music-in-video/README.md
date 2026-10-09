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
Only the fingerprint is POSTed: the verification peaks plus one bit each
marking the hash peaks (`public/music/body.js`, ~30 KB a minute); the Worker
rebuilds the hashes from them with the same code. Nothing stores the video
or its audio; `ms006_scans` keeps only the result.

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
- Stage 2 (Worker): single-peak coincidences of the video with each
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

Cold start (fix 1): the first `ms006_match` after the database has been idle
can hit PostgREST's 8 s statement timeout (500, code 57014). The Worker
retries moonshots reads on that and on 502/503/504/520-524/network errors
(`RETRY` in `src/scan.js`: 3 tries per read, 1 s then 2 s apart, at most 20
retries and no new try after 40 s per request; the scan row is written once,
never retried), and answers 503 `{"error":"busy"}` past the cap. The page
shows "Still working… this can take up to a minute." after 5 s of matching,
and "The Real Audio catalog is taking too long to answer. Try again in a
minute." on busy.

Cost per 60 s of video: one `ms006_match` call joining ~75k index rows (max
~98k), 16 `ms006_track_window` calls, ~110 ms of Worker CPU (Workers Paid;
over the Free plan's 10 ms).

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
- `src/match.js` defaults and the `QUERY` preset are tuned (round B) on an
  offline replica of the real index with 30 dev videos and 17 negatives;
  the acceptance videos (`RA_TEST_quiet_*`) were never used.

Third-party files: mp4box.js (BSD-3-Clause, `public/music/vendor/mp4box/LICENSE`),
Patrick Hand and Inter (SIL OFL 1.1, `public/music/fonts/`).
