import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

// Small JSON files in the app's document folder. On web this falls back to localStorage.

const isWeb = Platform.OS === 'web';

function dataDir(): Directory {
  const dir = new Directory(Paths.document, 'prag-music');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export function readJson<T>(name: string): T | null {
  try {
    if (isWeb) {
      const raw = globalThis.localStorage?.getItem(`prag-music:${name}`);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    const file = new File(dataDir(), name);
    if (!file.exists) return null;
    return JSON.parse(file.textSync()) as T;
  } catch {
    return null;
  }
}

export function writeJson(name: string, value: unknown): void {
  try {
    const text = JSON.stringify(value);
    if (isWeb) {
      globalThis.localStorage?.setItem(`prag-music:${name}`, text);
      return;
    }
    const file = new File(dataDir(), name);
    if (!file.exists) file.create({ intermediates: true });
    file.writeSync(text);
  } catch (e) {
    console.warn('writeJson failed', name, e);
  }
}

const timers: Record<string, ReturnType<typeof setTimeout>> = {};

/** Coalesces frequent writes (stats, player position) into one write per second. */
export function writeJsonSoon(name: string, getValue: () => unknown, delayMs = 1000): void {
  if (timers[name]) return;
  timers[name] = setTimeout(() => {
    delete timers[name];
    writeJson(name, getValue());
  }, delayMs);
}

