# Clearance bot tooling (MS-003)

Catalogue Bot works the moonshots `submissions` queue from its own machine —
same idea as running `generate_test_clips.py` for the production catalog, but
**only** against the moonshots Supabase project (`kucwpmtkctafzkivuqtu`).

Never point these scripts at production (`uprfsmwbsvzuoiyfgtgx`). They refuse.

## What it does

1. **`pull_next.py`** — claim the oldest `queued` row → `checking`, download its
   audio from `clearance-uploads`, write a 61-second black-screen test clip
   (`{id}_test.mp4`) in the same ffmpeg format as the production clearance flow.
2. **`record_result.py`** — record one platform result (`youtube` / `tiktok` /
   `instagram` → `clear` | `claimed` | `muted` | `error`, optional note).
   Re-recording overwrites. The row becomes `done` only after all three
   platforms are non-`pending`.

Does **not** send email (MS-004 / Worker). Does **not** post to any platform —
the bot uploads the clip by hand.

## Env (required)

```bash
export SUPABASE_URL=https://kucwpmtkctafzkivuqtu.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...   # moonshots service role (or SUPABASE_SECRET_KEY / SUPABASE_KEY)
# optional:
export CLEARANCE_CLIP_DIR="$HOME/clearance-clips"   # default: ./clips
```

Missing vars or a production URL/key → non-zero exit and a clear stderr message.

## Playbook commands

```bash
cd /path/to/real-audio-moonshots/clearance-check/bot

# 1. Pull oldest queued → clip + status=checking
python3 pull_next.py
# → prints id=… status=checking clip=/abs/path/{id}_test.mp4

# 2. Hand-upload that clip to YouTube / TikTok / Instagram (copyright check only; do not post)

# 3. Record each platform (order free; done flips only after the third)
python3 record_result.py --id "$ID" --platform youtube --result clear
python3 record_result.py --id "$ID" --platform tiktok --result claimed --note "Artist - Title"
python3 record_result.py --id "$ID" --platform instagram --result clear
# Re-record overwrites:
python3 record_result.py --id "$ID" --platform tiktok --result muted --note "recheck"
```

## Tests

```bash
python3 test_bot.py          # mock Supabase + local ffmpeg fixture; no network to real projects
```

## Layout

| File | Role |
|------|------|
| `lib.py` | Env guard, REST/storage helpers |
| `pull_next.py` | Claim + clip |
| `record_result.py` | Platform results → done |
| `test_bot.py` | Harness |
