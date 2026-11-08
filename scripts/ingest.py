#!/usr/bin/env python3
"""Prag Music ingest pipeline.

Turns your own music files into the bucket layout described in docs/contract.md.

  match     find the best local file for every song in data/core-library.csv
  encode    write build/audio/<id>.m4a (AAC 256 kbps, +faststart) and build/art/<id>.jpg
  manifest  write build/library.json listing all tracks (contract manifest version 1)
  upload    push new or changed objects through the Worker admin API, library.json last
  all       match, encode, manifest and upload in that order
  archive   move local files of songs verified in the bucket to the Trash; they stay in the app

Standard library only, plus ffmpeg and ffprobe on PATH. See scripts/README.md.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import difflib
import hashlib
import http.client
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
DATA_DIR = REPO_ROOT / "data"
DEFAULT_CSV = DATA_DIR / "core-library.csv"
DEFAULT_PLAYLISTS = DATA_DIR / "playlists.json"
DEFAULT_OVERRIDES = DATA_DIR / "overrides.csv"
DEFAULT_BUILD = SCRIPTS_DIR / "build"
SECRETS_FILE = REPO_ROOT / "worker" / ".secrets.local"

AUDIO_EXTS = {".mp3", ".m4a", ".mp4", ".aac", ".flac", ".wav", ".aiff", ".aif",
              ".alac", ".ogg", ".oga", ".opus", ".wma"}
FOLDER_ART_NAMES = ("cover", "folder", "front", "album", "albumart", "albumartsmall")
TRACK_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")
WORKERS = os.cpu_count() or 4
USER_AGENT = "prag-music-ingest/1.0"

# Matching thresholds. Scores run from about -0.4 to 1.0.
MATCH_MIN = 0.72        # best candidate must reach this to count as matched
TITLE_MIN = 0.80        # and its title similarity must reach this
AMBIGUOUS_GAP = 0.04    # a second different candidate within this gap makes the row ambiguous

KEEP_TAGS = ("title", "artist", "album", "album_artist", "date", "track", "disc", "genre", "composer")
TAG_ALIASES = {"albumartist": "album_artist", "album_artist": "album_artist", "band": "album_artist",
               "tracknumber": "track", "discnumber": "disc", "year": "date"}
LOSSLESS_CODECS = ("flac", "alac", "wavpack", "ape", "tta", "wmalossless", "mlp", "truehd")


# --------------------------------------------------------------------------- small helpers

def log(msg: str = "") -> None:
    print(msg, flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def write_json_atomic(path: Path, obj, indent=None) -> None:
    write_atomic(path, (json.dumps(obj, ensure_ascii=False, indent=indent) + "\n").encode("utf-8"))


def stamp_of(path: Path):
    st = path.stat()
    return [st.st_mtime_ns, st.st_size]


class Build:
    """Paths inside the build directory."""

    def __init__(self, root: Path):
        self.root = root
        self.report = root / "match-report.csv"
        self.unused = root / "unused-files.txt"
        self.audio = root / "audio"
        self.art = root / "art"
        self.library = root / "library.json"
        self.archived = root / "archived.json"
        cache = root / "cache"
        self.probe_cache = cache / "probe.json"
        self.hash_cache = cache / "hashes.json"
        self.encode_state = cache / "encode-state.json"


class JsonCache:
    """Thread-safe {key: {stamp, value}} cache stored as JSON."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            self.data = {}
        self.dirty = False

    def get(self, key: str, stamp):
        with self.lock:
            entry = self.data.get(key)
        if entry and entry.get("stamp") == stamp:
            return entry.get("value")
        return None

    def put(self, key: str, stamp, value) -> None:
        with self.lock:
            self.data[key] = {"stamp": stamp, "value": value}
            self.dirty = True

    def save(self) -> None:
        with self.lock:
            if self.dirty:
                write_json_atomic(self.path, self.data)
                self.dirty = False


def require_tools() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            die(f"{tool} not found on PATH (install with: brew install ffmpeg)")


# --------------------------------------------------------------------------- source data

def load_tracks(csv_path: Path) -> list[dict]:
    if not csv_path.exists():
        die(f"missing {csv_path}")
    tracks, seen = [], set()
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            uri = (row.get("spotify_uri") or "").strip()
            tid = uri.rsplit(":", 1)[-1]
            if not TRACK_ID_RE.match(tid):
                die(f"{csv_path.name} line {n}: bad spotify_uri {uri!r}")
            if tid in seen:
                log(f"warning: duplicate track id {tid} on line {n}; keeping the first")
                continue
            seen.add(tid)
            try:
                dur = int(round(float(row.get("duration_sec") or "")))
            except ValueError:
                dur = None
            tracks.append({"id": tid, "name": row.get("name") or "", "artist": row.get("artist") or "",
                           "duration": dur, "uri": uri})
    return tracks


def load_playlists(path: Path, track_ids: set) -> list[dict]:
    if not path.exists():
        log(f"warning: {path} not found; manifest will have no playlists")
        return []
    doc = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for p in doc.get("playlists", []):
        ids = list(p.get("trackIds", []))
        unknown = [i for i in ids if i not in track_ids]
        if unknown:
            log(f"warning: playlist {p.get('id')} has {len(unknown)} ids not in the CSV (kept as is)")
        out.append({"id": p["id"], "name": p["name"], "spotifyUri": p.get("spotifyUri"), "trackIds": ids})
    return out


def resolve_user_path(raw: str) -> Path:
    p = Path(os.path.expanduser(raw.strip()))
    if not p.is_absolute():
        p = REPO_ROOT / p
    return p.resolve()


def load_overrides(path: Path) -> dict:
    """track_id -> Path, or None to force the track to stay missing (blank or '-' file_path)."""
    if not path or not path.exists():
        return {}
    out = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            tid = (row.get("track_id") or "").strip()
            if not tid or tid.startswith("#"):
                continue
            raw = (row.get("file_path") or "").strip()
            out[tid] = None if raw in ("", "-") else resolve_user_path(raw)
    return out


# --------------------------------------------------------------------------- ffprobe

def ffprobe_raw(path: Path) -> dict:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    p = subprocess.run(cmd, capture_output=True, timeout=180)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace").strip()[:300] or "ffprobe failed")
    return json.loads(p.stdout.decode("utf-8", "replace") or "{}")


def _num(x):
    try:
        v = float(x)
        return v if v == v and v > 0 else None
    except (TypeError, ValueError):
        return None


def summarize_probe(raw: dict) -> dict:
    fmt = raw.get("format") or {}
    streams = raw.get("streams") or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    tags: dict = {}
    for src in ((audio or {}).get("tags"), fmt.get("tags")):  # container tags win over stream tags
        for k, v in (src or {}).items():
            key = k.strip().lower().replace(" ", "_")
            key = TAG_ALIASES.get(key, key)
            if str(v).strip():
                tags[key] = str(v).strip()
    art = None
    for s in streams:
        if s.get("codec_type") != "video":
            continue
        if (s.get("disposition") or {}).get("attached_pic") or s.get("codec_name") in ("mjpeg", "png", "bmp"):
            art = s.get("index")
            break
    audio = audio or {}
    return {
        "has_audio": bool(audio),
        "duration": _num(fmt.get("duration")) or _num(audio.get("duration")),
        "codec": audio.get("codec_name"),
        "profile": audio.get("profile"),
        "bit_rate": _num(audio.get("bit_rate")) or _num(fmt.get("bit_rate")),
        "sample_rate": int(_num(audio.get("sample_rate")) or 0),
        "channels": int(audio.get("channels") or 0),
        "format": fmt.get("format_name") or "",
        "tags": {k: tags[k] for k in KEEP_TAGS if k in tags},
        "art_stream": art,
    }


def probe(path: Path, cache: JsonCache | None) -> dict | None:
    key = str(path)
    try:
        stamp = stamp_of(path)
    except OSError:
        return None
    if cache is not None:
        hit = cache.get(key, stamp)
        if hit is not None:
            return hit
    try:
        info = summarize_probe(ffprobe_raw(path))
    except Exception as e:  # noqa: BLE001 - one broken file must not stop the run
        info = {"has_audio": False, "error": str(e)}
    if cache is not None:
        cache.put(key, stamp, info)
    return info


def probe_many(paths: list[Path], cache: JsonCache) -> dict:
    results: dict = {}
    done = 0
    lock = threading.Lock()

    def work(p):
        nonlocal done
        info = probe(p, cache)
        with lock:
            results[p] = info
            done += 1
            if done % 250 == 0:
                log(f"  probed {done}/{len(paths)}")

    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(work, paths))
    cache.save()
    return results


# --------------------------------------------------------------------------- text normalisation

NOISE_RE = re.compile(
    r"\b(feat|ft|featuring|with|prod|produced|remaster|remastered|remasterizado|live|radio edit|edit|"
    r"explicit|clean|dirty|censored|uncensored|version|original|mono|stereo|bonus|bonus track|deluxe|"
    r"from|soundtrack|motion picture|official|audio|video|lyrics?|visuali[sz]er|hq|hd|\d{4})\b")
MARKERS = {
    "remix": re.compile(r"\b(remix|rmx|remixed)\b"),
    "live": re.compile(r"\blive\b"),
    "acoustic": re.compile(r"\bacoustic\b"),
    "instrumental": re.compile(r"\binstrumental\b"),
    "sped up": re.compile(r"\bsped ?up\b"),
    "slowed": re.compile(r"\bslowed\b"),
    "demo": re.compile(r"\bdemo\b"),
    "acapella": re.compile(r"\ba ?capp?ella\b"),
    "karaoke": re.compile(r"\bkaraoke\b"),
    "extended": re.compile(r"\bextended\b"),
    "nightcore": re.compile(r"\bnightcore\b"),
}
BRACKET_RE = re.compile(r"[\(\[\{]([^\(\)\[\]\{\}]*)[\)\]\}]")
DASH_SPLIT_RE = re.compile(r"\s+[-\u2013\u2014]\s+")
INLINE_FEAT_RE = re.compile(r"\s(feat|ft|featuring)\b\.?\s.*$")
ARTIST_SPLIT_RE = re.compile(r"\s*(?:,|;|/|&|\+|\band\b|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bwith\b|\bx\b|\bvs\b\.?)\s*")
STOPWORDS = {"the", "a", "an", "and", "of", "i", "you", "me", "my", "in", "to", "it", "on", "is",
             "feat", "ft", "with", "remastered", "remaster", "version", "edit", "s"}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.casefold()
    for a, b in (("\u2019", "'"), ("\u2018", "'"), ("\u201c", '"'), ("\u201d", '"'), ("\u00f8", "o"),
                 ("\u00e6", "ae"), ("\u0153", "oe"), ("\u00df", "ss"), ("\u0142", "l"), ("\u0111", "d")):
        s = s.replace(a, b)
    return s


def squash(s: str) -> str:
    """fold()ed text -> lowercase words separated by single spaces."""
    t = s.replace("&", " and ").replace("$", "s").replace("'", "").replace("_", " ")
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t or re.sub(r"\s+", " ", s).strip()


def norm(s: str) -> str:
    return squash(fold(s))


def is_noise(segment: str) -> bool:
    return bool(NOISE_RE.search(squash(segment)))


def title_variants(title: str, file_side: bool = False) -> set:
    """Normalised spellings of a title: full, noise-stripped, and core (all extras stripped)."""
    f = fold(title).strip()
    if not f:
        return set()
    clean = BRACKET_RE.sub(lambda m: " " if is_noise(m.group(1)) else m.group(0), f)
    core = BRACKET_RE.sub(" ", f)
    parts = DASH_SPLIT_RE.split(clean)
    if len(parts) > 1:
        clean = " ".join([parts[0]] + [p for p in parts[1:] if not is_noise(p)])
    core_parts = DASH_SPLIT_RE.split(core)
    core = core_parts[0] if core_parts[0].strip() else core
    clean = INLINE_FEAT_RE.sub("", clean)
    core = INLINE_FEAT_RE.sub("", core)
    out = {squash(x) for x in (clean, core)} - {""}
    if not out:
        out = {squash(f)}     # title made only of brackets, e.g. "(Untitled)"
    if file_side and len(parts) > 1:
        # "Artist - Title" stuffed into the title tag: also try the part after the dash
        rest = " - ".join(DASH_SPLIT_RE.split(f)[1:])
        out |= title_variants(rest) - {""}
    return {x for x in out if x}


def markers(text: str) -> frozenset:
    t = squash(fold(text))
    return frozenset(k for k, rx in MARKERS.items() if rx.search(t))


def split_artists(s: str) -> list:
    return [x for x in (p.strip() for p in ARTIST_SPLIT_RE.split(squash(fold(s)))) if x]


def strip_track_number(stem: str) -> str:
    s = re.sub(r"^\s*\d{1,2}[-.]\d{1,3}\s+", "", stem)          # 1-03 Title
    s = re.sub(r"^\s*\d{1,3}\s*[.\-_)]\s*", "", s)                # 03. Title / 3 - Title
    s = re.sub(r"^\s*\d{2,3}\s+", "", s)                         # 01 Title
    return s.strip() or stem


def parse_filename(stem: str) -> list:
    """Possible (artist, title) readings of a file name. artist may be ''."""
    base = stem
    if "_" in stem and ("_-_" in stem or stem.count("_") > stem.count(" ")):
        base = re.sub(r"\s+", " ", stem.replace("_", " ")).strip()
    readings = []
    for s in dict.fromkeys([base, strip_track_number(base)]):
        parts = DASH_SPLIT_RE.split(s)
        if len(parts) >= 2:
            readings.append((parts[0], " - ".join(parts[1:])))
            stripped = strip_track_number(parts[0])
            if stripped != parts[0] and len(parts) >= 3:   # "01 - Artist - Title"
                readings.append((parts[1], " - ".join(parts[2:])))
        readings.append(("", s))
    return readings


# --------------------------------------------------------------------------- matching

class FileInfo:
    __slots__ = ("path", "probe", "titles", "strong", "title_text", "dir_text", "names",
                 "has_artist", "markers", "tokens", "quality")

    def __init__(self, path: Path, info: dict):
        self.path = path
        self.probe = info
        tags = info.get("tags") or {}
        stem = path.stem
        readings = parse_filename(stem)
        titles = set()
        if tags.get("title"):
            titles |= title_variants(tags["title"], file_side=True)
        for _, t in readings:
            titles |= title_variants(t, file_side=True)
        self.titles = titles
        artist_tag = " ".join(x for x in (tags.get("artist"), tags.get("album_artist")) if x)
        fn_artists = [a for a, _ in readings if a]
        self.strong = f" {norm(artist_tag)} {norm(stem)} "
        self.title_text = f" {norm(tags.get('title', ''))} "
        self.dir_text = f" {norm(path.parent.name)} {norm(path.parent.parent.name)} "
        names = set(split_artists(artist_tag))
        for a in fn_artists:
            names |= set(split_artists(a))
        self.names = names
        self.has_artist = bool(artist_tag.strip() or fn_artists)
        self.markers = markers(" ".join([tags.get("title", ""), stem]))
        toks = set()
        for t in titles:
            toks |= set(t.split())
        toks |= set(norm(stem).split())
        self.tokens = toks
        lossless = (info.get("codec") or "").startswith("pcm_") or info.get("codec") in LOSSLESS_CODECS
        self.quality = (1 if lossless else 0, info.get("bit_rate") or 0)


def contains(padded: str, name: str) -> bool:
    return bool(name) and f" {name} " in padded


def fuzzy_name(name: str, names: set) -> bool:
    if len(name) < 4:
        return name in names
    return any(difflib.SequenceMatcher(None, name, n).ratio() >= 0.88 for n in names)


def artist_score(track_artists: list, f: FileInfo) -> float:
    primary = track_artists[0] if track_artists else ""
    if primary and (contains(f.strong, primary) or fuzzy_name(primary, f.names)):
        return 1.0
    for a in track_artists[1:]:
        if contains(f.strong, a) or fuzzy_name(a, f.names):
            return 0.8
    for a in track_artists:
        if contains(f.dir_text, a):
            return 0.7
    return -0.4 if f.has_artist else 0.3


def title_similarity(a_set: set, b_set: set) -> float:
    best = 0.0
    for a in a_set:
        for b in b_set:
            if a == b:
                return 1.0
            sm = difflib.SequenceMatcher(None, a, b)
            if sm.real_quick_ratio() <= best or sm.quick_ratio() <= best:
                continue
            r = sm.ratio()
            if min(len(a), len(b)) <= 5:
                r *= 0.85     # short titles ("One" vs "Done") need to match exactly
            best = max(best, r)
    return best


def duration_score(csv_dur, file_dur) -> float:
    if not csv_dur or not file_dur:
        return 0.4
    d = abs(csv_dur - file_dur)
    if d <= 4:
        return 1.0
    if d <= 10:
        return 0.6
    if d <= 20:
        return 0.3
    if d <= 45:
        return 0.1
    return -0.25


def score_pair(t: dict, f: FileInfo):
    ts = title_similarity(t["titles"], f.titles)
    if ts < 0.6:
        return None
    s = 0.55 * ts + 0.25 * artist_score(t["artists"], f) + 0.20 * duration_score(t["duration"], f.probe.get("duration"))
    if t["markers"] != f.markers:
        s -= 0.10
    return round(s, 4), round(ts, 4)


def same_recording(cands: list) -> bool:
    """True when near-tied candidates look like copies of one song (same title, same length)."""
    durs = [c[2].probe.get("duration") for c in cands]
    if any(d is None for d in durs) or max(durs) - min(durs) > 2.0:
        return False
    return all(c[1] >= 0.95 for c in cands)


def cmd_match(args) -> dict:
    require_tools()
    build = Build(args.build_dir)
    tracks = load_tracks(args.csv)
    overrides = load_overrides(args.overrides)
    unknown = [k for k in overrides if k not in {t["id"] for t in tracks}]
    for k in unknown:
        log(f"warning: overrides.csv mentions unknown track id {k}")

    paths = scan_sources(args.source)
    log(f"Found {len(paths)} audio files in {len(args.source)} source folder(s). Reading tags...")
    cache = JsonCache(build.probe_cache)
    infos = probe_many(paths, cache)
    files = []
    for p in paths:
        info = infos.get(p) or {}
        if info.get("has_audio"):
            files.append(FileInfo(p, info))
        elif info.get("error"):
            log(f"  skipped unreadable file: {p} ({info['error'].splitlines()[0][:120]})")

    index: dict = {}
    for i, f in enumerate(files):
        for tok in f.tokens:
            index.setdefault(tok, []).append(i)

    for t in tracks:
        t["titles"] = title_variants(t["name"])
        t["artists"] = list(dict.fromkeys(norm(a) for a in t["artist"].split(",") if norm(a)))
        t["markers"] = markers(t["name"])
        core = min(t["titles"], key=len) if t["titles"] else ""
        t["key"] = (core, t["artists"][0] if t["artists"] else "")

    def candidates(t):
        toks = set()
        for v in t["titles"]:
            toks |= set(v.split())
        query = (toks - STOPWORDS) or toks
        idxs = set()
        for tok in query:
            idxs.update(index.get(tok, ()))
        out = []
        for i in idxs:
            r = score_pair(t, files[i])
            if r:
                out.append((r[0], r[1], files[i]))
        out.sort(key=lambda c: (-c[0], -c[1], str(c[2].path)))
        return out

    log(f"Matching {len(tracks)} songs against {len(files)} files...")
    with ThreadPoolExecutor(WORKERS) as pool:
        cand_lists = dict(zip([t["id"] for t in tracks], pool.map(candidates, tracks)))

    results: dict = {}
    claimed: dict = {}   # file path -> track key that owns it
    order = sorted(tracks, key=lambda t: -(cand_lists[t["id"]][0][0] if cand_lists[t["id"]] else -9))
    for t in order:
        tid = t["id"]
        if tid in overrides:
            target = overrides[tid]
            if target is None:
                results[tid] = ("missing", "override", "")
            elif target.exists():
                results[tid] = ("matched", "override", str(target))
                claimed.setdefault(str(target), t["key"])
            else:
                log(f"warning: override for {tid} points at a missing file: {target}")
                results[tid] = ("missing", "override", str(target))
            continue
        cands = [c for c in cand_lists[tid] if claimed.get(str(c[2].path), t["key"]) == t["key"]]
        viable = [c for c in cands if c[1] >= TITLE_MIN]
        if not viable or viable[0][0] < MATCH_MIN:
            near = next((c for c in cands if c[1] >= 0.7 and c[0] >= 0.5), None)
            results[tid] = ("missing", f"{near[0]:.3f}" if near else "", str(near[2].path) if near else "")
            continue
        best = viable[0]
        tied = [c for c in viable if c[0] >= best[0] - AMBIGUOUS_GAP]
        if len(tied) > 1:
            if same_recording(tied):
                best = max(tied, key=lambda c: (c[2].quality, c[0], -len(str(c[2].path))))
            else:
                results[tid] = ("ambiguous", f"{best[0]:.3f}", " | ".join(str(c[2].path) for c in tied[:3]))
                continue
        results[tid] = ("matched", f"{best[0]:.3f}", str(best[2].path))
        claimed[str(best[2].path)] = t["key"]

    build.root.mkdir(parents=True, exist_ok=True)
    rows = []
    for t in tracks:
        status, score, path = results[t["id"]]
        rows.append({"track_id": t["id"], "name": t["name"], "artist": t["artist"],
                     "status": status, "score": score, "file_path": path})
    buf = _csv_text(["track_id", "name", "artist", "status", "score", "file_path"], rows)
    write_atomic(build.report, buf.encode("utf-8"))
    used = {r["file_path"] for r in rows if r["status"] == "matched"}
    unused = sorted(str(f.path) for f in files if str(f.path) not in used)
    write_atomic(build.unused, ("\n".join(unused) + ("\n" if unused else "")).encode("utf-8"))

    counts = {s: sum(1 for r in rows if r["status"] == s) for s in ("matched", "ambiguous", "missing")}
    log("")
    log(f"Match summary: {counts['matched']} matched / {counts['ambiguous']} ambiguous / {counts['missing']} missing"
        f" (of {len(rows)} songs)")
    amb = [r for r in rows if r["status"] == "ambiguous"]
    for r in amb[:25]:
        log(f"  ambiguous: {r['name']} - {r['artist']} [{r['track_id']}]")
        for p in r["file_path"].split(" | "):
            log(f"      {p}")
    if len(amb) > 25:
        log(f"  ... {len(amb) - 25} more ambiguous rows in the report")
    log(f"Report: {build.report}")
    log(f"Files not used for any song: {len(unused)} (listed in {build.unused})")
    if amb or counts["missing"]:
        log("Pin a file to a song with data/overrides.csv (track_id,file_path), then rerun match.")
    return counts


def _csv_text(fields, rows) -> str:
    import io
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def scan_sources(sources: list) -> list:
    found = {}
    for src in sources:
        root = Path(os.path.expanduser(src)).resolve()
        if not root.exists():
            die(f"source folder does not exist: {root}")
        if root.is_file():
            if root.suffix.lower() in AUDIO_EXTS:
                found[root] = None
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for fn in sorted(filenames):
                if fn.startswith(".") or Path(fn).suffix.lower() not in AUDIO_EXTS:
                    continue
                found[Path(dirpath, fn).resolve()] = None
    return list(found)


# --------------------------------------------------------------------------- encode

_ENCODER = None


def aac_encoder() -> str:
    global _ENCODER
    if _ENCODER is None:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        _ENCODER = "aac_at" if re.search(r"^\s*A\S*\s+aac_at\b", out, re.M) else "aac"
    return _ENCODER


def read_report(build: Build) -> list:
    if not build.report.exists():
        die(f"no match report at {build.report}; run: python3 scripts/ingest.py match --source <folder>")
    with open(build.report, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def target_rate(sr: int) -> int | None:
    if sr in (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000):
        return None
    if sr and sr % 44100 == 0:
        return 44100
    return 48000 if sr > 48000 or not sr else 44100


def run_ffmpeg(cmd: list) -> tuple:
    p = subprocess.run(cmd, capture_output=True, timeout=1800)
    return p.returncode, p.stderr.decode("utf-8", "replace").strip()


def encode_audio(src: Path, info: dict, out: Path, row: dict) -> str:
    """Encode or remux src to out. Returns the mode used: copy, aac_at or aac."""
    tags = dict(info.get("tags") or {})
    tags.setdefault("title", row.get("name") or "")
    tags.setdefault("artist", row.get("artist") or "")
    meta = []
    for k in KEEP_TAGS:
        if tags.get(k):
            meta += ["-metadata", f"{k}={tags[k]}"]
    tmp = out.with_name(f".{out.stem}.tmp.m4a")
    copyable = (info.get("codec") == "aac" and (info.get("bit_rate") or 0) >= 240_000
                and (info.get("profile") in (None, "LC")))
    modes = (["copy"] if copyable else []) + [aac_encoder()] + (["aac"] if aac_encoder() != "aac" else [])
    errors = []
    for mode in modes:
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
               "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", *meta]
        if mode == "copy":
            cmd += ["-c:a", "copy"]
        else:
            cmd += ["-c:a", mode, "-b:a", "256k"]
            rate = target_rate(info.get("sample_rate") or 0)
            if rate:
                cmd += ["-ar", str(rate)]
            if (info.get("channels") or 2) > 2:
                cmd += ["-ac", "2"]
        cmd += ["-movflags", "+faststart", "-fflags", "+bitexact", "-f", "mp4", str(tmp)]
        rc, err = run_ffmpeg(cmd)
        if rc == 0:
            check = probe(tmp, None) or {}
            if check.get("has_audio") and check.get("codec") == "aac" and (check.get("duration") or 0) > 0:
                os.replace(tmp, out)
                return mode
            err = "output did not probe as AAC audio"
        errors.append(f"{mode}: {err[-300:]}")
        tmp.unlink(missing_ok=True)
    raise RuntimeError("; ".join(errors))


def find_folder_art(src: Path) -> Path | None:
    try:
        entries = {p.name.lower(): p for p in src.parent.iterdir() if p.is_file()}
    except OSError:
        return None
    for name in FOLDER_ART_NAMES:
        for ext in (".jpg", ".jpeg", ".png"):
            if name + ext in entries:
                return entries[name + ext]
    return None


def extract_art(src: Path, info: dict, out: Path) -> bool:
    vf = "scale=600:600:force_original_aspect_ratio=increase:flags=lanczos,crop=600:600"
    if info.get("art_stream") is not None:
        inp, mapping = src, f"0:{info['art_stream']}"
    else:
        folder = find_folder_art(src)
        if not folder:
            return False
        inp, mapping = folder, "0:v:0"
    tmp = out.with_name(f".{out.stem}.tmp.jpg")
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(inp),
           "-map", mapping, "-frames:v", "1", "-vf", vf, "-pix_fmt", "yuvj420p", "-c:v", "mjpeg",
           "-q:v", "2", "-map_metadata", "-1", "-fflags", "+bitexact", "-f", "image2", str(tmp)]
    rc, err = run_ffmpeg(cmd)
    if rc != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        log(f"  warning: could not extract art from {inp.name}: {err[-200:]}")
        return False
    os.replace(tmp, out)
    return True


def cmd_encode(args) -> dict:
    require_tools()
    build = Build(args.build_dir)
    rows = [r for r in read_report(build) if r["status"] == "matched"]
    build.audio.mkdir(parents=True, exist_ok=True)
    build.art.mkdir(parents=True, exist_ok=True)
    try:
        state = json.loads(build.encode_state.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        state = {}
    cache = JsonCache(build.probe_cache)
    lock = threading.Lock()
    stats = {"encoded": 0, "copied": 0, "skipped": 0, "failed": 0, "art": 0}
    log(f"Encoding {len(rows)} matched songs with {aac_encoder()} on {WORKERS} threads...")

    def work(row):
        tid = row["track_id"]
        src = Path(row["file_path"])
        out = build.audio / f"{tid}.m4a"
        art = build.art / f"{tid}.jpg"
        try:
            if not src.exists():
                raise RuntimeError(f"source file is gone: {src}")
            src_mtime = src.stat().st_mtime
            prev = state.get(tid)
            same_src = prev is None or prev.get("source") == str(src)
            if not same_src:
                art.unlink(missing_ok=True)
            audio_fresh = out.exists() and out.stat().st_mtime >= src_mtime and same_src
            art_fresh = (art.exists() and art.stat().st_mtime >= src_mtime and same_src) or \
                        (audio_fresh and prev is not None and prev.get("art") is False)
            if audio_fresh and art_fresh:
                with lock:
                    stats["skipped"] += 1
                return
            info = probe(src, cache)
            if not info or not info.get("has_audio"):
                raise RuntimeError("no audio stream")
            mode = prev.get("mode") if (audio_fresh and prev) else None
            if not audio_fresh:
                mode = encode_audio(src, info, out, row)
            has_art = art.exists() if art_fresh else extract_art(src, info, art)
            if not has_art:
                art.unlink(missing_ok=True)     # source no longer has a cover
            with lock:
                stats["copied" if mode == "copy" else ("skipped" if audio_fresh else "encoded")] += 1
                stats["art"] += 1 if (has_art and not art_fresh) else 0
                state[tid] = {"source": str(src), "mode": mode, "art": bool(has_art)}
            log(f"  {'remuxed' if mode == 'copy' else 'encoded'} {tid}  {row['name']} - {row['artist']}"
                if not audio_fresh else f"  art {tid}  {row['name']}")
        except Exception as e:  # noqa: BLE001
            with lock:
                stats["failed"] += 1
            log(f"  FAILED {tid} {row['name']}: {e}")

    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(work, rows))
    cache.save()
    write_json_atomic(build.encode_state, state, indent=1)
    log(f"Encode summary: {stats['encoded']} encoded, {stats['copied']} remuxed, {stats['skipped']} up to date, "
        f"{stats['failed']} failed, {stats['art']} cover images written")
    log(f"Output: {build.audio}")
    return stats


# --------------------------------------------------------------------------- manifest

def file_digest(path: Path, cache: JsonCache, want_probe: bool) -> dict:
    stamp = stamp_of(path)
    hit = cache.get(str(path), stamp)
    if hit is not None and (not want_probe or "probe" in hit):
        return hit
    sha, md5 = hashlib.sha256(), hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
            md5.update(chunk)
    value = {"sha256": sha.hexdigest(), "md5": md5.hexdigest(), "size": stamp[1]}
    if want_probe:
        value["probe"] = probe(path, None)
    cache.put(str(path), stamp, value)
    return value


def cmd_manifest(args) -> dict:
    build = Build(args.build_dir)
    tracks = load_tracks(args.csv)
    playlists = load_playlists(args.playlists, {t["id"] for t in tracks})
    archived = load_archived(build)
    cache = JsonCache(build.hash_cache)
    audio_paths = {t["id"]: build.audio / f"{t['id']}.m4a" for t in tracks}
    present = [tid for tid, p in audio_paths.items() if p.exists()]
    allowed = None
    if build.report.exists():
        # only publish audio for songs the current match report still maps to a file
        allowed = {r["track_id"] for r in read_report(build) if r["status"] == "matched"}
        stale = [tid for tid in present if tid not in allowed]
        if stale:
            log(f"Ignoring {len(stale)} encoded files whose songs are no longer matched in the report")
        present = [tid for tid in present if tid in allowed]
    if present:
        require_tools()
    with ThreadPoolExecutor(WORKERS) as pool:
        digests = dict(zip(present, pool.map(lambda tid: file_digest(audio_paths[tid], cache, True), present)))
    cache.save()

    entries = []
    kept = 0
    for t in tracks:
        tid = t["id"]
        d = digests.get(tid)
        p = (d or {}).get("probe") or {}
        has_audio = bool(d and p.get("has_audio"))
        if not has_audio and tid in archived:
            # local files were removed after the upload was verified; keep publishing the bucket copy
            a = archived[tid]
            kept += 1
            entries.append({
                "id": tid, "title": t["name"], "artist": t["artist"], "album": a.get("album"),
                "durationSec": a.get("durationSec") or t["duration"], "spotifyUri": t["uri"],
                "audioKey": a["audioKey"], "artKey": a.get("artKey"), "bytes": a.get("bytes"),
                "sha256": a.get("sha256"), "bitrateKbps": a.get("bitrateKbps"),
            })
            continue
        art = build.art / f"{tid}.jpg"
        art_ok = art.exists() and (allowed is None or tid in allowed)
        dur = p.get("duration") if has_audio else None
        br = p.get("bit_rate") if has_audio else None
        entries.append({
            "id": tid,
            "title": t["name"],
            "artist": t["artist"],
            "album": (p.get("tags") or {}).get("album") or None,
            "durationSec": int(round(dur)) if dur else t["duration"],
            "spotifyUri": t["uri"],
            "audioKey": f"audio/{tid}.m4a" if has_audio else None,
            "artKey": f"art/{tid}.jpg" if art_ok else None,
            "bytes": d["size"] if has_audio else None,
            "sha256": d["sha256"] if has_audio else None,
            "bitrateKbps": int(round(br / 1000)) if br else None,
        })
    doc = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tracks": entries,
        "playlists": playlists,
    }
    unchanged = False
    try:
        old_doc = json.loads(build.library.read_text(encoding="utf-8"))
        unchanged = {**old_doc, "generatedAt": None} == {**doc, "generatedAt": None}
    except (FileNotFoundError, ValueError):
        pass
    if unchanged:
        log("Manifest content unchanged; keeping the existing library.json")
    else:
        write_json_atomic(build.library, doc, indent=2)
    with_audio = sum(1 for e in entries if e["audioKey"])
    with_art = sum(1 for e in entries if e["artKey"])
    total_mb = sum(e["bytes"] or 0 for e in entries) / 1e6
    log(f"Manifest: {len(entries)} tracks, {with_audio} with audio ({total_mb:.1f} MB), {with_art} with art, "
        f"{len(playlists)} playlists -> {build.library}")
    if kept:
        log(f"  {kept} of those are archived (bucket copy only, see {build.archived.name})")
    return {"tracks": len(entries), "audio": with_audio, "art": with_art}


def load_archived(build: Build) -> dict:
    """track_id -> manifest entry for songs whose local files were archived after a verified upload."""
    try:
        doc = json.loads(build.archived.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError:
        die(f"{build.archived} is not valid JSON; fix or restore it before continuing")
    tracks = doc.get("tracks") if isinstance(doc, dict) else None
    if not isinstance(tracks, dict):
        die(f"{build.archived} should look like {{\"tracks\": {{track_id: entry}}}}; fix or restore it")
    return {tid: e for tid, e in tracks.items() if isinstance(e, dict) and e.get("audioKey")}


ARCHIVE_FIELDS = ("audioKey", "artKey", "bytes", "sha256", "bitrateKbps", "album", "durationSec")


def refresh_archived(build: Build, lib: dict) -> None:
    """After library.json is live, point archive entries at what is now published, so a song that was
    downloaded and uploaded again falls back to its current bucket copy, not the older one."""
    archived = load_archived(build)
    changed = 0
    for t in lib.get("tracks", []):
        a = archived.get(t["id"])
        if a and t.get("audioKey") and a.get("sha256") != t.get("sha256"):
            archived[t["id"]] = {k: t.get(k) for k in ARCHIVE_FIELDS}
            changed += 1
    if changed:
        write_json_atomic(build.archived, {"version": 1, "tracks": archived}, indent=1)
        log(f"Updated {changed} archive entries to the newly published copies")


# --------------------------------------------------------------------------- upload

class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]!r}")
        self.status = status


def secrets_value(key: str) -> str:
    if not SECRETS_FILE.exists():
        return ""
    for line in SECRETS_FILE.read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def admin_token() -> str:
    tok = os.environ.get("PRAG_MUSIC_ADMIN_TOKEN", "").strip()
    if tok:
        return tok
    if SECRETS_FILE.exists():
        for line in SECRETS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:].strip()
            if line.startswith("ADMIN_TOKEN="):
                tok = line.split("=", 1)[1].strip().strip("'\"")
                if tok:
                    return tok
    die("no admin token: set PRAG_MUSIC_ADMIN_TOKEN or add ADMIN_TOKEN=... to worker/.secrets.local")
    return ""


def http_call(method: str, url: str, token: str, body: bytes | None = None, headers: dict | None = None,
              retries: int = 4, timeout: int = 300) -> bytes:
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("User-Agent", USER_AGENT)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            if e.code in (401, 403):
                die(f"{method} {url} was rejected ({e.code}); check the admin token")
            if e.code not in (408, 425, 429) and e.code < 500:
                raise HttpError(e.code, text)
            last = HttpError(e.code, text)
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException, OSError) as e:
            last = e
        if attempt < retries:
            time.sleep(min(20.0, 1.5 * 2 ** attempt) + random.random())
    raise RuntimeError(f"{method} {url} failed after {retries + 1} attempts: {last}")


def list_remote(base: str, token: str) -> dict:
    objects = {}
    for prefix in ("audio/", "art/", "library.json"):
        cursor = None
        while True:
            q = {"prefix": prefix}
            if cursor:
                q["cursor"] = cursor
            raw = http_call("GET", f"{base}/admin/objects?{urllib.parse.urlencode(q)}", token)
            doc = json.loads(raw.decode("utf-8") or "{}")
            for o in doc.get("objects", []):
                objects[o["key"]] = o
            cursor = doc.get("cursor") if doc.get("truncated") else None
            if not cursor:
                break
    return objects


def needs_upload(local: dict, remote: dict | None) -> bool:
    if remote is None:
        return True
    if remote.get("size") is not None and int(remote["size"]) != local["size"]:
        return True
    if remote.get("sha256"):
        return remote["sha256"].lower() != local["sha256"]
    etag = (remote.get("etag") or "").strip('"').lower()
    return etag != local["md5"]    # B2/R2 single-part ETag is the MD5 of the body


def cmd_upload(args) -> dict:
    build = Build(args.build_dir)
    if not build.library.exists():
        die(f"no manifest at {build.library}; run the manifest step first")
    base = (args.url or secrets_value("PRAG_MUSIC_URL") or "").rstrip("/")
    if not base:
        die("no Worker URL: pass --url or run worker/scripts/setup.sh so worker/.secrets.local has PRAG_MUSIC_URL")
    lib = json.loads(build.library.read_text(encoding="utf-8"))
    archived = load_archived(build)
    cache = JsonCache(build.hash_cache)
    local = []
    expected = []      # (key, size) already in the bucket with no local copy (archived songs)
    for t in lib.get("tracks", []):
        if t.get("audioKey"):
            path = build.root / t["audioKey"]
            if not path.exists():
                a = archived.get(t["id"])
                if not (a and a["audioKey"] == t["audioKey"] and a.get("sha256") == t.get("sha256")):
                    die(f"{path} is listed in library.json but missing; rerun encode and manifest")
                expected.append((t["audioKey"], a.get("bytes")))
            else:
                d = file_digest(path, cache, False)
                if d["sha256"] != t.get("sha256"):
                    die(f"{path} changed since library.json was written; rerun manifest")
                local.append({"key": t["audioKey"], "path": path, "type": "audio/mp4", **d})
        if t.get("artKey"):
            path = build.root / t["artKey"]
            if path.exists():
                local.append({"key": t["artKey"], "path": path, "type": "image/jpeg",
                              **file_digest(path, cache, False)})
            elif t["id"] in archived:
                expected.append((t["artKey"], None))
    cache.save()
    lib_bytes = build.library.read_bytes()
    lib_obj = {"key": "library.json", "path": build.library, "type": "application/json",
               "size": len(lib_bytes), "sha256": hashlib.sha256(lib_bytes).hexdigest(),
               "md5": hashlib.md5(lib_bytes).hexdigest()}

    token = admin_token()
    log(f"Listing objects at {base} ...")
    remote = list_remote(base, token)
    gone = [k for k, size in expected
            if k not in remote or (size is not None and remote[k].get("size") is not None
                                   and int(remote[k]["size"]) != int(size))]
    if gone:
        die(f"{len(gone)} archived objects are missing or wrong in the bucket (e.g. {gone[0]}); "
            "library.json was NOT updated. Restore those songs' files or remove them from archived.json.")
    todo = [o for o in local if args.force or needs_upload(o, remote.get(o["key"]))]
    lib_changed = args.force or needs_upload(lib_obj, remote.get("library.json"))
    mb = sum(o["size"] for o in todo) / 1e6
    log(f"Remote has {len(remote)} objects. Local: {len(local)} objects. "
        f"To upload: {len(todo)} ({mb:.1f} MB) + library.json {'(changed)' if lib_changed else '(unchanged)'}")
    if args.dry_run:
        for o in todo[:50]:
            log(f"  would PUT {o['key']} ({o['size'] / 1e6:.2f} MB)")
        if len(todo) > 50:
            log(f"  ... and {len(todo) - 50} more")
        if lib_changed:
            log("  would PUT library.json last")
        log("Dry run: nothing uploaded.")
        return {"uploaded": 0, "planned": len(todo), "library": lib_changed}

    lock = threading.Lock()
    done, failed = [], []

    def put(o):
        try:
            body = o["path"].read_bytes()
            if hashlib.sha256(body).hexdigest() != o["sha256"]:
                raise RuntimeError("file changed while uploading; rerun manifest")
            raw = http_call("PUT", f"{base}/admin/objects/{o['key']}", token, body,
                            {"Content-Type": o["type"], "X-Content-SHA256": o["sha256"]})
            resp = json.loads(raw.decode("utf-8") or "{}")
            if resp.get("size") is not None and int(resp["size"]) != o["size"]:
                raise RuntimeError(f"server stored {resp['size']} bytes, expected {o['size']}")
            stored_etag = (resp.get("etag") or "").strip('"').lower()
            if not stored_etag or stored_etag != o["md5"]:
                raise RuntimeError(f"server stored a different body (etag {stored_etag}, expected md5 {o['md5']})")
            with lock:
                done.append(o["key"])
                n = len(done)
            if n % 25 == 0 or n == len(todo):
                log(f"  uploaded {n}/{len(todo)}")
        except Exception as e:  # noqa: BLE001
            with lock:
                failed.append((o["key"], str(e)))
            log(f"  FAILED {o['key']}: {e}")

    with ThreadPoolExecutor(min(6, max(1, len(todo)))) as pool:
        list(pool.map(put, todo))
    if failed:
        die(f"{len(failed)} uploads failed; library.json was NOT updated. Rerun upload to retry.")
    if lib_changed:
        put_lib = http_call("PUT", f"{base}/admin/objects/library.json", token, lib_bytes,
                            {"Content-Type": "application/json", "X-Content-SHA256": lib_obj["sha256"]})
        lib_resp = json.loads(put_lib.decode("utf-8") or "{}")
        if (lib_resp.get("etag") or "").strip('"').lower() != lib_obj["md5"]:
            die("library.json upload did not verify (etag mismatch). Rerun upload.")
    refresh_archived(build, lib)
    log(f"Upload done: {len(done)} objects uploaded, library.json {'updated' if lib_changed else 'already current'}.")
    return {"uploaded": len(done), "library": lib_changed}


# --------------------------------------------------------------------------- archive

def _trash_move(path: Path, dest_dir: Path) -> int:
    size = path.stat().st_size
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / path.name
    n = 1
    while dest.exists():
        dest = dest_dir / f"{path.stem} ({n}){path.suffix}"
        n += 1
    shutil.move(str(path), str(dest))
    return size


def cmd_archive(args) -> dict:
    """Move local copies of songs that are verified in the bucket to the Trash and record them in
    build/archived.json so manifest/upload keep publishing them. Delete a song's entry from
    archived.json to take it out of the app."""
    build = Build(args.build_dir)
    if not build.library.exists():
        die(f"no manifest at {build.library}; run the pipeline first")
    base = (args.url or secrets_value("PRAG_MUSIC_URL") or "").rstrip("/")
    if not base:
        die("no Worker URL: pass --url or set PRAG_MUSIC_URL in worker/.secrets.local")
    lib_bytes = build.library.read_bytes()
    lib = json.loads(lib_bytes.decode("utf-8"))
    token = admin_token()
    log(f"Listing objects at {base} ...")
    remote = list_remote(base, token)
    lib_obj = {"size": len(lib_bytes), "sha256": hashlib.sha256(lib_bytes).hexdigest(),
               "md5": hashlib.md5(lib_bytes).hexdigest()}
    if needs_upload(lib_obj, remote.get("library.json")):
        die("the live library.json differs from build/library.json; run upload first so only live songs are archived")

    archived = load_archived(build)
    roots = [Path(os.path.expanduser(str(s))).resolve() for s in args.source]
    try:
        enc_state = json.loads(build.encode_state.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        enc_state = {}
    cache = JsonCache(build.hash_cache)
    verified, skipped = {}, []
    for t in lib.get("tracks", []):
        tid, key = t["id"], t.get("audioKey")
        if not key:
            continue
        m4a = build.root / key
        r = remote.get(key)
        if m4a.exists():
            d = file_digest(m4a, cache, False)
            if d["sha256"] != t.get("sha256") or needs_upload(d, r):
                skipped.append((tid, "bucket copy does not match the local encode"))
                continue
        elif tid in archived:
            if r is None:
                skipped.append((tid, "archived but missing from the bucket"))
                continue
        else:
            skipped.append((tid, "no local encode to verify against"))
            continue
        if t.get("artKey") and t["artKey"] not in remote:
            skipped.append((tid, "cover art not in the bucket"))
            continue
        verified[tid] = t
    cache.save()

    def in_roots(p: Path) -> bool:
        return any(p == root or root in p.parents for root in roots)

    # a source file is moved only if it is the exact file the verified encode was made from:
    # encode-state names it, the encode is still on disk, and the file is not newer than the encode
    sources_in_use = {}
    for tid, s in enc_state.items():
        if s.get("source"):
            sources_in_use.setdefault(str(Path(s["source"]).resolve()), set()).add(tid)
    moves = []    # (track id, path)
    for tid in verified:
        files = set()
        m4a = build.root / verified[tid]["audioKey"]
        src = (enc_state.get(tid) or {}).get("source")
        if m4a.exists() and src:
            fp = Path(src).resolve()
            if (fp.is_file() and in_roots(fp) and fp.stat().st_mtime <= m4a.stat().st_mtime
                    and sources_in_use.get(str(fp), set()) <= set(verified)):
                files.add(fp)
        if not args.keep_encoded and m4a.exists():
            files.add(m4a.resolve())
        moves.extend((tid, p) for p in sorted(files))

    total = sum(p.stat().st_size for _, p in moves)
    log(f"Verified in the bucket: {len(verified)} songs. Skipped: {len(skipped)}.")
    for tid, why in skipped[:20]:
        log(f"  skipped {tid}: {why}")
    log(f"Files to move: {len(moves)} ({total / 1e9:.2f} GB)")
    if args.dry_run:
        for _, p in moves[:20]:
            log(f"  would move {p}")
        log("Dry run: nothing moved.")
        return {"verified": len(verified), "files": len(moves), "bytes": total}

    # record first, so a crash mid-move never leaves a live song without an archive entry
    doc = {"version": 1, "tracks": dict(archived)}
    for tid, t in verified.items():
        doc["tracks"][tid] = {k: t.get(k) for k in ARCHIVE_FIELDS}
    write_json_atomic(build.archived, doc, indent=1)
    trash = Path(os.path.expanduser(str(args.trash_dir))) if args.trash_dir else \
        Path.home() / ".Trash" / f"Prag-Music uploaded songs {dt.date.today().isoformat()}"
    freed = 0
    for tid, p in moves:
        sub = "encoded" if build.audio.resolve() in p.parents else "downloads"
        try:
            freed += _trash_move(p, trash / sub)
        except OSError as e:
            log(f"  could not move {p}: {e}")
    log(f"Archived {len(verified)} songs ({len(doc['tracks'])} total in {build.archived.name}); "
        f"moved {freed / 1e9:.2f} GB to {trash}")
    return {"verified": len(verified), "files": len(moves), "bytes": freed}


# --------------------------------------------------------------------------- CLI

def cmd_all(args) -> None:
    cmd_match(args)
    stats = cmd_encode(args)
    cmd_manifest(args)
    cmd_upload(args)
    if stats["failed"]:
        sys.exit(1)


def main(argv=None) -> None:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--build-dir", type=Path, default=DEFAULT_BUILD, help="default: scripts/build")
    common.add_argument("--csv", type=Path, default=DEFAULT_CSV, help="default: data/core-library.csv")
    common.add_argument("--playlists", type=Path, default=DEFAULT_PLAYLISTS, help="default: data/playlists.json")
    common.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES, help="default: data/overrides.csv")

    ap = argparse.ArgumentParser(description="Prag Music ingest: local files -> bucket layout (docs/contract.md)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def src_arg(p):
        p.add_argument("--source", action="append", required=True, metavar="DIR",
                       help="music folder to scan recursively (repeatable)")

    def upload_args(p):
        p.add_argument("--url", default=None,
                       help="Worker base URL (default: PRAG_MUSIC_URL from worker/.secrets.local)")
        p.add_argument("--dry-run", action="store_true", help="show what would be uploaded, upload nothing")
        p.add_argument("--force", action="store_true", help="upload everything even if unchanged")

    p = sub.add_parser("match", parents=[common], help="match CSV songs to local files")
    src_arg(p)
    p.set_defaults(func=cmd_match)
    p = sub.add_parser("encode", parents=[common], help="encode matched files to AAC 256k m4a + art")
    p.set_defaults(func=cmd_encode)
    p = sub.add_parser("manifest", parents=[common], help="write build/library.json")
    p.set_defaults(func=cmd_manifest)
    p = sub.add_parser("upload", parents=[common], help="upload new/changed objects, library.json last")
    upload_args(p)
    p.set_defaults(func=cmd_upload)
    p = sub.add_parser("all", parents=[common], help="match, encode, manifest, upload")
    src_arg(p)
    upload_args(p)
    p.set_defaults(func=cmd_all)
    p = sub.add_parser("archive", parents=[common],
                       help="move local files of songs verified in the bucket to the Trash (they stay in the app)")
    src_arg(p)
    p.add_argument("--url", default=None, help="Worker base URL (default: PRAG_MUSIC_URL)")
    p.add_argument("--dry-run", action="store_true", help="list what would move, move nothing")
    p.add_argument("--keep-encoded", action="store_true", help="leave build/audio/<id>.m4a in place")
    p.add_argument("--trash-dir", default=None, help="where to move files (default: a dated folder in ~/.Trash)")
    p.set_defaults(func=cmd_archive)

    args = ap.parse_args(argv)
    for name in ("build_dir", "csv", "playlists", "overrides"):
        setattr(args, name, Path(os.path.expanduser(str(getattr(args, name)))).resolve())
    try:
        args.func(args)
    except KeyboardInterrupt:
        die("interrupted", 130)


if __name__ == "__main__":
    main()

