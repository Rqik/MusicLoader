import type { Track } from '../../shared/types/track';
export type PlaybackState = 'none' | 'paused' | 'playing';
export type PlayerError = 'media-session-unavailable' | 'bridge-unavailable' | 'metadata-read-failed' | null;
export interface PlayerSnapshot {
  tabId: number;
  track: Track | null;
  playbackState: PlaybackState;
  updatedAt: number;
  connection: 'connected' | 'waiting' | 'error';
  error: PlayerError;
}
export const PLAYER_KEY_PREFIX = 'player.tab.';
export const DIAGNOSTICS_KEY_PREFIX = 'diagnostics.tab.';
export function isZvukUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'zvuk.com' || url.hostname.endsWith('.zvuk.com'));
  } catch { return false; }
}
