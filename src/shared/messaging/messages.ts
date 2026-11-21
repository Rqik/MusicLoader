import { isTrack } from '../../features/player/lib/metadata';
import type { Track } from '../types/track';
import { isAudioDiagnostics, isDiagnosticsRecord, type DiagnosticsRecord } from '../../features/diagnostics/validation';
import type { AudioDiagnostics } from '../../features/diagnostics/types';
import type { PlaybackState, PlayerError, PlayerSnapshot } from '../../features/player/types';
import { isDownloadResolution, type DownloadResolution } from '../../features/downloads/lib/direct-download';
import { isDownloadAttempt, type DownloadAttempt } from '../../features/downloads/lib/download-attempt';
import type { HlsRequestFailure } from '../../features/downloads/lib/hls-request';
export type ExtensionMessage =
  | { type: 'PING' } | { type: 'GET_PLAYER_STATE' } | { type: 'GET_DOCUMENT_KEY' } | { type: 'REFRESH_PLAYER' }
  | { type: 'TRACK_UPDATE'; documentKey: string; track: Track | null; playbackState: PlaybackState; error: PlayerError }
  | { type: 'DIAGNOSTICS_REPORT'; documentKey: string; report: AudioDiagnostics }
  | { type: 'SET_DIAGNOSTICS'; tabId: number; isEnabled: boolean }
  | { type: 'DOWNLOAD_TRACK'; tabId: number; track: Track }
  | { type: 'GET_DOWNLOAD_STATUS'; tabId: number }
  | { type: 'RESOLVE_DOWNLOAD'; requestId: string; track: Track }
  | { type: 'RELEASE_DOWNLOAD'; requestId: string }
  | { type: 'DOWNLOAD_PROGRESS'; requestId: string; documentKey: string; progress: number }
  | { type: 'DOWNLOAD_PROGRESS_UPDATE'; tabId: number; track: Track; progress: number }
  | { type: 'SET_BRIDGE_DIAGNOSTICS'; isEnabled: boolean };
export type ExtensionResponse =
  | { type: 'PONG' } | { type: 'ACK'; isDiagnosticsEnabled: boolean }
  | { type: 'DOCUMENT_KEY'; documentKey: string }
  | { type: 'DOWNLOAD_SOURCE'; requestId: string; documentKey: string; resolution: DownloadResolution }
  | { type: 'DOWNLOAD_STARTED'; downloadId: number }
  | { type: 'DOWNLOAD_STATUS'; attempt: DownloadAttempt | null }
  | { type: 'DOWNLOAD_KEEPALIVE'; requestId: string; isActive: boolean }
  | { type: 'DOWNLOAD_UNAVAILABLE'; reason: Extract<DownloadResolution, { status: 'unavailable' }>['reason']; request?: HlsRequestFailure }
  | { type: 'PLAYER_STATE'; sources: PlayerSnapshot[]; diagnostics: DiagnosticsRecord[]; activeTabId: number | null }
  | { type: 'ERROR'; message: string };
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function isDocumentKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function isPlaybackState(value: unknown): value is PlaybackState { return value === 'none' || value === 'playing' || value === 'paused'; }
export function isPlayerError(value: unknown): value is PlayerError { return value === null || value === 'media-session-unavailable' || value === 'bridge-unavailable' || value === 'metadata-read-failed'; }
export function isDownloadProgress(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100; }
export function isPlayerSnapshot(value: unknown): value is PlayerSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return hasExactKeys(item, ['tabId', 'track', 'playbackState', 'updatedAt', 'connection', 'error'])
    && Number.isInteger(item.tabId) && Number(item.tabId) >= 0 && (item.track === null || isTrack(item.track)) && isPlaybackState(item.playbackState)
    && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
    && (item.connection === 'connected' || item.connection === 'waiting' || item.connection === 'error') && isPlayerError(item.error);
}
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case 'PING': case 'GET_PLAYER_STATE': case 'GET_DOCUMENT_KEY': case 'REFRESH_PLAYER': return hasExactKeys(item, ['type']);
    case 'TRACK_UPDATE': return hasExactKeys(item, ['type', 'documentKey', 'track', 'playbackState', 'error']) && isDocumentKey(item.documentKey)
      && (item.track === null || isTrack(item.track)) && isPlaybackState(item.playbackState) && isPlayerError(item.error);
    case 'DIAGNOSTICS_REPORT': return hasExactKeys(item, ['type', 'documentKey', 'report']) && isDocumentKey(item.documentKey) && isAudioDiagnostics(item.report);
    case 'DOWNLOAD_TRACK': return hasExactKeys(item, ['type', 'tabId', 'track']) && Number.isInteger(item.tabId) && Number(item.tabId) >= 0 && isTrack(item.track);
    case 'GET_DOWNLOAD_STATUS': return hasExactKeys(item, ['type', 'tabId']) && Number.isInteger(item.tabId) && Number(item.tabId) >= 0;
    case 'RESOLVE_DOWNLOAD': return hasExactKeys(item, ['type', 'requestId', 'track']) && isDocumentKey(item.requestId) && isTrack(item.track);
    case 'RELEASE_DOWNLOAD': return hasExactKeys(item, ['type', 'requestId']) && isDocumentKey(item.requestId);
    case 'DOWNLOAD_PROGRESS': return hasExactKeys(item, ['type', 'requestId', 'documentKey', 'progress']) && isDocumentKey(item.requestId) && isDocumentKey(item.documentKey) && isDownloadProgress(item.progress);
    case 'DOWNLOAD_PROGRESS_UPDATE': return hasExactKeys(item, ['type', 'tabId', 'track', 'progress']) && Number.isInteger(item.tabId) && Number(item.tabId) >= 0 && isTrack(item.track) && isDownloadProgress(item.progress);
    case 'SET_DIAGNOSTICS': return hasExactKeys(item, ['type', 'tabId', 'isEnabled']) && Number.isInteger(item.tabId) && Number(item.tabId) >= 0 && typeof item.isEnabled === 'boolean';
    case 'SET_BRIDGE_DIAGNOSTICS': return hasExactKeys(item, ['type', 'isEnabled']) && typeof item.isEnabled === 'boolean';
    default: return false;
  }
}
export function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case 'PONG': return hasExactKeys(item, ['type']);
    case 'ACK': return hasExactKeys(item, ['type', 'isDiagnosticsEnabled']) && typeof item.isDiagnosticsEnabled === 'boolean';
    case 'DOCUMENT_KEY': return hasExactKeys(item, ['type', 'documentKey']) && isDocumentKey(item.documentKey);
    case 'DOWNLOAD_SOURCE': return hasExactKeys(item, ['type', 'requestId', 'documentKey', 'resolution']) && isDocumentKey(item.requestId) && isDocumentKey(item.documentKey) && isDownloadResolution(item.resolution);
    case 'DOWNLOAD_STARTED': return hasExactKeys(item, ['type', 'downloadId']) && Number.isInteger(item.downloadId) && Number(item.downloadId) >= 0;
    case 'DOWNLOAD_STATUS': return hasExactKeys(item, ['type', 'attempt']) && (item.attempt === null || isDownloadAttempt(item.attempt));
    case 'DOWNLOAD_KEEPALIVE': return hasExactKeys(item, ['type', 'requestId', 'isActive']) && isDocumentKey(item.requestId) && typeof item.isActive === 'boolean';
    case 'DOWNLOAD_UNAVAILABLE': {
      const hasRequest = Object.hasOwn(item, 'request');
      return hasExactKeys(item, hasRequest ? ['type', 'reason', 'request'] : ['type', 'reason'])
        && isDownloadResolution({ status: 'unavailable', reason: item.reason, ...(hasRequest ? { request: item.request } : {}) });
    }
    case 'ERROR': return hasExactKeys(item, ['type', 'message']) && typeof item.message === 'string';
    case 'PLAYER_STATE': return hasExactKeys(item, ['type', 'sources', 'diagnostics', 'activeTabId']) && Array.isArray(item.sources) && item.sources.every(isPlayerSnapshot)
      && Array.isArray(item.diagnostics) && item.diagnostics.every(isDiagnosticsRecord)
      && (item.activeTabId === null || (Number.isInteger(item.activeTabId) && Number(item.activeTabId) >= 0));
    default: return false;
  }
}
