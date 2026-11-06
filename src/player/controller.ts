import {
  createAudioPlaylist,
  setAudioModeAsync,
  type AudioPlaylist,
  type AudioPlaylistStatus,
  type AudioSource,
} from 'expo-audio';
import { artUrl, audioUrl } from '../lib/api';
import { downloadsStore, localUri } from '../lib/downloads';
import { shuffled } from '../lib/format';
import { libraryStore, syncLibrary } from '../lib/library';
import { readJson, writeJsonSoon } from '../lib/persist';
import { recordListen } from '../lib/stats';
import { createStore, useStore } from '../lib/store';
import type { RepeatMode, Track } from '../lib/types';

// The native AudioPlaylist only holds a window of the queue: a few songs behind
// and about 25 ahead. That keeps memory flat with an 888-song queue while the
// native side still handles track changes, lock screen next/previous and
// background playback. The JS side refills the window as songs advance.

const BEHIND = 3;
const AHEAD = 25;
const REFILL_WHEN_LEFT = 6;

export type PlayerState = {
  queue: string[]; // logical play order (already shuffled when shuffle is on)
  baseQueue: string[]; // order before shuffling
  index: number; // logical index of the current song, -1 when nothing is loaded
  sourceLabel: string;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: RepeatMode;
  error: string | null;
};

export const playerStore = createStore<PlayerState>({
  queue: [],
  baseQueue: [],
  index: -1,
  sourceLabel: '',
  playing: false,
  buffering: false,
  position: 0,
  duration: 0,
  shuffle: false,
  repeat: 'off',
  error: null,
});

type Saved = Pick<PlayerState, 'queue' | 'baseQueue' | 'index' | 'sourceLabel' | 'shuffle' | 'repeat' | 'position'>;
const SAVE_FILE = 'player.json';

let playlist: AudioPlaylist | null = null;
/** Logical queue index for each item in the native playlist. */
let windowLogical: number[] = [];
let listen = { trackId: '', maxPosition: 0, duration: 0 };
let lockScreenActive = false;
/** A seek that waits until the current song has loaded (seeking an unloaded item is unsafe on iOS). */
let pendingSeek: number | null = null;
/** Marks native items left behind the current song after a rebase; they no longer match the queue. */
const STALE = -1;

function track(id: string | undefined): Track | undefined {
  return id ? libraryStore.get().tracksById[id] : undefined;
}

export function canPlay(id: string): boolean {
  if (downloadsStore.get().entries[id]?.state === 'done') return true;
  const { config, offline } = libraryStore.get();
  return !!track(id)?.audioKey && !!config && !offline;
}

function sourceFor(id: string): AudioSource {
  const t = track(id);
  const local = localUri(id);
  const config = libraryStore.get().config;
  const uri = local ?? (config ? audioUrl(config, id) : '');
  return { uri, name: t ? `${t.title} - ${t.artist}` : id };
}

function metadataFor(id: string) {
  const t = track(id);
  const config = libraryStore.get().config;
  return {
    title: t?.title ?? 'Unknown',
    artist: t?.artist ?? '',
    albumTitle: t?.album ?? undefined,
    artworkUrl: t?.artKey && config ? artUrl(config, id) : undefined,
  };
}

function save() {
  writeJsonSoon(SAVE_FILE, (): Saved => {
    const s = playerStore.get();
    return {
      queue: s.queue,
      baseQueue: s.baseQueue,
      index: s.index,
      sourceLabel: s.sourceLabel,
      shuffle: s.shuffle,
      repeat: s.repeat,
      position: s.position,
    };
  });
}

function nextLogical(i: number): number | null {
  const { queue, repeat } = playerStore.get();
  if (i + 1 < queue.length) return i + 1;
  return repeat === 'all' && queue.length > 0 ? 0 : null;
}

function finishListen() {
  if (listen.trackId) recordListen(listen.trackId, listen.maxPosition, listen.duration);
  listen = { trackId: '', maxPosition: 0, duration: 0 };
}

function beginListen(id: string) {
  finishListen();
  listen = { trackId: id, maxPosition: 0, duration: track(id)?.durationSec ?? 0 };
}

function updateLockScreen(id: string) {
  if (!playlist) return;
  const metadata = metadataFor(id);
  if (!lockScreenActive) {
    playlist.setActiveForLockScreen(true, metadata, {
      showNextTrack: true,
      showPreviousTrack: true,
      showSeekForward: false,
      showSeekBackward: false,
    });
    lockScreenActive = true;
  } else {
    playlist.updateLockScreenMetadata(metadata);
  }
}

// Events arrive after JS has already reshaped the playlist (clear, remove, add),
// so the payload index can be stale. Read the live index instead.
function onTrackChanged() {
  if (!playlist) return;
  const logical = windowLogical[playlist.currentIndex];
  if (logical === undefined) return;
  const s = playerStore.get();
  if (logical === STALE) {
    // Went back into an item from before a shuffle or "play next": rebuild around the real previous song.
    loadWindow(Math.max(0, s.index - 1), playlist.playing);
    return;
  }
  const id = s.queue[logical];
  if (logical !== s.index || listen.trackId !== id) {
    pendingSeek = null; // a restored position belongs to the old song only
    beginListen(id);
    playerStore.set({ index: logical, position: 0, duration: track(id)?.durationSec ?? 0 });
    updateLockScreen(id);
    save();
  }
  refill();
}

function onStatus(status: AudioPlaylistStatus) {
  const s = playerStore.get();
  if (pendingSeek !== null) {
    if (status.isLoaded && playlist) {
      const to = pendingSeek;
      pendingSeek = null;
      void playlist.seekTo(to);
    }
    if (s.playing !== status.playing || s.buffering !== status.isBuffering) {
      playerStore.set({ playing: status.playing, buffering: status.isBuffering });
    }
    return; // keep the saved position until the seek lands
  }
  if (status.didJustFinish && playlist) {
    // The native list only reports this when its last loaded song ends. Carry on with
    // the rest of the queue, or reset to the first song (paused) when the queue is done.
    const n = nextLogical(s.index);
    setTimeout(() => (n === null ? loadWindow(0, false) : loadWindow(n, true)), 0);
    return;
  }
  if (listen.trackId && status.currentTime > listen.maxPosition) listen.maxPosition = status.currentTime;
  if (status.duration > 0) listen.duration = status.duration;
  const patch: Partial<PlayerState> = {
    playing: status.playing,
    // Some platforms keep reporting buffering while time moves; only call it loading when stuck.
    buffering: status.isBuffering && status.currentTime <= s.position,
    position: status.currentTime,
  };
  if (status.duration > 0) patch.duration = status.duration;
  if (
    s.playing !== patch.playing ||
    s.buffering !== patch.buffering ||
    Math.abs(s.position - status.currentTime) >= 0.25 ||
    (patch.duration && patch.duration !== s.duration)
  ) {
    playerStore.set(patch);
    // Save on pause, and every few seconds while playing, so a killed app resumes close to where it was.
    if (!status.playing || Math.floor(status.currentTime) % 5 === 0) save();
  }
}

/** Appends songs to the native playlist when it is about to run out. */
function refill() {
  if (!playlist) return;
  const current = playlist.currentIndex;
  if (windowLogical.length - current - 1 > REFILL_WHEN_LEFT) return;
  let last = windowLogical[windowLogical.length - 1];
  const { queue } = playerStore.get();
  let added = 0;
  while (added < AHEAD && last !== undefined) {
    const next = nextLogical(last);
    if (next === null) break;
    // Stop if one full cycle is already queued ahead (short queues with repeat all).
    if (windowLogical.length - current - 1 >= queue.length) break;
    playlist.add(sourceFor(queue[next]));
    windowLogical.push(next);
    last = next;
    added++;
  }
}

/** Rebuilds the native playlist around logical index `at`. */
function loadWindow(at: number, autoplay: boolean, seekTo = 0) {
  if (!playlist) return;
  const { queue } = playerStore.get();
  const start = Math.max(0, at - BEHIND);
  const end = Math.min(queue.length, at + AHEAD + 1);
  playlist.clear();
  windowLogical = [];
  for (let i = start; i < end; i++) {
    playlist.add(sourceFor(queue[i]));
    windowLogical.push(i);
  }
  const id = queue[at];
  pendingSeek = seekTo > 0 ? seekTo : null;
  playlist.skipTo(at - start);
  beginListen(id);
  playerStore.set({ index: at, position: seekTo, duration: track(id)?.durationSec ?? 0, error: null });
  updateLockScreen(id);
  if (autoplay) playlist.play();
  refill();
  save();
}

/** Keeps the current song playing and replaces everything around it. */
function rebaseKeepingCurrent(queue: string[], index: number) {
  if (!playlist) return;
  const current = playlist.currentIndex;
  // Only remove songs after the current one. Removing earlier ones makes iOS reload
  // the current song from the start, so those are kept and marked stale instead.
  for (let i = playlist.trackCount - 1; i > current; i--) playlist.remove(i);
  windowLogical = windowLogical.slice(0, current + 1).map((_, j) => (j === current ? index : STALE));
  playerStore.set({ queue, index });
  refill();
  save();
}

export async function initPlayer(): Promise<void> {
  if (playlist) return;
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'doNotMix',
    allowsRecording: false,
  }).catch((e) => console.warn('audio mode', e));
  playlist = createAudioPlaylist({ updateInterval: 500, loop: 'none' });
  playlist.addListener('trackChanged', onTrackChanged);
  playlist.addListener('playlistStatusUpdate', onStatus);

  const saved = readJson<Saved>(SAVE_FILE);
  if (saved && saved.queue?.length && saved.index >= 0) {
    const queue = saved.queue.filter(canPlay);
    const index = Math.min(queue.indexOf(saved.queue[saved.index]), queue.length - 1);
    if (index >= 0) {
      playerStore.set({
        queue,
        baseQueue: saved.baseQueue.filter(canPlay),
        sourceLabel: saved.sourceLabel,
        shuffle: saved.shuffle,
        repeat: saved.repeat,
      });
      playlist.loop = saved.repeat === 'one' ? 'single' : 'none';
      loadWindow(index, false, saved.position);
    }
  }
}

export type PlayOptions = { startId?: string; shuffle?: boolean; label?: string };

/** Plays a list of songs. Songs without audio are left out. */
export function playTracks(ids: string[], options: PlayOptions = {}): boolean {
  const offline = libraryStore.get().offline;
  if (offline) void syncLibrary();
  if (options.startId && !canPlay(options.startId)) {
    playerStore.set({ error: offline ? 'Offline, and this song is not downloaded.' : 'This song has no audio yet.' });
    return false;
  }
  const playable = ids.filter(canPlay);
  if (!playable.length) {
    playerStore.set({ error: offline ? 'Offline, and none of these songs are downloaded.' : 'None of these songs have audio yet.' });
    return false;
  }
  const shuffle = options.shuffle ?? playerStore.get().shuffle;
  let queue = playable;
  let index = options.startId ? Math.max(0, playable.indexOf(options.startId)) : 0;
  if (shuffle) {
    const first = options.startId && playable.includes(options.startId) ? options.startId : null;
    const rest = shuffled(playable.filter((id) => id !== first));
    queue = first ? [first, ...rest] : rest;
    index = 0;
  }
  playerStore.set({ queue, baseQueue: playable, shuffle, sourceLabel: options.label ?? '', error: null });
  loadWindow(index, true);
  return true;
}

export function togglePlay() {
  if (!playlist || playerStore.get().index < 0) return;
  if (playlist.playing) playlist.pause();
  else playlist.play();
}

export function next() {
  if (!playlist) return;
  const { index } = playerStore.get();
  if (index < 0) return;
  pendingSeek = null;
  if (playlist.currentIndex < playlist.trackCount - 1) playlist.next();
  else {
    const n = nextLogical(index);
    if (n !== null) loadWindow(n, true);
  }
}

export function previous() {
  if (!playlist) return;
  const { index, position } = playerStore.get();
  if (index < 0) return;
  if (position > 3) {
    void playlist.seekTo(0);
    return;
  }
  if (playlist.currentIndex > 0 && windowLogical[playlist.currentIndex - 1] === STALE) {
    loadWindow(Math.max(0, index - 1), playlist.playing);
  } else if (playlist.currentIndex > 0) playlist.previous();
  else if (index > 0) loadWindow(index - 1, playlist.playing);
  else void playlist.seekTo(0);
}

export function seek(seconds: number) {
  if (!playlist) return;
  playerStore.set({ position: seconds });
  if (!playlist.isLoaded) pendingSeek = seconds;
  else void playlist.seekTo(seconds);
}

export function jumpTo(logicalIndex: number) {
  const { queue } = playerStore.get();
  if (logicalIndex < 0 || logicalIndex >= queue.length) return;
  const w = windowLogical.indexOf(logicalIndex);
  if (playlist && w >= 0 && w > playlist.currentIndex) {
    pendingSeek = null;
    playlist.skipTo(w);
    playlist.play();
  } else loadWindow(logicalIndex, true);
}

export function toggleShuffle() {
  const s = playerStore.get();
  const currentId = s.queue[s.index];
  if (!currentId) {
    playerStore.set({ shuffle: !s.shuffle });
    return;
  }
  if (!s.shuffle) {
    const rest = shuffled(s.baseQueue.filter((id) => id !== currentId));
    playerStore.set({ shuffle: true });
    rebaseKeepingCurrent([currentId, ...rest], 0);
  } else {
    const index = Math.max(0, s.baseQueue.indexOf(currentId));
    playerStore.set({ shuffle: false });
    rebaseKeepingCurrent(s.baseQueue, index);
  }
}

export function cycleRepeat() {
  const order: RepeatMode[] = ['off', 'all', 'one'];
  const s = playerStore.get();
  const repeat = order[(order.indexOf(s.repeat) + 1) % order.length];
  playerStore.set({ repeat });
  if (playlist) playlist.loop = repeat === 'one' ? 'single' : 'none';
  // Leaving "repeat all": drop songs that were queued natively by wrapping back to the start.
  if (s.repeat === 'all' && playlist && s.index >= 0) {
    const ahead = windowLogical.slice(playlist.currentIndex + 1);
    if (ahead.some((l) => l !== STALE && l <= s.index)) {
      rebaseKeepingCurrent(s.queue, s.index);
      return;
    }
  }
  refill();
  save();
}

/** Inserts a song right after the current one. */
export function playNext(id: string) {
  if (!canPlay(id)) return;
  const s = playerStore.get();
  if (s.index < 0) {
    playTracks([id]);
    return;
  }
  const queue = s.queue.slice();
  queue.splice(s.index + 1, 0, id);
  const baseQueue = s.baseQueue.includes(id) ? s.baseQueue : [...s.baseQueue, id];
  playerStore.set({ baseQueue });
  rebaseKeepingCurrent(queue, s.index);
}

export const usePlayer = <S,>(selector: (s: PlayerState) => S) => useStore(playerStore, selector);
export const useCurrentId = () => usePlayer((s) => (s.index >= 0 ? s.queue[s.index] : undefined));

