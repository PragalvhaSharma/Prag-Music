import { Platform } from 'react-native';
import type { ServerConfig } from './types';

/**
 * On the phone, the server address and key are baked into the app at build time from
 * .env.local, which tools/write-env.mjs fills in from worker/.secrets.local. There is no
 * login or setup screen: the app opens already connected.
 *
 * The public web build (tools/deploy-web.sh) ships without the key, because anyone can
 * read a website's JavaScript. Each browser is unlocked once, either by opening the site
 * with #key=<APP_TOKEN> in the address (the fragment never reaches a server; a script in
 * public/index.html saves it under WEB_KEY and clears the address before the app starts)
 * or by pasting the key on the home screen. The key then stays in that browser's storage.
 */
const envUrl = (process.env.EXPO_PUBLIC_PRAG_MUSIC_URL ?? '').trim().replace(/\/+$/, '');
const envToken = process.env.EXPO_PUBLIC_PRAG_MUSIC_TOKEN ?? '';

const isWeb = Platform.OS === 'web';
const WEB_KEY = 'prag-music:key';

/** True when this build can be unlocked with a key typed into the app (the web build). */
export const canEnterKey = isWeb && !!envUrl;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function webToken(): string {
  return storage()?.getItem(WEB_KEY) || envToken;
}

export function loadServerConfig(): ServerConfig | null {
  const token = isWeb ? webToken() : envToken;
  return envUrl && token ? { baseUrl: envUrl, token } : null;
}

export function saveWebKey(key: string): ServerConfig | null {
  const token = key.trim();
  if (!canEnterKey || !token) return null;
  try {
    storage()?.setItem(WEB_KEY, token);
  } catch {
    // Storage blocked (private mode, site data off): the key still works until the tab closes.
  }
  return { baseUrl: envUrl, token };
}

export function forgetWebKey(): void {
  try {
    storage()?.removeItem(WEB_KEY);
  } catch {
    // Nothing saved to forget.
  }
}
