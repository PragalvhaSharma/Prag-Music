#!/usr/bin/env python3
"""Watch a download folder and push new songs to the bucket as they land.

Files named "<22-char Spotify track id> - <title>.<ext>" are pinned to that track
through a generated overrides file, so matching never guesses: songs without their
own file stay missing (pass --fuzzy to let ingest.py guess for those). When the
folder changes, this runs "ingest.py all --source <dir> --overrides <generated>",
which encodes and uploads only what is new.

Safety checks before each run:
  - a file whose length is more than --max-drift seconds off Spotify's is held back
    (listed in scripts/build/watch-review.csv); smaller drifts of 5 s+ are published
    and listed there too
  - if a song that is live in library.json would lose its audio, the run is skipped
  - after 3 failed runs on the same folder state it waits for the folder to change

It keeps going while the downloader (--downloader pattern) is running and exits
once that is gone and no new files arrived for --idle-exit seconds.

  python3 scripts/watch_ingest.py ~/Music/Prag-Music-Ingest
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
INGEST = SCRIPTS_DIR / "ingest.py"
CORE_CSV = REPO_ROOT / "data" / "core-library.csv"
BASE_OVERRIDES = REPO_ROOT / "data" / "overrides.csv"
BUILD = SCRIPTS_DIR / "build"
GENERATED = BUILD / "watch-overrides.csv"
REVIEW = BUILD / "watch-review.csv"
LIBRARY = BUILD / "library.json"
NAME_RE = re.compile(r"^([A-Za-z0-9]{22}) - .+\.(mp3|m4a|aac|flac|wav|aiff|ogg|opus)$", re.I)
_durations: dict = {}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_core() -> dict[str, dict]:
    out = {}
    with open(CORE_CSV, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            tid = (r.get("spotify_uri") or "").rsplit(":", 1)[-1]
            try:
                dur = float(r.get("duration_sec") or "")
            except ValueError:
                dur = None
            out.setdefault(tid, {"name": r.get("name") or "", "artist": r.get("artist") or "", "duration": dur})
    return out


def finished_files(folder: Path) -> dict[str, tuple[Path, int, int]]:
    out = {}
    for p in sorted(folder.iterdir()):
        m = NAME_RE.match(p.name)
        if not m:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        if p.is_file() and st.st_size > 20000:
            out[m.group(1)] = (p, st.st_mtime_ns, st.st_size)
    return out


def file_duration(path: Path, mtime: int, size: int) -> float | None:
    key = (str(path), mtime, size)
    if key not in _durations:
        try:
            p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                str(path)], capture_output=True, text=True, timeout=120)
            _durations[key] = float(p.stdout.strip())
        except (ValueError, subprocess.SubprocessError, OSError):
            _durations[key] = None
    return _durations[key]


def read_rows(path: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    if not path.exists():
        return rows
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            tid = (r.get("track_id") or "").strip()
            fp = (r.get("file_path") or "").strip()
            if not tid or tid.startswith("#"):
                continue
            if fp in ("", "-"):
                rows[tid] = "-"
                continue
            p = Path(fp).expanduser()
            p = p if p.is_absolute() else REPO_ROOT / p
            if p.exists():
                rows[tid] = str(p)
            else:
                log(f"warning: {path.name} pins {tid} to a missing file: {fp}")
    return rows


def plan(files, core, extra, max_drift, fuzzy):
    rows: dict[str, str] = {}
    for path in extra:
        for tid, fp in read_rows(path).items():
            rows.setdefault(tid, fp)
    review = []
    for tid, (p, mtime, size) in files.items():
        if tid in rows:
            continue
        info = core.get(tid)
        if info is None:
            continue
        got = file_duration(p, mtime, size)
        want = info["duration"]
        drift = (got - want) if (got is not None and want) else None
        if drift is not None and abs(drift) > max_drift:
            rows[tid] = "-"
            review.append([tid, info["name"], info["artist"], round(want), round(got), round(drift), "held back", str(p)])
            continue
        if drift is not None and abs(drift) >= 5:
            review.append([tid, info["name"], info["artist"], round(want), round(got), round(drift), "published", str(p)])
        rows[tid] = str(p)
    if not fuzzy:
        for tid in core:
            rows.setdefault(tid, "-")
    return rows, review


def write_csv(path: Path, header: list[str], rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    tmp.replace(path)


def live_audio_ids() -> set[str]:
    try:
        doc = json.loads(LIBRARY.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return set()
    return {t["id"] for t in doc.get("tracks", []) if t.get("audioKey")}


def downloader_running(pattern: str) -> bool:
    if not pattern:
        return False
    return subprocess.run(["pgrep", "-f", pattern], capture_output=True).returncode == 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--interval", type=int, default=180, help="seconds between scans (default 180)")
    ap.add_argument("--idle-exit", type=int, default=1800,
                    help="once the downloader is gone, exit after this many seconds with no new files")
    ap.add_argument("--downloader", default="spotmate_batch", help="pgrep -f pattern for the download process")
    ap.add_argument("--max-drift", type=float, default=30, help="hold back files this many seconds off Spotify")
    ap.add_argument("--keep", type=Path, action="append", default=[],
                    help="extra overrides csv to merge in (data/overrides.csv is always included)")
    ap.add_argument("--fuzzy", action="store_true", help="let ingest.py fuzzy match songs with no id-named file")
    ap.add_argument("--allow-removals", action="store_true", help="run even if live songs would lose their audio")
    ap.add_argument("--once", action="store_true", help="run one pass and exit")
    args = ap.parse_args()
    folder = args.folder.expanduser().resolve()
    extra = [BASE_OVERRIDES, *[k.expanduser().resolve() for k in args.keep]]
    core = load_core()

    pushed = None          # folder state of the last successful run
    failed_state, failures = None, 0
    last_change = time.time()
    seen = None
    while True:
        files = finished_files(folder)
        state = {tid: (m, s) for tid, (_, m, s) in files.items()}
        if state != seen:
            seen, last_change = state, time.time()
        if state != pushed and not (state == failed_state and failures >= 3):
            rows, review = plan(files, core, extra, args.max_drift, args.fuzzy)
            write_csv(REVIEW, ["track_id", "name", "artist", "spotify_sec", "file_sec", "drift_sec", "action", "file"],
                      review)
            lost = sorted(t for t in live_audio_ids() if rows.get(t) == "-")
            if lost and not args.allow_removals:
                log(f"skipping run: {len(lost)} live songs would lose their audio ({', '.join(lost[:5])}); "
                    "restore their files or pass --allow-removals")
                failed_state, failures = state, 3
            else:
                held = sum(1 for r in review if r[6] == "held back")
                log(f"{len(files)} files in folder, {held} held back for length; running ingest")
                write_csv(GENERATED, ["track_id", "file_path"], rows.items())
                cmd = [sys.executable, str(INGEST), "all", "--source", str(folder), "--overrides", str(GENERATED)]
                rc = subprocess.run(cmd, cwd=REPO_ROOT).returncode
                if rc == 0:
                    pushed, failures = state, 0
                    log(f"ingest ok: {len(live_audio_ids())} songs live in the app")
                else:
                    failures = failures + 1 if state == failed_state else 1
                    failed_state = state
                    log(f"ingest exited {rc} (failure {failures} on this folder state)")
        if args.once:
            return
        if not downloader_running(args.downloader) and time.time() - last_change > args.idle_exit:
            log("downloader finished and no new files; exiting")
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
