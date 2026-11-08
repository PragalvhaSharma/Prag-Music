# Ingest scripts

`ingest.py` turns your own music files into what the Worker serves from the private B2 bucket (see `docs/contract.md`): one AAC 256 kbps `.m4a` per song, optional 600x600 cover art, and a `library.json` listing all 888 songs from `data/core-library.csv`. It needs Python 3.9+ and `ffmpeg`/`ffprobe` (`brew install ffmpeg`), nothing else.

## Where to put your music

Anywhere. Point `--source` at one or more folders and they are scanned recursively for mp3, m4a, aac, flac, wav, aiff, alac, ogg, opus and wma. Hidden files and macOS `._` files are skipped. Lossless sources give the best result, since everything is encoded once to AAC 256 kbps; an AAC file that is already 240 kbps or more is copied without re-encoding.

## Running it

From the repo root, after `worker/scripts/setup.sh` has written `worker/.secrets.local`:

```sh
# 1. find a file for every song; writes scripts/build/match-report.csv
python3 scripts/ingest.py match --source ~/Music/Rips --source "/Volumes/USB/Old iTunes"

# 2. encode matched songs to scripts/build/audio/<id>.m4a and scripts/build/art/<id>.jpg
python3 scripts/ingest.py encode

# 3. write scripts/build/library.json
python3 scripts/ingest.py manifest

# 4. upload what changed, library.json last (see the token section below)
python3 scripts/ingest.py upload --dry-run
python3 scripts/ingest.py upload

# or all four in one go
python3 scripts/ingest.py all --source ~/Music/Rips
```

Every step can be rerun safely. Probe results and hashes are cached in `scripts/build/cache/`, encode skips songs whose output is newer than the source, the manifest keeps the old `library.json` when nothing but the timestamp would change, and upload sends only objects whose size or content differs from what is in the bucket. Content is compared by sha256 when the listing has one; B2 listings never do, so it falls back to the MD5 ETag, which matches because uploads are single-part. `--force` on upload resends everything. B2 keeps a replaced file for about a day before deleting it, so a full `--force` resend of the 6.4 GB library would briefly need about 12.8 GB and stop at the 10 GB free limit; resend only what changed instead.

## Reading the match report

`scripts/build/match-report.csv` has one row per song: `track_id,name,artist,status,score,file_path`.

- `matched`: the file will be encoded. Score is out of 1.0 (title similarity, artist overlap, and length within 4 seconds of Spotify's). `override` means the row came from `data/overrides.csv`.
- `ambiguous`: two or more different files scored within 0.04 of each other, so none was picked. `file_path` lists the candidates separated by ` | `. When the tied files look like copies of one song (same title, lengths within 2 seconds) the best quality copy is picked automatically instead (lossless first, then bitrate).
- `missing`: nothing scored high enough. If something came close, its path is shown in `file_path` so you can copy it into an override.

`scripts/build/unused-files.txt` lists scanned files that did not match any song, which helps spot songs whose file has an odd name.

## Overrides

Create `data/overrides.csv` to pin a song to a file, or to keep a song out:

```csv
track_id,file_path
3hxIUxnT27p5WcmjGUXNwx,/Users/prag/Music/Rips/Hotel Ugly - Shut Up My Moms Calling.flac
4qKcDkK6siZ7Jp1Jb4m0aL,-
```

The track id is the last part of the Spotify URI (it is also the first column of the match report). Relative paths are resolved from the repo root, `~` works, and a `-` (or empty) path forces the song to stay missing. Rerun `match` after editing; overrides win over everything else.

## Server address and admin token

`upload` (and `all`) sends to `--url` if given, otherwise to `PRAG_MUSIC_URL` from `worker/.secrets.local`. It sends `Authorization: Bearer <ADMIN_TOKEN>`, reading the token from the `PRAG_MUSIC_ADMIN_TOKEN` environment variable, or from the `ADMIN_TOKEN=...` line in `worker/.secrets.local`. A 401 stops the run straight away. If any upload fails after retries, `library.json` is not updated, so the app never points at audio that is not there; rerun to retry.

## Notes

- `watch_ingest.py <folder>` keeps a download folder in sync while files arrive. Files named `<spotify track id> - <title>.mp3` are pinned to that song (no fuzzy matching), files more than 30 s off Spotify's length are held back and listed in `build/watch-review.csv`, and a run is skipped if it would take audio away from a song that is already live. It exits once the downloader (`--downloader`, default `spotmate_batch`) has stopped and no new files have arrived for 30 minutes.
- `archive --source <folder>` frees disk space once songs are live. For every song in `library.json` whose bucket object matches the local encode (size and MD5), it records the song in `build/archived.json` and moves the exact file that encode was made from, plus `build/audio/<id>.m4a`, to a dated folder in `~/.Trash`. Later runs keep publishing archived songs from the bucket copy; a fresh download of the same song takes over again. Delete a song's entry from `archived.json` to take it out of the app (a running watcher then needs `--allow-removals`). `watch_ingest.py --archive` runs this after every successful upload.
- Titles and artists in `library.json` always come from the Spotify CSV. File tags only supply `album`.
- The manifest publishes audio only for songs that are `matched` in the current report, so un-matching a song (or forcing it to `-`) removes it from the app on the next upload. The object itself stays in the bucket; delete it with `DELETE /admin/objects/<key>` if you want the space back (B2 frees it a day later).
- Sources above 48 kHz are resampled to 48 or 44.1 kHz, and surround is downmixed to stereo. Cover art comes from the file's embedded picture, or from a `cover.jpg`/`folder.jpg`/`front.jpg` next to the file.
- Other options: `--build-dir`, `--csv`, `--playlists`, `--overrides` (defaults as above).
