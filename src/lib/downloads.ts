import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { audioUrl } from './api';
import { libraryStore } from './library';
import { createStore, useStore } from './store';
import type { DownloadEntry } from './types';

// Downloaded songs live in Documents/prag-music/audio/<id>.m4a so iOS keeps them
// (the cache folder can be purged when storage runs low).

type DownloadsState = { entries: Record<string, DownloadEntry>; active: number };

export const downloadsStore = createStore<DownloadsState>({ entries: {}, active: 0 });

const CONCURRENCY = 3;
const supported = Platform.OS !== 'web';
const pending: string[] = [];
const tasks = new Map<string, { cancel: () => void }>();

function audioDir(): Directory {
  const dir = new Directory(Paths.document, 'prag-music', 'audio');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function fileFor(id: string): File {
  return new File(audioDir(), `${id}.m4a`);
}

function setEntry(id: string, entry: DownloadEntry | null) {
  downloadsStore.set((s) => {
    const entries = { ...s.entries };
    if (entry) entries[id] = entry;
    else delete entries[id];
    return { entries };
  });
}

/** Scans the audio folder at startup. Partial files are removed. */
export function initDownloads(): void {
  if (!supported) return;
  const entries: Record<string, DownloadEntry> = {};
  for (const item of audioDir().list()) {
    if (!(item instanceof File)) continue;
    const name = item.name;
    if (name.endsWith('.part')) {
      item.delete();
      continue;
    }
    if (!name.endsWith('.m4a')) continue;
    const id = name.slice(0, -4);
    entries[id] = { state: 'done', progress: 1, bytes: item.size ?? 0 };
  }
  downloadsStore.set({ entries });
}

export function localUri(id: string): string | null {
  const entry = downloadsStore.get().entries[id];
  return entry?.state === 'done' ? fileFor(id).uri : null;
}

export function isDownloaded(id: string): boolean {
  return downloadsStore.get().entries[id]?.state === 'done';
}

export function downloadTracks(ids: string[]): number {
  if (!supported) return 0;
  const { tracksById, config } = libraryStore.get();
  if (!config) return 0;
  const { entries } = downloadsStore.get();
  let added = 0;
  for (const id of new Set(ids)) {
    const track = tracksById[id];
    if (!track?.audioKey) continue;
    const state = entries[id]?.state;
    if (state === 'done' || state === 'queued' || state === 'downloading') continue;
    pending.push(id);
    setEntry(id, { state: 'queued', progress: 0, bytes: 0 });
    added++;
  }
  pump();
  return added;
}

function pump() {
  while (downloadsStore.get().active < CONCURRENCY && pending.length) {
    const id = pending.shift()!;
    if (downloadsStore.get().entries[id]?.state !== 'queued') continue;
    downloadsStore.set((s) => ({ active: s.active + 1 }));
    void runOne(id).finally(() => {
      downloadsStore.set((s) => ({ active: s.active - 1 }));
      pump();
    });
  }
}

async function runOne(id: string): Promise<void> {
  const { config, tracksById } = libraryStore.get();
  const track = tracksById[id];
  if (!config || !track) {
    setEntry(id, null);
    return;
  }
  const part = new File(audioDir(), `${id}.m4a.part`);
  if (part.exists) part.delete();
  let lastEmit = 0;
  const task = File.createDownloadTask(audioUrl(config, id), part, {
    sessionType: 'background',
    onProgress: ({ bytesWritten, totalBytes }) => {
      const now = Date.now();
      if (now - lastEmit < 250) return;
      lastEmit = now;
      const total = totalBytes > 0 ? totalBytes : track.bytes ?? 0;
      setEntry(id, {
        state: 'downloading',
        progress: total ? bytesWritten / total : 0,
        bytes: bytesWritten,
      });
    },
  });
  tasks.set(id, task);
  setEntry(id, { state: 'downloading', progress: 0, bytes: 0 });
  try {
    const result = await task.downloadAsync();
    if (!result) {
      // The task was paused (not expected here). Drop the partial file so it can be retried.
      if (part.exists) part.delete();
      setEntry(id, null);
      return;
    }
    const size = part.size ?? 0;
    if (track.bytes && size !== track.bytes) {
      throw new Error(`size mismatch: got ${size}, expected ${track.bytes}`);
    }
    const dest = fileFor(id);
    if (dest.exists) dest.delete();
    part.moveSync(dest);
    setEntry(id, { state: 'done', progress: 1, bytes: size });
  } catch (e) {
    if (part.exists) part.delete();
    setEntry(id, { state: 'error', progress: 0, bytes: 0, error: String(e) });
  } finally {
    tasks.delete(id);
  }
}

export function removeDownload(id: string): void {
  if (!supported) return;
  const file = fileFor(id);
  if (file.exists) file.delete();
  setEntry(id, null);
}

export const downloadsSupported = supported;
export const useDownloadEntries = () => useStore(downloadsStore, (s) => s.entries);
export const useDownloadEntry = (id: string) => useStore(downloadsStore, (s) => s.entries[id]);
export const useActiveDownloads = () => useStore(downloadsStore, (s) => s.active);

