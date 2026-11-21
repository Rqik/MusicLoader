import { isTrack } from '../../player/lib/metadata';
import type { Track } from '../../../shared/types/track';
import { isDownloadResolution, type DownloadUnavailableReason } from './direct-download';
import { isHlsRequestFailure, type HlsRequestFailure } from './hls-request';

export const DOWNLOAD_ATTEMPT_PREFIX = 'download.attempt.';

export interface DownloadAttempt {
  tabId: number;
  requestId: string;
  track: Track;
  phase: 'checking' | 'preparing' | 'starting' | 'started' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  reason: DownloadUnavailableReason | 'native-start-failed' | 'native-download-failed' | null;
  nativeError: string | null;
  downloadId: number | null;
  updatedAt: number;
  request?: HlsRequestFailure;
}

const fields = ['tabId', 'requestId', 'track', 'phase', 'progress', 'reason', 'nativeError', 'downloadId', 'updatedAt'];
const phases: readonly DownloadAttempt['phase'][] = ['checking', 'preparing', 'starting', 'started', 'complete', 'failed', 'cancelled'];

/** Persist only public metadata and bounded status codes, never media URLs or raw errors. */
export function isDownloadAttempt(value: unknown): value is DownloadAttempt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const hasRequest = Object.hasOwn(item, 'request');
  return Reflect.ownKeys(item).length === fields.length + (hasRequest ? 1 : 0) && fields.every((field) => Object.hasOwn(item, field))
    && (!hasRequest || isHlsRequestFailure(item.request))
    && Number.isInteger(item.tabId) && Number(item.tabId) >= 0
    && typeof item.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.requestId)
    && isTrack(item.track) && Reflect.ownKeys(item.track).length === 6
    && phases.some((phase) => phase === item.phase)
    && Number.isInteger(item.progress) && Number(item.progress) >= 0 && Number(item.progress) <= 100
    && (item.reason === null || item.reason === 'native-start-failed' || item.reason === 'native-download-failed'
      || isDownloadResolution({ status: 'unavailable', reason: item.reason }))
    && (item.nativeError === null || typeof item.nativeError === 'string' && /^[A-Z_]{1,64}$/.test(item.nativeError))
    && (item.downloadId === null || Number.isInteger(item.downloadId) && Number(item.downloadId) >= 0)
    && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) && item.updatedAt >= 0;
}
