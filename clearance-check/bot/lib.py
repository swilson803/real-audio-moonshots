"""Shared plumbing for the clearance-check Catalogue Bot scripts (MS-003).

Everything here talks to the moonshots Supabase project and nothing else.
load_config() refuses to hand back a config when env vars are missing or when
the URL or key points anywhere other than moonshots (production included).
"""

from __future__ import annotations

import base64
import json
import os
import sys
from dataclasses import dataclass
from urllib.parse import quote, urlparse

MOONSHOTS_REF = "kucwpmtkctafzkivuqtu"
PRODUCTION_REF = "uprfsmwbsvzuoiyfgtgx"
BUCKET = "clearance-uploads"
TABLE = "submissions"

PLATFORMS = ("youtube", "tiktok", "instagram")
RESULTS = ("clear", "claimed", "muted", "error")

# Prefixed so they can sit next to production SUPABASE_* vars on the same machine.
URL_VAR = "MOONSHOTS_SUPABASE_URL"
KEY_VAR = "MOONSHOTS_SERVICE_ROLE_KEY"
DEFAULT_CLIP_DIR = "./clips"


class BotError(Exception):
    """A failure the bot should see as one clear line on stderr."""


@dataclass(frozen=True)
class Config:
    url: str
    key: str
    clip_dir: str


def _key_ref(key):
    """Project ref baked into a legacy JWT key, or None for opaque keys."""
    parts = key.split(".")
    if len(parts) != 3:
        return None
    try:
        body = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(body)).get("ref")
    except (ValueError, UnicodeDecodeError, AttributeError):
        return None


def load_config(environ=None) -> Config:
    environ = os.environ if environ is None else environ
    url = (environ.get(URL_VAR) or "").strip().rstrip("/")
    key = (environ.get(KEY_VAR) or "").strip()

    missing = []
    if not url:
        missing.append(URL_VAR)
    if not key:
        missing.append(KEY_VAR)
    if missing:
        raise BotError(
            f"Missing env var(s): {', '.join(missing)}. Set them to the moonshots "
            f"Supabase project ({MOONSHOTS_REF}) before running the bot."
        )

    if PRODUCTION_REF in url or PRODUCTION_REF in key or _key_ref(key) == PRODUCTION_REF:
        raise BotError(
            f"Refusing to run: env points at Real Audio production ({PRODUCTION_REF}). "
            f"The bot only works against moonshots ({MOONSHOTS_REF})."
        )

    parsed = urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() != f"{MOONSHOTS_REF}.supabase.co":
        raise BotError(
            f"Refusing to run: {URL_VAR} must be https://{MOONSHOTS_REF}.supabase.co "
            f"(moonshots), got {url!r}."
        )

    ref = _key_ref(key)
    if ref is not None and ref != MOONSHOTS_REF:
        raise BotError(
            f"Refusing to run: {KEY_VAR} belongs to project {ref!r}, "
            f"not moonshots ({MOONSHOTS_REF})."
        )

    clip_dir = (environ.get("CLEARANCE_CLIP_DIR") or "").strip() or DEFAULT_CLIP_DIR
    return Config(url=url, key=key, clip_dir=clip_dir)


def _default_session():
    try:
        import requests
    except ImportError:
        raise BotError("The requests package is missing: pip install -r requirements.txt")
    return requests.Session()


class Supabase:
    """Minimal PostgREST + Storage client using the service role key."""

    def __init__(self, config: Config, session=None, timeout=120):
        self.config = config
        self.session = session if session is not None else _default_session()
        self.timeout = timeout
        self.headers = {"apikey": config.key, "Authorization": f"Bearer {config.key}"}

    def _check(self, resp, what):
        if resp.status_code >= 400:
            raise BotError(f"{what} failed (HTTP {resp.status_code}): {resp.text[:300]}")
        return resp

    def select(self, params):
        resp = self.session.get(
            f"{self.config.url}/rest/v1/{TABLE}",
            params=params,
            headers=self.headers,
            timeout=self.timeout,
        )
        return self._check(resp, "Reading submissions").json()

    def update(self, filters, values):
        """PATCH rows matching filters; returns the updated rows."""
        resp = self.session.patch(
            f"{self.config.url}/rest/v1/{TABLE}",
            params=filters,
            json=values,
            headers={**self.headers, "Prefer": "return=representation"},
            timeout=self.timeout,
        )
        return self._check(resp, "Updating submission").json()

    def download(self, storage_path):
        path = "/".join(quote(part, safe="") for part in storage_path.split("/"))
        resp = self.session.get(
            f"{self.config.url}/storage/v1/object/{BUCKET}/{path}",
            headers=self.headers,
            timeout=self.timeout,
        )
        return self._check(resp, f"Downloading {BUCKET}/{storage_path}").content


def run(main):
    """Run a script entry point, turning BotError into a stderr line + exit 1."""
    try:
        sys.exit(main() or 0)
    except BotError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
