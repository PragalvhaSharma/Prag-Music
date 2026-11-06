# Ingest scripts

`ingest.py` turns your own music files into what the Worker serves from R2 (see `docs/contract.md`): one AAC 256 kbps `.m4a` per song, optional 600x600 cover art, and a `library.json` listing all 888 songs from `data/core-library.csv`. It needs Python 3.9+ and `ffmpeg`/`ffprobe` (`brew install ffmpeg`), nothing else.

## Where to put your music

Anywhere. Point `--source` at one or more folders and they are scanned recursively for mp3, m4a, aac, flac, wav, aiff, alac, ogg, opus and wma. Hidden files and macOS `._` files are skipped. Lossless sources give the best result, since everything is encoded once to AAC 256 kbps; an AAC file that is already 240 kbps or more is copied without re-encoding.

## Running it

From the repo root:

```sh
# 1. find a file for every song; writes scripts/build/match-report.csv
python3 scripts/ingest.py match --source ~/Music/Rips --source "/Volumes/USB/Old iTunes"

# 2. encode matched songs to scripts/build/audio/<id>.m4a and scripts/build/art/<id>.jpg
python3 scripts/ingest.py encode

# 3. write scripts/build/library.json
python3 scripts/ingest.py manifest

# 4. upload what changed, library.json last (see the token section below)
python3 scripts/ingest.py upload --url https://prag-music.<account>.workers.dev --dry-run
python3 scripts/ingest.py upload --url https://prag-music.<account>.workers.dev

# or all four in one go
python3 scripts/ingest.py all --source ~/Music/Rips --url https://prag-music.<account>.workers.dev
```

Every step can be rerun safely. Probe results and hashes are cached in `scripts/build/cache/`, encode skips songs whose output is newer than the source, the manifest keeps the old `library.json` when nothing but the timestamp would change, and upload sends only objects whose sha256 (or size, or MD5 ETag) differs from what is in R2. `--force` on upload resends everything.

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

## Admin token

`upload` sends `Authorization: Bearer <ADMIN_TOKEN>`. It reads the token from the `PRAG_MUSIC_ADMIN_TOKEN` environment variable, or from a line `ADMIN_TOKEN=...` in `worker/.secrets.local` if that file exists. A 401 stops the run straight away. If any upload fails after retries, `library.json` is not updated, so the app never points at audio that is not there; rerun to retry.

## Notes

- Titles and artists in `library.json` always come from the Spotify CSV. File tags only supply `album`.
- The manifest publishes audio only for songs that are `matched` in the current report, so un-matching a song (or forcing it to `-`) removes it from the app on the next upload. The object itself stays in R2; delete it with `DELETE /admin/objects/<key>` if you want the space back.
- Sources above 48 kHz are resampled to 48 or 44.1 kHz, and surround is downmixed to stereo. Cover art comes from the file's embedded picture, or from a `cover.jpg`/`folder.jpg`/`front.jpg` next to the file.
- Other options: `--build-dir`, `--csv`, `--playlists`, `--overrides` (defaults as above).
