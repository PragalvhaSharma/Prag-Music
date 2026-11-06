import { initDownloads } from '../lib/downloads';
import { AppState } from 'react-native';
import { initLibrary, syncLibrary } from '../lib/library';
import { initStats } from '../lib/stats';
import { initPlayer } from '../player/controller';

let started: Promise<void> | null = null;

export function bootstrap(): Promise<void> {
  if (!started) {
    started = (async () => {
      initStats();
      initDownloads();
      await initLibrary();
      await initPlayer();
      // Pick up newly uploaded songs (or come back online) whenever the app is reopened.
      AppState.addEventListener('change', (state) => {
        if (state === 'active') void syncLibrary();
      });
    })().catch((e) => console.warn('bootstrap failed', e));
  }
  return started;
}

