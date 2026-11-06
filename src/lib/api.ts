import type { Library, ServerConfig } from './types';

export function audioUrl(config: ServerConfig, trackId: string): string {
  return `${config.baseUrl}/audio/${trackId}?token=${encodeURIComponent(config.token)}`;
}

export function artUrl(config: ServerConfig, trackId: string): string {
  return `${config.baseUrl}/art/${trackId}?token=${encodeURIComponent(config.token)}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type LibraryResponse =
  | { kind: 'unchanged' }
  | { kind: 'library'; library: Library; etag: string | null };

export async function fetchLibrary(config: ServerConfig, etag: string | null): Promise<LibraryResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.token}` };
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(`${config.baseUrl}/library`, { headers });
  if (res.status === 304) return { kind: 'unchanged' };
  if (res.status === 401) throw new ApiError('The music server rejected this build. Rebuild the app.', 401);
  if (res.status === 404) throw new ApiError('No songs uploaded yet.', 404);
  if (!res.ok) throw new ApiError(`Server error ${res.status}`, res.status);
  const library = (await res.json()) as Library;
  if (library.version !== 1 || !Array.isArray(library.tracks)) {
    throw new ApiError('The server sent a library this app does not understand.', 0);
  }
  return { kind: 'library', library, etag: res.headers.get('ETag') };
}
