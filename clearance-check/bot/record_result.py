#!/usr/bin/env python3
"""Record a platform clearance result against a submission (MS-003).

HOW TO RUN:
  export SUPABASE_URL=https://kucwpmtkctafzkivuqtu.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=...
  python3 record_result.py --id <uuid> --platform youtube --result clear
  python3 record_result.py --id <uuid> --platform tiktok --result claimed --note "match: Artist - Song"
  # Re-record overwrites. Row becomes status=done only after all three platforms
  # are non-pending. Does not send email. Does not post.

Moonshots Supabase only.
"""

from __future__ import annotations

import argparse
import sys

from lib import PLATFORMS, RESULTS, BotError, die, load_env, rest_get, rest_patch


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Record a clearance platform result (moonshots only).")
    p.add_argument("--id", required=True, help="Submission UUID")
    p.add_argument("--platform", required=True, choices=PLATFORMS)
    p.add_argument("--result", required=True, choices=RESULTS)
    p.add_argument(
        "--note",
        default=None,
        help="Optional note. Omit to leave existing note unchanged; pass empty string to clear.",
    )
    return p.parse_args(argv)


def all_platforms_in(row: dict) -> bool:
    return all(row.get(f"{p}_result") not in (None, "pending") for p in PLATFORMS)


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        env = load_env()
    except BotError as e:
        die(str(e))

    payload = {f"{args.platform}_result": args.result}
    if args.note is not None:
        payload[f"{args.platform}_note"] = args.note if args.note != "" else None

    try:
        updated = rest_patch(env, f"submissions?id=eq.{args.id}", payload)
    except BotError as e:
        die(str(e))

    if not updated:
        die(f"No submission found for id={args.id}")

    row = updated[0]

    # Re-fetch in case another field raced (representation is enough usually)
    if not all_platforms_in(row):
        fresh = rest_get(env, f"submissions?id=eq.{args.id}&select=*")
        row = fresh[0] if fresh else row

    new_status = row.get("status")
    if all_platforms_in(row) and row.get("status") != "done":
        done_rows = rest_patch(env, f"submissions?id=eq.{args.id}", {"status": "done"})
        if done_rows:
            row = done_rows[0]
            new_status = "done"

    print(f"id={row['id']}")
    print(f"platform={args.platform}")
    print(f"result={row[f'{args.platform}_result']}")
    note = row.get(f"{args.platform}_note")
    print(f"note={note if note is not None else ''}")
    print(f"status={row.get('status') or new_status}")
    for p in PLATFORMS:
        print(f"{p}_result={row.get(f'{p}_result')}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BotError as e:
        die(str(e))
