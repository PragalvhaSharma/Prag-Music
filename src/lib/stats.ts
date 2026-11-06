import { readJson, writeJsonSoon } from './persist';
import { createStore, useStore } from './store';
import type { TrackStats } from './types';

// Every play and skip is logged on the phone. This is the raw material for
// "most played", smarter shuffles and recommendations later.

type StatsState = { byTrack: Record<string, TrackStats>; events: PlayEvent[] };

export type PlayEvent = {
  trackId: string;
  at: number;
  secondsListened: number;
  durationSec: number;
  outcome: 'play' | 'skip' | 'partial';
};

const FILE = 'stats.json';
const MAX_EVENTS = 20000;

export const statsStore = createStore<StatsState>({ byTrack: {}, events: [] });

export function initStats(): void {
  const saved = readJson<StatsState>(FILE);
  if (saved?.byTrack) statsStore.set({ byTrack: saved.byTrack, events: saved.events ?? [] });
}

/** Counts a play when you hear at least half the song or 4 minutes; a skip under 30 seconds. */
export function recordListen(trackId: string, secondsListened: number, durationSec: number): void {
  if (secondsListened < 1) return;
  const playThreshold = Math.min(240, Math.max(1, durationSec) * 0.5);
  const outcome: PlayEvent['outcome'] =
    secondsListened >= playThreshold ? 'play' : secondsListened < 30 ? 'skip' : 'partial';
  const now = Date.now();
  statsStore.set((s) => {
    const prev = s.byTrack[trackId] ?? { plays: 0, skips: 0, lastPlayedAt: null, secondsListened: 0 };
    const next: TrackStats = {
      plays: prev.plays + (outcome === 'play' ? 1 : 0),
      skips: prev.skips + (outcome === 'skip' ? 1 : 0),
      lastPlayedAt: outcome === 'skip' ? prev.lastPlayedAt : now,
      secondsListened: prev.secondsListened + secondsListened,
    };
    const events = s.events.length >= MAX_EVENTS ? s.events.slice(-MAX_EVENTS + 1) : s.events.slice();
    events.push({ trackId, at: now, secondsListened: Math.round(secondsListened), durationSec, outcome });
    return { byTrack: { ...s.byTrack, [trackId]: next }, events };
  });
  writeJsonSoon(FILE, () => statsStore.get());
}

export const useStats = () => useStore(statsStore, (s) => s.byTrack);
export const useEventCount = () => useStore(statsStore, (s) => s.events.length);

