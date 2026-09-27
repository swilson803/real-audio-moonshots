# clearance-check

MS-002: upload a track (mp3/wav/m4a, ≤ 50 MB) + email → queued row in
`public.submissions` (MS-001) → `/r/<id>` shows per-platform status, a verdict
when all three are in, and a permanent "reflects right now" warning. One results
email via Resend when `status = done` and `emailed_at is null`; `emailed_at` is
then set so reloads never resend.

Supabase: moonshots project `kucwpmtkctafzkivuqtu` only. Never production.

## Layout
- `public/` static page (plain HTML/CSS/JS). `styles.css` copies the Real Audio
  sketched system verbatim from real-audio-creator `src/index.css`; frames,
  linen texture and logo are copied from its `public/brand-assets` and `src/assets`.
- `src/worker.js` Cloudflare Worker: `/api/config`, `/api/notify`, `/r/*`, and a
  1-minute cron sweep that emails done rows nobody has open.
- `src/email.js` Resend email (markup follows Creator's send-download-email).
- `wrangler.jsonc` Worker config. **Workers Builds root directory must be
  `clearance-check`** (a Cloudflare setting; it cannot be set from the repo).

## Worker secrets (not committed)
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` (moonshots).
Optional vars: `SITE_URL` (required for the cron sweep's links), `EMAIL_FROM`
(default `Real Audio <hello@real.audio>`).

## Test
`npm test` runs `test/e2e.mjs`: the Worker on Node with a fake Supabase and fake
Resend (no network, no real project), driven by Playwright. Screenshots land in
`docs/screenshots/`.
