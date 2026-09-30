#!/usr/bin/env python3
"""Record one platform's clearance result against a submission.

    python3 record_result.py --id UUID --platform youtube|tiktok|instagram \
        --result clear|claimed|muted|error [--note TEXT]

Re-recording a platform overwrites it. Omitting --note leaves any existing note
alone; --note "" clears it. Once all three platforms are non-pending the row
becomes done. Prints key=value lines with the row's status and all results.
"""

from __future__ import annotations

import argparse

from lib import PLATFORMS, RESULTS, BotError, Supabase, load_config, run


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Record one platform's clearance result.")
    p.add_argument("--id", required=True, help="submission id (uuid)")
    p.add_argument("--platform", required=True, choices=PLATFORMS)
    p.add_argument("--result", required=True, choices=RESULTS)
    p.add_argument("--note", help='free-text note; omit to keep, "" to clear')
    return p.parse_args(argv)


def is_complete(row):
    return all(row[f"{p}_result"] != "pending" for p in PLATFORMS)


def record(db: Supabase, sid, platform, result, note=None):
    values = {f"{platform}_result": result}
    if note is not None:
        values[f"{platform}_note"] = note or None
    rows = db.update({"id": f"eq.{sid}"}, values)
    if not rows:
        raise BotError(f"No submission with id {sid}.")
    row = rows[0]
    if is_complete(row) and row["status"] != "done":
        row = db.update({"id": f"eq.{sid}"}, {"status": "done"})[0]
    return row


def main(argv=None):
    args = parse_args(argv)
    db = Supabase(load_config())
    row = record(db, args.id, args.platform, args.result, args.note)
    print(f"id={row['id']}")
    print(f"status={row['status']}")
    for p in PLATFORMS:
        print(f"{p}_result={row[f'{p}_result']}")
    print(f"{args.platform}_note={row.get(f'{args.platform}_note') or ''}")
    return 0


if __name__ == "__main__":
    run(main)
