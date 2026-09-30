#!/usr/bin/env python3
"""Claim the oldest queued submission and build its 61s black-screen test clip.

    python3 pull_next.py

Moves the row queued -> checking, downloads its audio from clearance-uploads,
and writes {id}_test.mp4 into CLEARANCE_CLIP_DIR (default ./clips). If the
download or ffmpeg fails the row is set to failed. Prints key=value lines:
id, status, clip, original_filename. Prints "queue empty" when nothing is queued.
"""

from __future__ import annotations

import os
import subprocess
import tempfile

from lib import BUCKET, BotError, Supabase, load_config, run

CLAIM_ATTEMPTS = 5


def claim_next(db: Supabase):
    """Flip the oldest queued row to checking. None if the queue is empty.

    The PATCH filters on status=queued too, so if another worker claimed the
    row first it matches nothing and we move on to the next oldest.
    """
    for _ in range(CLAIM_ATTEMPTS):
        rows = db.select({
            "select": "*",
            "status": "eq.queued",
            "order": "created_at.asc",
            "limit": "1",
        })
        if not rows:
            return None
        claimed = db.update(
            {"id": f"eq.{rows[0]['id']}", "status": "eq.queued"},
            {"status": "checking"},
        )
        if claimed:
            return claimed[0]
    raise BotError(f"Could not claim a submission after {CLAIM_ATTEMPTS} attempts.")


def build_clip(audio_path, out_path):
    """Same ffmpeg recipe as production generate_test_clips.py."""
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30",
        "-i", audio_path,
        "-t", "61",
        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        out_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        raise BotError("ffmpeg not found on PATH.")
    if proc.returncode != 0:
        lines = proc.stderr.strip().splitlines()
        raise BotError(f"ffmpeg exited {proc.returncode}: {lines[-1] if lines else 'no output'}")


def object_key(storage_path):
    """Object key inside the bucket.

    The landing page writes storage_path as "clearance-uploads/{id}/{file}",
    and download() adds the bucket itself, so drop one leading bucket name.
    Paths without it are used as they are.
    """
    prefix = f"{BUCKET}/"
    return storage_path[len(prefix):] if storage_path.startswith(prefix) else storage_path


def process(db: Supabase, row, clip_dir):
    sid = row["id"]
    out_path = os.path.abspath(os.path.join(clip_dir, f"{sid}_test.mp4"))
    ext = os.path.splitext(row["storage_path"])[1] or ".audio"
    try:
        os.makedirs(clip_dir, exist_ok=True)
        audio = db.download(object_key(row["storage_path"]))
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = os.path.join(tmp, f"source{ext}")
            with open(audio_path, "wb") as f:
                f.write(audio)
            build_clip(audio_path, out_path)
    except (BotError, OSError) as e:
        try:
            db.update({"id": f"eq.{sid}"}, {"status": "failed"})
        except BotError as mark_err:
            raise BotError(f"{sid}: {e} (and could not mark it failed: {mark_err})")
        raise BotError(f"{sid} marked failed: {e}")
    return out_path


def main():
    config = load_config()
    db = Supabase(config)
    row = claim_next(db)
    if row is None:
        print("queue empty")
        return 0
    clip = process(db, row, config.clip_dir)
    print(f"id={row['id']}")
    print(f"status={row['status']}")
    print(f"clip={clip}")
    print(f"original_filename={row.get('original_filename') or ''}")
    return 0


if __name__ == "__main__":
    run(main)
