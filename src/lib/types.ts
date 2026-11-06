export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  spotifyUri: string;
  audioKey: string | null;
  artKey: string | null;
  bytes: number | null;
  sha256: string | null;
  bitrateKbps: number | null;
};

export type Playlist = {
  id: string;
  name: string;
  spotifyUri: string;
  trackIds: string[];
};

export type Library = {
  version: 1;
  generatedAt: string;
  tracks: Track[];
  playlists: Playlist[];
};

export type ServerConfig = {
  baseUrl: string;
  token: string;
};

export type DownloadState = 'queued' | 'downloading' | 'done' | 'error';

export type DownloadEntry = {
  state: DownloadState;
  progress: number;
  bytes: number;
  error?: string;
};

export type TrackStats = {
  plays: number;
  skips: number;
  lastPlayedAt: number | null;
  secondsListened: number;
};

export type RepeatMode = 'off' | 'all' | 'one';

