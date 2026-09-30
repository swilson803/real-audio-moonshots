#!/usr/bin/env python3
"""Tests for the Catalogue Bot scripts. No network: Supabase is an in-memory
fake that understands the PostgREST filters the scripts use. The clip test runs
real ffmpeg/ffprobe on a generated fixture.

    python3 test_bot.py
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import unquote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import lib  # noqa: E402
import pull_next  # noqa: E402
import record_result  # noqa: E402

MOONSHOTS_URL = f"https://{lib.MOONSHOTS_REF}.supabase.co"
PROD_URL = f"https://{lib.PRODUCTION_REF}.supabase.co"


def jwt(ref):
    body = base64.urlsafe_b64encode(json.dumps({"ref": ref, "role": "service_role"}).encode())
    return f"eyJhbGciOiJIUzI1NiJ9.{body.decode().rstrip('=')}.sig"


def new_row(sid, created_at, **over):
    row = {
        "id": sid, "created_at": created_at, "email": "t@example.com",
        "original_filename": "song.mp3", "storage_path": f"uploads/{sid}/song.mp3",
        "status": "queued", "emailed_at": None,
    }
    for p in lib.PLATFORMS:
        row[f"{p}_result"] = "pending"
        row[f"{p}_note"] = None
    row.update(over)
    return row


class Resp:
    def __init__(self, status, body=None, content=b""):
        self.status_code = status
        self._body = body
        self.content = content
        self.text = json.dumps(body) if body is not None else content.decode("latin1")

    def json(self):
        return self._body


class FakeSupabase:
    """Session stand-in: in-memory submissions table + clearance-uploads bucket."""

    def __init__(self, rows=(), objects=None):
        self.rows = [dict(r) for r in rows]
        self.objects = dict(objects or {})
        self.calls = []

    def _auth_ok(self, headers):
        return headers.get("apikey") and headers.get("Authorization", "").startswith("Bearer ")

    def _match(self, row, params):
        for col, cond in params.items():
            if col in ("select", "order", "limit"):
                continue
            op, _, val = cond.partition(".")
            assert op == "eq", cond
            if str(row.get(col)) != val:
                return False
        return True

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("GET", url, params))
        assert self._auth_ok(headers)
        storage = f"{MOONSHOTS_URL}/storage/v1/object/{lib.BUCKET}/"
        if url.startswith(storage):
            path = unquote(url[len(storage):])
            if path not in self.objects:
                return Resp(400, {"error": "not_found"})
            return Resp(200, content=self.objects[path])
        assert url == f"{MOONSHOTS_URL}/rest/v1/{lib.TABLE}", url
        rows = [r for r in self.rows if self._match(r, params)]
        col, _, direction = params.get("order", "created_at.asc").partition(".")
        rows.sort(key=lambda r: r[col], reverse=direction == "desc")
        if "limit" in params:
            rows = rows[: int(params["limit"])]
        return Resp(200, [dict(r) for r in rows])

    def patch(self, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append(("PATCH", url, params, json))
        assert self._auth_ok(headers)
        assert headers.get("Prefer") == "return=representation"
        assert url == f"{MOONSHOTS_URL}/rest/v1/{lib.TABLE}", url
        for col, val in json.items():
            if col == "status":
                assert val in ("queued", "checking", "done", "failed")
            elif col.endswith("_result"):
                assert val in ("pending",) + lib.RESULTS
            assert col in self.rows[0] if self.rows else True, col
        out = []
        for r in self.rows:
            if self._match(r, params):
                r.update(json)
                out.append(dict(r))
        return Resp(200, out)

    def row(self, sid):
        return next(r for r in self.rows if r["id"] == sid)


def config(clip_dir="./clips"):
    return lib.Config(url=MOONSHOTS_URL, key=jwt(lib.MOONSHOTS_REF), clip_dir=clip_dir)


class ConfigGuard(unittest.TestCase):
    def ok_env(self, **over):
        env = {"MOONSHOTS_SUPABASE_URL": MOONSHOTS_URL, "MOONSHOTS_SERVICE_ROLE_KEY": jwt(lib.MOONSHOTS_REF)}
        env.update(over)
        return env

    def assertRefuses(self, env, *fragments):
        with self.assertRaises(lib.BotError) as cm:
            lib.load_config(env)
        for frag in fragments:
            self.assertIn(frag, str(cm.exception))

    def test_moonshots_ok(self):
        c = lib.load_config(self.ok_env())
        self.assertEqual(c.url, MOONSHOTS_URL)
        self.assertEqual(c.clip_dir, "./clips")

    def test_opaque_key_and_clip_dir_ok(self):
        env = {"MOONSHOTS_SUPABASE_URL": MOONSHOTS_URL + "/", "MOONSHOTS_SERVICE_ROLE_KEY": "sb_secret_abc"}
        self.assertEqual(lib.load_config(env).key, "sb_secret_abc")
        self.assertEqual(lib.load_config({**env, "CLEARANCE_CLIP_DIR": "/tmp/x"}).clip_dir, "/tmp/x")

    def test_ignores_production_style_vars(self):
        prod = {"SUPABASE_URL": PROD_URL, "SUPABASE_SERVICE_ROLE_KEY": jwt(lib.PRODUCTION_REF)}
        self.assertEqual(lib.load_config({**prod, **self.ok_env()}).url, MOONSHOTS_URL)
        self.assertRefuses(prod, "Missing env var(s): MOONSHOTS_SUPABASE_URL, MOONSHOTS_SERVICE_ROLE_KEY")

    def test_missing_all(self):
        self.assertRefuses({}, "MOONSHOTS_SUPABASE_URL", "MOONSHOTS_SERVICE_ROLE_KEY")

    def test_missing_key(self):
        self.assertRefuses({"MOONSHOTS_SUPABASE_URL": MOONSHOTS_URL}, "MOONSHOTS_SERVICE_ROLE_KEY")

    def test_production_url(self):
        self.assertRefuses(self.ok_env(MOONSHOTS_SUPABASE_URL=PROD_URL), "production", lib.PRODUCTION_REF)

    def test_production_key(self):
        self.assertRefuses(self.ok_env(MOONSHOTS_SERVICE_ROLE_KEY=jwt(lib.PRODUCTION_REF)), "production")

    def test_other_project(self):
        self.assertRefuses(self.ok_env(MOONSHOTS_SUPABASE_URL="https://abcdefghij.supabase.co"), "moonshots")
        self.assertRefuses(self.ok_env(MOONSHOTS_SUPABASE_URL=f"https://{lib.MOONSHOTS_REF}.supabase.co.evil.com"), "moonshots")
        self.assertRefuses(self.ok_env(MOONSHOTS_SUPABASE_URL=f"http://{lib.MOONSHOTS_REF}.supabase.co"), "moonshots")
        self.assertRefuses(self.ok_env(MOONSHOTS_SERVICE_ROLE_KEY=jwt("abcdefghij")), "abcdefghij")


class CliGuard(unittest.TestCase):
    """The scripts themselves exit non-zero with a clear message, before any network."""

    def run_script(self, args, env):
        base = {k: v for k, v in os.environ.items()
                if k not in (lib.URL_VAR, lib.KEY_VAR, "CLEARANCE_CLIP_DIR")}
        return subprocess.run([sys.executable, *args], cwd=HERE, env={**base, **env},
                              capture_output=True, text=True, timeout=30)

    def test_missing_env(self):
        # production vars on the same machine must not satisfy the bot
        prod = {"SUPABASE_URL": PROD_URL, "SUPABASE_SERVICE_ROLE_KEY": "k"}
        for args in (["pull_next.py"],
                     ["record_result.py", "--id", "x", "--platform", "youtube", "--result", "clear"]):
            p = self.run_script(args, prod)
            self.assertEqual(p.returncode, 1)
            self.assertIn("Missing env var(s): MOONSHOTS_SUPABASE_URL, MOONSHOTS_SERVICE_ROLE_KEY", p.stderr)

    def test_production_url(self):
        p = self.run_script(["pull_next.py"], {"MOONSHOTS_SUPABASE_URL": PROD_URL, "MOONSHOTS_SERVICE_ROLE_KEY": "k"})
        self.assertEqual(p.returncode, 1)
        self.assertIn("Refusing to run", p.stderr)
        self.assertIn(lib.PRODUCTION_REF, p.stderr)

    def test_bad_args(self):
        p = self.run_script(["record_result.py", "--id", "x", "--platform", "facebook", "--result", "clear"], {})
        self.assertEqual(p.returncode, 2)
        self.assertIn("invalid choice", p.stderr)


class Claim(unittest.TestCase):
    def test_claims_oldest_queued(self):
        fake = FakeSupabase([
            new_row("b", "2026-09-02T00:00:00Z"),
            new_row("a", "2026-09-01T00:00:00Z"),
            new_row("z", "2026-08-01T00:00:00Z", status="done"),
        ])
        row = pull_next.claim_next(lib.Supabase(config(), session=fake))
        self.assertEqual(row["id"], "a")
        self.assertEqual(fake.row("a")["status"], "checking")
        self.assertEqual(fake.row("b")["status"], "queued")
        patch = [c for c in fake.calls if c[0] == "PATCH"][0]
        self.assertEqual(patch[2], {"id": "eq.a", "status": "eq.queued"})

    def test_empty_queue(self):
        fake = FakeSupabase([new_row("a", "2026-09-01", status="checking")])
        self.assertIsNone(pull_next.claim_next(lib.Supabase(config(), session=fake)))

    def test_lost_race_moves_to_next(self):
        fake = FakeSupabase([new_row("a", "1"), new_row("b", "2")])
        real_get = fake.get
        state = {"n": 0}

        def racing_get(url, params=None, **kw):
            resp = real_get(url, params=params, **kw)
            if state["n"] == 0:  # another worker grabs "a" between our GET and PATCH
                fake.row("a")["status"] = "checking"
            state["n"] += 1
            return resp

        fake.get = racing_get
        row = pull_next.claim_next(lib.Supabase(config(), session=fake))
        self.assertEqual(row["id"], "b")


class ObjectKey(unittest.TestCase):
    def test_strips_one_leading_bucket(self):
        b = lib.BUCKET
        self.assertEqual(pull_next.object_key(f"{b}/abc/song.mp3"), "abc/song.mp3")
        self.assertEqual(pull_next.object_key("abc/song.mp3"), "abc/song.mp3")
        self.assertEqual(pull_next.object_key(f"abc/{b}/song.mp3"), f"abc/{b}/song.mp3")
        self.assertEqual(pull_next.object_key(f"{b}/{b}/song.mp3"), f"{b}/song.mp3")
        self.assertEqual(pull_next.object_key(f"{b}-old/song.mp3"), f"{b}-old/song.mp3")


def ffprobe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration:stream=codec_type,codec_name,width,height,pix_fmt",
         "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg not installed")
class PullEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.fixture = os.path.join(cls.tmp, "fixture.mp3")
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=75",
                        "-c:a", "libmp3lame", "-b:a", "128k", cls.fixture],
                       capture_output=True, check=True)
        with open(cls.fixture, "rb") as f:
            cls.audio = f.read()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_clip_is_61s_black_h264_aac(self):
        sid = "11111111-2222-3333-4444-555555555555"
        row = new_row(sid, "1", storage_path=f"{sid}/My Song.mp3")
        fake = FakeSupabase([row], {f"{sid}/My Song.mp3": self.audio})
        clip_dir = os.path.join(self.tmp, "clips")
        db = lib.Supabase(config(clip_dir), session=fake)

        claimed = pull_next.claim_next(db)
        clip = pull_next.process(db, claimed, clip_dir)

        self.assertEqual(clip, os.path.join(clip_dir, f"{sid}_test.mp4"))
        self.assertEqual(fake.row(sid)["status"], "checking")
        info = ffprobe(clip)
        self.assertAlmostEqual(float(info["format"]["duration"]), 61.0, delta=0.3)
        streams = {s["codec_type"]: s for s in info["streams"]}
        self.assertEqual(streams["video"]["codec_name"], "h264")
        self.assertEqual((streams["video"]["width"], streams["video"]["height"]), (1280, 720))
        self.assertEqual(streams["video"]["pix_fmt"], "yuv420p")
        self.assertEqual(streams["audio"]["codec_name"], "aac")

    def test_storage_path_with_bucket_prefix(self):
        # the landing page writes "clearance-uploads/{id}/{file}"; the object key has no bucket
        sid = "66666666-7777-8888-9999-000000000000"
        row = new_row(sid, "1", storage_path=f"{lib.BUCKET}/{sid}/song.mp3")
        fake = FakeSupabase([row], {f"{sid}/song.mp3": self.audio})
        clip_dir = os.path.join(self.tmp, "c4")
        db = lib.Supabase(config(clip_dir), session=fake)

        clip = pull_next.process(db, pull_next.claim_next(db), clip_dir)

        self.assertTrue(os.path.getsize(clip) > 0)
        self.assertEqual(fake.row(sid)["status"], "checking")
        downloads = [c[1] for c in fake.calls if "/storage/" in c[1]]
        self.assertEqual(downloads, [f"{MOONSHOTS_URL}/storage/v1/object/{lib.BUCKET}/{sid}/song.mp3"])

    def test_missing_object_marks_failed(self):
        fake = FakeSupabase([new_row("gone", "1")])
        db = lib.Supabase(config(os.path.join(self.tmp, "c2")), session=fake)
        row = pull_next.claim_next(db)
        with self.assertRaises(lib.BotError) as cm:
            pull_next.process(db, row, db.config.clip_dir)
        self.assertIn("marked failed", str(cm.exception))
        self.assertEqual(fake.row("gone")["status"], "failed")

    def test_bad_audio_marks_failed(self):
        fake = FakeSupabase([new_row("junk", "1")], {"uploads/junk/song.mp3": b"not audio"})
        db = lib.Supabase(config(os.path.join(self.tmp, "c3")), session=fake)
        row = pull_next.claim_next(db)
        with self.assertRaises(lib.BotError) as cm:
            pull_next.process(db, row, db.config.clip_dir)
        self.assertIn("ffmpeg exited", str(cm.exception))
        self.assertEqual(fake.row("junk")["status"], "failed")


class Record(unittest.TestCase):
    def setUp(self):
        self.fake = FakeSupabase([new_row("s1", "1", status="checking")])
        self.db = lib.Supabase(config(), session=self.fake)

    def test_done_only_after_third(self):
        r = record_result.record(self.db, "s1", "youtube", "clear")
        self.assertEqual(r["status"], "checking")
        r = record_result.record(self.db, "s1", "tiktok", "claimed", "Artist - Title")
        self.assertEqual(r["status"], "checking")
        self.assertEqual(r["tiktok_note"], "Artist - Title")
        r = record_result.record(self.db, "s1", "instagram", "muted")
        self.assertEqual(r["status"], "done")
        self.assertEqual(self.fake.row("s1")["status"], "done")

    def test_rerecord_overwrites(self):
        record_result.record(self.db, "s1", "tiktok", "claimed", "first")
        r = record_result.record(self.db, "s1", "tiktok", "error", "second")
        self.assertEqual((r["tiktok_result"], r["tiktok_note"]), ("error", "second"))
        # after done, re-recording still works and the row stays done
        record_result.record(self.db, "s1", "youtube", "clear")
        record_result.record(self.db, "s1", "instagram", "clear")
        r = record_result.record(self.db, "s1", "youtube", "claimed")
        self.assertEqual((r["youtube_result"], r["status"]), ("claimed", "done"))

    def test_note_omitted_keeps_empty_clears(self):
        record_result.record(self.db, "s1", "youtube", "claimed", "keep me")
        r = record_result.record(self.db, "s1", "youtube", "clear")
        self.assertEqual(r["youtube_note"], "keep me")
        r = record_result.record(self.db, "s1", "youtube", "clear", "")
        self.assertIsNone(r["youtube_note"])

    def test_unknown_id(self):
        with self.assertRaises(lib.BotError) as cm:
            record_result.record(self.db, "nope", "youtube", "clear")
        self.assertIn("No submission with id nope", str(cm.exception))

    def test_never_touches_email(self):
        for p in lib.PLATFORMS:
            record_result.record(self.db, "s1", p, "clear")
        for call in self.fake.calls:
            if call[0] == "PATCH":
                self.assertNotIn("emailed_at", call[3])
        self.assertIsNone(self.fake.row("s1")["emailed_at"])


class HttpErrors(unittest.TestCase):
    def test_http_error_is_bot_error(self):
        class Broken:
            def get(self, *a, **kw):
                return Resp(401, {"message": "Invalid API key"})

        with self.assertRaises(lib.BotError) as cm:
            lib.Supabase(config(), session=Broken()).select({})
        self.assertIn("HTTP 401", str(cm.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
