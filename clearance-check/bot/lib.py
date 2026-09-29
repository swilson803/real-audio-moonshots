#!/usr/bin/env python3
"""Shared helpers for clearance-check Catalogue Bot tooling (MS-003).

Talks only to the moonshots Supabase project. Refuses production.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

MOONSHOTS_REF = "kucwpmtkctafzkivuqtu"
PRODUCTION_REF = "uprfsmwbsvzuoiyfgtgx"
BUCKET = "clearance-uploads"

PLATFORMS = ("youtube", "tiktok", "instagram")
RESULTS = ("clear", "claimed", "muted", "error")

# Same ffmpeg shape as production generate_test_clips.py (format reference only).
FFMPEG_CLIP_ARGS = [
    "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30",
    # "-i", audio_path  inserted by caller
    "-t", "61",
    "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
]


class BotError(Exception):
    """User-facing failure; message already suitable for stderr."""


def _jwt_ref(key: str) -> str | None:
    try:
        import base64
        parts = key.split(".")
        if len(parts) < 2:
            return None
        pad = "=" * ((4 - len(parts[1]) % 4) % 4)
        payload = base64.urlsafe_b64decode(parts[1] + pad)
        return json.loads(payload).get("ref")
    except Exception:
        return None


def load_env() -> dict:
    """Require moonshots-only SUPABASE_URL + service role key. Clear errors."""
    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SECRET_KEY")
        or os.environ.get("SUPABASE_KEY")
        or ""
    ).strip()

    missing = []
    if not url:
        missing.append("SUPABASE_URL")
    if not key:
        missing.append("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY / SUPABASE_KEY)")
    if missing:
        raise BotError(
            "Missing required env var(s): " + ", ".join(missing) + ". "
            "Set them to the moonshots project only "
            f"(ref {MOONSHOTS_REF})."
        )

    if PRODUCTION_REF in url:
        raise BotError(
            "Refusing to talk to Real Audio production Supabase "
            f"({PRODUCTION_REF}). Use moonshots ({MOONSHOTS_REF}) only."
        )
    if MOONSHOTS_REF not in url:
        raise BotError(
            f"SUPABASE_URL must be the moonshots project ({MOONSHOTS_REF}). "
            f"Got: {url}"
        )

    ref = _jwt_ref(key)
    if ref == PRODUCTION_REF:
        raise BotError(
            "Refusing a Supabase key for Real Audio production. "
            f"Use a moonshots ({MOONSHOTS_REF}) service role key."
        )
    if ref and ref != MOONSHOTS_REF:
        raise BotError(
            f"Refusing a Supabase key for another project (ref={ref}). "
            f"Moonshots only ({MOONSHOTS_REF})."
        )

    return {
        "url": url,
        "key": key,
        "clip_dir": (os.environ.get("CLEARANCE_CLIP_DIR") or "./clips").strip(),
    }


def clip_dir() -> str:
    return (os.environ.get("CLEARANCE_CLIP_DIR") or "./clips").strip()


def supabase_headers(key: str, *, json_body: bool = False) -> dict:
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    if json_body:
        h["Content-Type"] = "application/json"
    return h


def request(method: str, url: str, headers: dict, body: bytes | None = None, timeout: int = 120):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, raw, dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, raw, dict(e.headers)


def rest_get(env: dict, path_query: str):
    status, raw, _ = request(
        "GET",
        f"{env['url']}/rest/v1/{path_query}",
        supabase_headers(env["key"]),
    )
    if status >= 400:
        raise BotError(f"Supabase GET failed ({status}): {raw.decode('utf-8', 'replace')[:500]}")
    return json.loads(raw.decode() or "null")


def rest_patch(env: dict, path_query: str, payload: dict):
    status, raw, _ = request(
        "PATCH",
        f"{env['url']}/rest/v1/{path_query}",
        {**supabase_headers(env["key"], json_body=True), "Prefer": "return=representation"},
        json.dumps(payload).encode(),
    )
    if status >= 400:
        raise BotError(f"Supabase PATCH failed ({status}): {raw.decode('utf-8', 'replace')[:500]}")
    return json.loads(raw.decode() or "[]")


def storage_download(env: dict, object_path: str) -> bytes:
    # service role download from private bucket
    enc = "/".join(urllib.parse.quote(p, safe="") for p in object_path.split("/"))
    status, raw, _ = request(
        "GET",
        f"{env['url']}/storage/v1/object/{BUCKET}/{enc}",
        supabase_headers(env["key"]),
        timeout=180,
    )
    if status >= 400:
        raise BotError(
            f"Storage download failed ({status}) for {object_path!r}: "
            f"{raw.decode('utf-8', 'replace')[:500]}"
        )
    return raw


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)
