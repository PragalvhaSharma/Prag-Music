import type { ServerConfig } from './types';

/**
 * The server address and key are baked into the app at build time from .env.local,
 * which tools/write-env.mjs fills in from worker/.secrets.local. There is no login
 * or setup screen: the app opens already connected.
 */
const envUrl = process.env.EXPO_PUBLIC_PRAG_MUSIC_URL ?? '';
const envToken = process.env.EXPO_PUBLIC_PRAG_MUSIC_TOKEN ?? '';

export const serverConfig: ServerConfig | null =
  envUrl && envToken ? { baseUrl: envUrl.trim().replace(/\/+$/, ''), token: envToken } : null;
