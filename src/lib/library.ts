import seed from '../data/seed-library.json';
import { ApiError, fetchLibrary } from './api';
import { serverConfig } from './config';
import { readJson, writeJson } from './persist';
import { createStore, useStore } from './store';
import type { Library, Playlist, ServerConfig, Track } from './types';

type LibraryState = {
  library: Library;
  tracksById: Record<string, Track>;
  source: 'seed' | 'cache' | 'server';
  config: ServerConfig | null;
  ready: boolean;
  syncing: boolean;
  syncError: string | null;
  /** True when the last sync failed because the server could not be reached. */
  offline: boolean;
  lastSyncedAt: number | null;
};

type CachedLibrary = { library: Library; etag: string | null; syncedAt: number };

const CACHE = 'library-cache.json';

function index(library: Library): Record<string, Track> {
  const out: Record<string, Track> = {};
  for (const t of library.tracks) out[t.id] = t;
  return out;
}

const seedLibrary = seed as Library;

export const libraryStore = createStore<LibraryState>({
  library: seedLibrary,
  tracksById: index(seedLibrary),
  source: 'seed',
  config: null,
  ready: false,
  syncing: false,
  syncError: null,
  offline: false,
  lastSyncedAt: null,
});

let etag: string | null = null;

function setLibrary(library: Library, source: LibraryState['source']) {
  libraryStore.set({ library, tracksById: index(library), source });
}

export async function initLibrary(): Promise<void> {
  const cached = readJson<CachedLibrary>(CACHE);
  if (cached?.library?.version === 1) {
    etag = cached.etag;
    setLibrary(cached.library, 'cache');
    libraryStore.set({ lastSyncedAt: cached.syncedAt });
  }
  libraryStore.set({ config: serverConfig, ready: true });
  if (serverConfig) void syncLibrary();
}

export async function syncLibrary(): Promise<void> {
  const { config, syncing } = libraryStore.get();
  if (!config || syncing) return;
  libraryStore.set({ syncing: true, syncError: null });
  try {
    const res = await fetchLibrary(config, libraryStore.get().source === 'seed' ? null : etag);
    const now = Date.now();
    if (res.kind === 'library') {
      etag = res.etag;
      setLibrary(res.library, 'server');
      writeJson(CACHE, { library: res.library, etag, syncedAt: now } satisfies CachedLibrary);
    } else {
      libraryStore.set({ source: 'server' });
    }
    libraryStore.set({ lastSyncedAt: now, offline: false });
  } catch (e) {
    if (e instanceof ApiError) libraryStore.set({ syncError: e.message, offline: false });
    else libraryStore.set({ syncError: 'Offline. Playing downloaded songs only.', offline: true });
  } finally {
    libraryStore.set({ syncing: false });
  }
}

export function isPlayable(track: Track | undefined, downloaded: boolean): boolean {
  const { config, offline } = libraryStore.get();
  return !!track && (downloaded || (!!track.audioKey && !!config && !offline));
}

export const useLibrary = () => useStore(libraryStore, (s) => s.library);
export const useTracksById = () => useStore(libraryStore, (s) => s.tracksById);
export const useSyncError = () => useStore(libraryStore, (s) => s.syncError);
export const useConfig = () => useStore(libraryStore, (s) => s.config);
export const useOffline = () => useStore(libraryStore, (s) => s.offline);

export function usePlaylist(id: string | undefined): Playlist | undefined {
  return useStore(libraryStore, (s) => s.library.playlists.find((p) => p.id === id));
}

