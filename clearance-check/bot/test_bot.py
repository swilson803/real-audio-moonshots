#!/usr/bin/env python3
"""MS-003 bot harness: mock Supabase + local ffmpeg. No real project, no email."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Allow `python3 test_bot.py` from bot/
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import BotError, load_env  # noqa: E402
import pull_next  # noqa: E402
import record_result  # noqa: E402

MOONSHOTS = "https://kucwpmtkctafzkivuqtu.supabase.co"
PROD = "https://uprfsmwbsvzuoiyfgtgx.supabase.co"
# Fake moonshots-shaped JWT (ref claim only; not a real key)
MOON_JWT = (
    "eyJhbGciOiJub25lIn0."
    "eyJyZWYiOiJrdWN3cG10a2N0YWZ6a2l2dXF0dSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ."
    "x"
)
PROD_JWT = (
    "eyJhbGciOiJub25lIn0."
    "eyJyZWYiOiJ1cHJmc213YnN2enVvaXlmZ3RneCIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ."
    "x"
)


class FakeSB:
    def __init__(self):
        self.rows = {}
        self.objects = {}  # path -> bytes
        self.lock = threading.Lock()

    def seed_queued(self, sid, storage_path, audio: bytes, email="ra_test@example.com"):
        with self.lock:
            self.rows[sid] = {
                "id": sid,
                "created_at": "2026-09-29T00:00:00Z",
                "email": email,
                "original_filename": "RA_TEST_tone.wav",
                "storage_path": storage_path,
                "status": "queued",
                "youtube_result": "pending",
                "youtube_note": None,
                "tiktok_result": "pending",
                "tiktok_note": None,
                "instagram_result": "pending",
                "instagram_note": None,
                "emailed_at": None,
            }
            self.objects[storage_path] = audio


FAKE = FakeSB()


def _match(row, params):
    for k, vals in params.items():
        if k in ("select", "order", "limit"):
            continue
        for v in vals:
            op, _, val = v.partition(".")
            if op == "eq" and str(row.get(k)) != val:
                return False
            if op == "is" and val == "null" and row.get(k) is not None:
                return False
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/storage/v1/object/clearance-uploads/"):
            path = u.path.split("/storage/v1/object/clearance-uploads/", 1)[1]
            from urllib.parse import unquote
            path = unquote(path)
            data = FAKE.objects.get(path)
            if data is None:
                self._json(404, {"error": "not found"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/rest/v1/submissions":
            params = parse_qs(u.query)
            with FAKE.lock:
                rows = [r for r in FAKE.rows.values() if _match(r, params)]
                if "order" in params and "created_at.asc" in params["order"]:
                    rows.sort(key=lambda r: r["created_at"])
                if "limit" in params:
                    rows = rows[: int(params["limit"][0])]
                # shallow copy
                rows = [dict(r) for r in rows]
            self._json(200, rows)
            return
        self._json(404, {"error": "nope"})

    def do_PATCH(self):
        u = urlparse(self.path)
        if u.path != "/rest/v1/submissions":
            self._json(404, {"error": "nope"})
            return
        params = parse_qs(u.query)
        payload = json.loads(self._read().decode() or "{}")
        with FAKE.lock:
            out = []
            for rid, row in list(FAKE.rows.items()):
                if not _match(row, params):
                    continue
                row.update(payload)
                out.append(dict(row))
        self._json(200, out)


def start_server():
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    port = httpd.server_address[1]
    return httpd, f"http://127.0.0.1:{port}"


def make_wav(path: Path, seconds: float = 2.0):
    """Tiny PCM wav via ffmpeg so pull can encode a clip."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-ar", "44100", "-ac", "1", str(path),
        ],
        check=True, capture_output=True,
    )


class EnvTests(unittest.TestCase):
    def tearDown(self):
        for k in (
            "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
            "SUPABASE_KEY", "CLEARANCE_CLIP_DIR",
        ):
            os.environ.pop(k, None)

    def test_missing_env(self):
        with self.assertRaises(BotError) as cm:
            load_env()
        self.assertIn("Missing required env", str(cm.exception))

    def test_refuse_production_url(self):
        os.environ["SUPABASE_URL"] = PROD
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = MOON_JWT
        with self.assertRaises(BotError) as cm:
            load_env()
        self.assertIn("production", str(cm.exception).lower())

    def test_refuse_production_key(self):
        os.environ["SUPABASE_URL"] = MOONSHOTS
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = PROD_JWT
        with self.assertRaises(BotError) as cm:
            load_env()
        self.assertIn("production", str(cm.exception).lower())

    def test_refuse_wrong_project_url(self):
        os.environ["SUPABASE_URL"] = "https://abcdefghijklmnop.supabase.co"
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_test"
        with self.assertRaises(BotError) as cm:
            load_env()
        self.assertIn("moonshots", str(cm.exception).lower())


class FlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd, cls.base = start_server()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        FAKE.rows.clear()
        FAKE.objects.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.clip_dir = Path(self.tmp.name) / "clips"
        self.clip_dir.mkdir()
        # Point moonshots URL at mock while keeping ref in the string for the guard.
        # Guard requires MOONSHOTS_REF in URL — use query/host trick: embed ref as host alias.
        # We override load by setting URL to real moonshots host but monkeypatch env['url']
        # after load — easier: temporarily relax by using a URL that contains the ref
        # as a subdomain-style path. Simplest: set SUPABASE_URL to moonshots and patch
        # pull_next/record to use mock base after load_env.
        os.environ["SUPABASE_URL"] = MOONSHOTS
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = MOON_JWT
        os.environ["CLEARANCE_CLIP_DIR"] = str(self.clip_dir)

    def tearDown(self):
        self.tmp.cleanup()
        for k in (
            "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
            "SUPABASE_KEY", "CLEARANCE_CLIP_DIR",
        ):
            os.environ.pop(k, None)

    def _env(self):
        env = load_env()
        env["url"] = self.base  # talk to mock
        return env

    def test_pull_makes_clip_and_checking(self):
        wav = Path(self.tmp.name) / "tone.wav"
        make_wav(wav, 2.0)
        sid = "11111111-1111-1111-1111-111111111111"
        path = f"{sid}/RA_TEST_tone.wav"
        FAKE.seed_queued(sid, path, wav.read_bytes())

        env = self._env()
        row = pull_next.claim_oldest(env)
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "checking")
        self.assertEqual(FAKE.rows[sid]["status"], "checking")

        # full pull path:
        # reset and run main pieces
        FAKE.rows[sid]["status"] = "queued"
        # claim again
        row = pull_next.claim_oldest(env)
        out = self.clip_dir / f"{sid}_test.mp4"
        tmp_audio = Path(self.tmp.name) / "in.wav"
        tmp_audio.write_bytes(wav.read_bytes())
        pull_next.make_clip(str(tmp_audio), str(out))
        self.assertTrue(out.is_file())
        # ffprobe duration ~2s because -shortest with 2s audio (same as production)
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(out),
            ],
            capture_output=True, text=True, check=True,
        )
        dur = float(probe.stdout.strip())
        self.assertGreater(dur, 1.5)
        self.assertLess(dur, 3.0)
        # has video + audio streams
        streams = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
                "-of", "csv=p=0", str(out),
            ],
            capture_output=True, text=True, check=True,
        ).stdout
        self.assertIn("video", streams)
        self.assertIn("audio", streams)

    def test_clip_61s_when_audio_long(self):
        wav = Path(self.tmp.name) / "long.wav"
        make_wav(wav, 70.0)
        out = self.clip_dir / "long_test.mp4"
        pull_next.make_clip(str(wav), str(out))
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(out),
            ],
            capture_output=True, text=True, check=True,
        )
        dur = float(probe.stdout.strip())
        self.assertGreater(dur, 60.0)
        self.assertLess(dur, 62.5)

    def test_record_done_only_after_third_and_overwrite(self):
        sid = "22222222-2222-2222-2222-222222222222"
        FAKE.seed_queued(sid, f"{sid}/x.wav", b"RIFF....")
        FAKE.rows[sid]["status"] = "checking"
        env = self._env()

        # patch record_result to use mock: call internals with env override
        def record(platform, result, note=None):
            payload = {f"{platform}_result": result}
            if note is not None:
                payload[f"{platform}_note"] = note if note != "" else None
            updated = pull_next.rest_patch(env, f"submissions?id=eq.{sid}", payload)
            row = updated[0]
            if record_result.all_platforms_in(row) and row.get("status") != "done":
                updated = pull_next.rest_patch(env, f"submissions?id=eq.{sid}", {"status": "done"})
                row = updated[0]
            return row

        r1 = record("youtube", "clear")
        self.assertEqual(r1["status"], "checking")
        self.assertEqual(r1["youtube_result"], "clear")

        r2 = record("tiktok", "claimed", "first")
        self.assertEqual(r2["status"], "checking")
        self.assertEqual(r2["tiktok_note"], "first")

        # overwrite tiktok
        r2b = record("tiktok", "muted", "recheck")
        self.assertEqual(r2b["tiktok_result"], "muted")
        self.assertEqual(r2b["tiktok_note"], "recheck")
        self.assertEqual(r2b["status"], "checking")

        r3 = record("instagram", "error", "timeout")
        self.assertEqual(r3["status"], "done")
        self.assertEqual(r3["instagram_result"], "error")

        # overwrite after done still works, stays done
        r4 = record("youtube", "claimed", "late")
        self.assertEqual(r4["youtube_result"], "claimed")
        self.assertEqual(r4["status"], "done")


class CliEnvTests(unittest.TestCase):
    """Scripts exit non-zero with clear message when env bad."""

    def test_pull_missing_env_exits(self):
        env = os.environ.copy()
        for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_KEY"):
            env.pop(k, None)
        r = subprocess.run(
            [sys.executable, str(Path(__file__).parent / "pull_next.py")],
            capture_output=True, text=True, env=env,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Missing required env", r.stderr)

    def test_pull_prod_url_exits(self):
        env = os.environ.copy()
        env["SUPABASE_URL"] = PROD
        env["SUPABASE_SERVICE_ROLE_KEY"] = MOON_JWT
        r = subprocess.run(
            [sys.executable, str(Path(__file__).parent / "pull_next.py")],
            capture_output=True, text=True, env=env,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("production", r.stderr.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
