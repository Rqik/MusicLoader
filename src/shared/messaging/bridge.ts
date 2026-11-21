import { isAudioDiagnostics } from '../../features/diagnostics/validation';
import { isTrack } from '../../features/player/lib/metadata';
import { isDocumentKey, isDownloadProgress, isPlaybackState, isPlayerError } from './messages';
import { isDownloadResolution, type DownloadResolution } from '../../features/downloads/lib/direct-download';
import type { Track } from '../types/track';
import type { AudioDiagnostics } from '../../features/diagnostics/types';
import type { PlaybackState, PlayerError } from '../../features/player/types';
export const BRIDGE_VERSION = 1;
export type BridgeUpdate = {
  source: 'musicloader:page'; version: 1; channel: string; type: 'TRACK'; track: Track | null; playbackState: PlaybackState; error: PlayerError;
} | { source: 'musicloader:page'; version: 1; channel: string; type: 'DIAGNOSTICS'; report: AudioDiagnostics }
  | { source: 'musicloader:page'; version: 1; channel: string; type: 'DOWNLOAD_RESULT'; requestId: string; resolution: DownloadResolution };
export type DownloadProgressUpdate = { source: 'musicloader:page'; version: 1; channel: string; type: 'DOWNLOAD_PROGRESS'; requestId: string; progress: number };
export type PageUpdate = BridgeUpdate | DownloadProgressUpdate;
export function isBridgeUpdate(value: unknown, channel: string): value is PageUpdate {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  if (item.source !== 'musicloader:page' || item.version !== BRIDGE_VERSION || item.channel !== channel) return false;
  if (item.type === 'TRACK') return Object.keys(item).length === 7 && (item.track === null || isTrack(item.track)) && isPlaybackState(item.playbackState) && isPlayerError(item.error);
  if (item.type === 'DOWNLOAD_RESULT') return Object.keys(item).length === 6 && isDocumentKey(item.requestId) && isDownloadResolution(item.resolution);
  if (item.type === 'DOWNLOAD_PROGRESS') return Object.keys(item).length === 6 && isDocumentKey(item.requestId) && isDownloadProgress(item.progress);
  return item.type === 'DIAGNOSTICS' && Object.keys(item).length === 5 && isAudioDiagnostics(item.report);
}
