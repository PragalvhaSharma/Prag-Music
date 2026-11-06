# Prag Music

My own music app for iPhone. It plays the 888 songs from my Spotify playlists **NO BAD SONGS** and **ye ++**, streamed from a private Cloudflare R2 bucket. It plays in the background and on the lock screen, and songs can be downloaded for offline listening. The app has no login or setup screen: it opens already connected and plays.

## How it fits together

```
music files on Mac --scripts/ingest.py--> Cloudflare R2 (private) <--Worker-- iPhone app
```

- `src/`: the Expo app (Expo SDK 58, React Native, expo-router, expo-audio).
- `worker/`: the Cloudflare Worker that serves the bucket. It needs a key, which is baked into the app at build time.
- `scripts/ingest.py`: matches your music files to the 888 songs, converts them to AAC 256 kbps, and uploads them.
- `data/`: the song list (`core-library.csv`) and playlist order (`playlists.json`) exported from Spotify.
- `docs/contract.md`: the bucket layout and Worker API.

## One-time setup

You need:

- A Cloudflare account with R2 turned on. R2 asks for a card, but 10 GB of storage is free and there are no download fees.
- ffmpeg for converting songs: `brew install ffmpeg`.
- Xcode from the App Store. It needs macOS 26.6 or later, so install the macOS update first (System Settings > General > Software Update). Open Xcode once so it installs its extra components, then run `sudo xcodebuild -license accept`.
- Your iPhone and its USB cable.

1. **Host the music server**

   ```sh
   cd worker
   npm install
   npx wrangler login
   bash scripts/setup.sh
   ```

   This creates the bucket, makes the keys, deploys the Worker, and writes `worker/.secrets.local` and `.env.local` (both gitignored).

2. **Upload the songs.** Put the music files in any folder. Names or tags like "Artist - Title" both work. Then, from the repo root:

   ```sh
   python3 scripts/ingest.py all --source ~/Music/prag
   ```

   It reads the server address and upload key from `worker/.secrets.local`. Check `scripts/build/match-report.csv` for songs it couldn't find, and pin any stragglers in `data/overrides.csv`. Re-running only uploads what changed. See [scripts/README.md](scripts/README.md).

3. **Put the app on the iPhone.** In Xcode, sign in with your Apple ID (Xcode > Settings > Accounts). Plug in the iPhone, unlock it and tap Trust. Then:

   ```sh
   npm install
   npm run ios:release
   ```

   The first time, the build may ask you to pick your Apple ID team; choose it and run the command again. On the iPhone:

   - Turn on Developer Mode (Settings > Privacy & Security > Developer Mode) and restart when asked. The switch only shows up after the phone has been plugged into Xcode once.
   - Trust your developer profile (Settings > General > VPN & Device Management > your Apple ID > Trust).

   The Release build has everything inside it, so it runs without the Mac. With a free Apple ID, iOS stops opening the app after 7 days; plug in and run `npm run ios:release` again to renew it. A $99/year Apple Developer account makes it last a year.

Expo Go isn't used. An Expo Go project only runs while the Mac is serving it, so the app is built and installed as its own native app with its own icon and lock screen controls.

## Day to day

- Add songs: drop files in the folder, then re-run `ingest.py all`. The app picks up the new list the next time you open it.
- Offline: long-press a song or tap the download arrow on a playlist to keep it on the phone. With no connection, only downloaded songs play.
- Development: `npm run ios` (debug build, needs the Mac running `npm start`) or `npm run web` for a browser preview.
- Checks: `npm run typecheck`, `cd worker && npm test`.
