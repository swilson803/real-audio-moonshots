# Catalogue Bot: clearance queue tooling (MS-003)

Two scripts the Catalogue Bot runs from its own machine to work the clearance
`submissions` queue, the same way it runs `generate_test_clips.py` for the
production catalog.

They talk **only** to the moonshots Supabase project (`kucwpmtkctafzkivuqtu`)
and refuse to start if the env points at Real Audio production
(`uprfsmwbsvzuoiyfgtgx`) or any other project. They never send email (that is
MS-004) and never post to a platform (the bot uploads by hand).

## Setup (once per machine)

Needs Python 3.9+, `ffmpeg` on `PATH`, and:

```bash
pip install -r clearance-check/bot/requirements.txt
```

Env vars:

| Var | Required | Value |
|-----|----------|-------|
| `MOONSHOTS_SUPABASE_URL` | yes | `https://kucwpmtkctafzkivuqtu.supabase.co` |
| `MOONSHOTS_SERVICE_ROLE_KEY` | yes | moonshots service role / secret key |
| `CLEARANCE_CLIP_DIR` | no | where clips are written; default `./clips` |

The `MOONSHOTS_` prefix lets these sit alongside the production `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` on the same machine. The bot never reads the
production names, so there is nothing to swap between runs.

If a required var is missing, or the URL/key is for production or another
project, the script prints `error: ...` to stderr and exits 1 without touching
the network.

## Playbook

Run from `clearance-check/bot/`.

**1. Pull the next submission**

```bash
python3 pull_next.py
```

Claims the oldest `queued` row (status becomes `checking`), downloads its audio
from `clearance-uploads`, and writes a 61-second black-screen clip
(1280x720 @ 30fps, H.264 stillimage, yuv420p, AAC 192k) named `{id}_test.mp4`.
Output:

```
id=0b6c...
status=checking
clip=/abs/path/clips/0b6c..._test.mp4
original_filename=song.mp3
```

`queue empty` means nothing is queued; stop. If the download or ffmpeg fails,
the row is set to `failed` and the script exits 1.

**2. Check the clip on each platform by hand.** Upload `clip`, note the outcome,
don't publish.

**3. Record each platform result**

```bash
python3 record_result.py --id "$ID" --platform youtube   --result clear
python3 record_result.py --id "$ID" --platform tiktok    --result claimed --note "Artist - Title"
python3 record_result.py --id "$ID" --platform instagram --result muted
```

- `--platform`: `youtube` | `tiktok` | `instagram`
- `--result`: `clear` | `claimed` | `muted` | `error`
- `--note`: optional. Omit to keep the existing note; `--note ""` clears it.

Any order works. The row flips to `done` after the third platform is recorded.
Recording a platform again overwrites its result (and note, if given). Output
lists `status` and all three results.

## Tests

```bash
python3 test_bot.py
```

Uses an in-memory fake Supabase (no network) and real ffmpeg/ffprobe on a
generated fixture to check the clip is 61s, 1280x720 H.264 + AAC.
