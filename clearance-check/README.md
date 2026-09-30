# clearance-check

MS-002: upload a track (mp3/wav/m4a; no size cap in the page, the storage bucket decides) + email → queued row in
`public.submissions` (MS-001) → `/r/<id>` shows per-platform status, a verdict
when all three are in, and a permanent "reflects right now" warning.

MS-004: one results email via Resend per submission. A 1-minute Worker cron
finds rows with `status = done` and `emailed_at is null`, claims each by setting
`emailed_at` (atomic, so overlapping runs send once), and sends. It doesn't
matter who set the row to done (the Catalogue Bot, with the service role), and
no page has to be open; the browser never triggers a send. A failed send clears
the claim so the next run retries; Resend's `Idempotency-Key`
(`clearance-result:<id>`) stops a lost-response retry from delivering twice.

Supabase: moonshots project `kucwpmtkctafzkivuqtu` only. Never production.

## Layout
- `public/` static page (plain HTML/CSS/JS). `styles.css` copies the Real Audio
  sketched system verbatim from real-audio-creator `src/index.css`; frames,
  linen texture and logo are copied from its `public/brand-assets` and `src/assets`.
- `src/worker.js` Cloudflare Worker: `/api/config`, `/r/*`, and the 1-minute
  cron sweep that sends the results email.
- `src/email.js` Resend email: the structure of Creator's license email
  (`send-download-email`) in the result page's cream, red, ink and Patrick Hand
  (mono fallback). Text wordmark, no images.
- `wrangler.jsonc` Worker config. **Workers Builds root directory must be
  `clearance-check`** (a Cloudflare setting; it cannot be set from the repo).

## Worker secrets and vars (not committed)
Secrets: `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) and
`RESEND_API_KEY`, both for moonshots. Vars: `SITE_URL` (the site's public origin;
without it the cron logs a warning and sends nothing), optional `EMAIL_FROM`
(default `Real Audio <hello@real.audio>`). `SUPABASE_URL` and the public
`SUPABASE_ANON_KEY` are committed in `wrangler.jsonc`. If a secret is missing
the cron logs its name and skips.

## Test
`npm test` runs `test/e2e.mjs`: the Worker on Node with a fake Supabase and fake
Resend (no network, no real project), driven by Playwright; the cron is run
directly with a fake `SITE_URL`. Screenshots land in `docs/screenshots/`,
including the email (`email-flagged-600`, `email-clear-600`, `email-375`).

## Catalogue Bot tooling (MS-003)
`bot/` — pull the oldest queued submission into a 61s black-screen test clip and
record per-platform results (`checking` → `done` after all three). Moonshots
Supabase only; refuses production. See `bot/README.md`.
