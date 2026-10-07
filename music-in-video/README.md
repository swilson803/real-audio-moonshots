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
`supabase/migrations/20261007000000_ms006_track_detection.sql` (NOT applied):
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
`scripts/build-catalog-index.mjs` (anon key, GET/HEAD of `Tracks`/`Albums`/
`Artists` and the public `Tracks` bucket; `scripts/lib/targets.mjs` throws on
anything else) and by the result page's Play button streaming a track's public
`track_ref`.

## Scripts
- `scripts/build-catalog-index.mjs`: fingerprint the active catalog into
  moonshots. `node --env-file=.env scripts/build-catalog-index.mjs [--dry-run] [--limit N]`.
  `.env` (gitignored): `PROD_SUPABASE_ANON_KEY`, `MOONSHOTS_SUPABASE_URL`,
  `MOONSHOTS_SERVICE_ROLE_KEY`. Downloads every track's audio (~5.5 GB of
  production egress the first time; reruns skip unchanged files by sha256).
- `scripts/make-test-videos.mjs`: the RA_TEST_ videos for the DONE WHEN checks
  (two tracks under voice-over, no catalog music x2, ten quiet beds at -20 dB
  plus ten dev ones, optional level sweep) with local ffmpeg and a manifest of
  expected results. Voice-over: LibriSpeech test-clean (CC BY 4.0,
  openslr.org/12), passed with `--speech-dir`. Output stays in `test-videos/`
  (gitignored: it contains catalog audio).
- `scripts/build-assets.mjs`: the asset merge (root `npm run build`).
- `scripts/make-headline.mjs`: renders the stand-in headline PNG.

## Tests
- `npm test`: unit tests on synthetic audio made in `test/synth.mjs`
  (fingerprint, matcher incl. clean / no-match / quiet-bed cases, the migration
  on PGlite, Worker routes and clearance passthrough, production guards and the
  index builder). No network.
- `npm run e2e`: Chrome (`/opt/google/chrome/chrome` or `CHROMIUM`) through
  the real pages, with synthetic videos from `make-test-videos.mjs` and a fake
  moonshots behind the Worker (`test/harness.mjs`); screenshots to `SHOTS`
  (default `/tmp/ms006_shots`).
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
