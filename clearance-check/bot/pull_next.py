#!/usr/bin/env python3
"""Claim the oldest queued clearance submission and build a 61s test clip.

HOW TO RUN (Catalogue Bot playbook):
  export SUPABASE_URL=https://kucwpmtkctafzkivuqtu.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=...   # moonshots service role only
  # optional: export CLEARANCE_CLIP_DIR=~/clearance-clips
  cd .../real-audio-moonshots/clearance-check/bot
  python3 pull_next.py

Prints submission id and clip path on success. Does not post anywhere.
Does not send email. Moonshots Supabase only.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

from lib import (
    BotError,
    clip_dir,
    die,
    load_env,
    rest_get,
    rest_patch,
    storage_download,
)


def claim_oldest(env: dict) -> dict | None:
    rows = rest_get(
        env,
        "submissions?status=eq.queued&order=created_at.asc&limit=1&select=*",
    )
    if not rows:
        return None
    row = rows[0]
    claimed = rest_patch(
        env,
        f"submissions?id=eq.{row['id']}&status=eq.queued",
        {"status": "checking"},
    )
    if not claimed:
        # Lost race to another worker
        return None
    return claimed[0]


def make_clip(audio_path: str, output_path: str) -> None:
    # Match production generate_test_clips.py (format reference only).
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30",
        "-i", audio_path,
        "-t", "61",
        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "unknown").strip().splitlines()
        raise BotError(f"ffmpeg failed: {tail[-1] if tail else 'unknown'}")


def audio_suffix(storage_path: str, original_filename: str) -> str:
    for name in (original_filename, storage_path):
        ext = os.path.splitext(name.split("?")[0])[1].lower()
        if ext in (".mp3", ".wav", ".m4a", ".mpeg", ".mp4"):
            return ext if ext != ".mpeg" else ".mp3"
    return ".mp3"


def main() -> int:
    try:
        env = load_env()
    except BotError as e:
        die(str(e))

    try:
        row = claim_oldest(env)
    except BotError as e:
        die(str(e))

    if row is None:
        print("Queue empty (no queued submissions, or claim lost a race).")
        return 0

    sid = row["id"]
    storage_path = row["storage_path"]
    out_dir = clip_dir()
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{sid}_test.mp4")

    tmp_audio = None
    try:
        audio_bytes = storage_download(env, storage_path)
        suffix = audio_suffix(storage_path, row.get("original_filename") or "")
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        tmp_audio = tmp.name
        tmp.write(audio_bytes)
        tmp.close()
        make_clip(tmp_audio, out_path)
    except BotError as e:
        try:
            rest_patch(env, f"submissions?id=eq.{sid}", {"status": "failed"})
        except BotError as e2:
            print(f"Also failed to mark row failed: {e2}", file=sys.stderr)
        die(f"Pull failed for {sid}: {e}")
    finally:
        if tmp_audio and os.path.exists(tmp_audio):
            os.unlink(tmp_audio)

    print(f"id={sid}")
    print(f"status=checking")
    print(f"clip={os.path.abspath(out_path)}")
    print(f"original_filename={row.get('original_filename') or ''}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BotError as e:
        die(str(e))
