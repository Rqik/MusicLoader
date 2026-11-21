import type { AudioDiagnostics } from './types';
import { isHlsDiscovery } from '../downloads/lib/hls-discovery';
export interface DiagnosticsRecord { tabId: number; isEnabled: boolean; report: AudioDiagnostics | null; updatedAt: number }
const formats = ['mp3', 'aac', 'flac', 'ogg', 'opus', 'wav', 'mp4'];
const delivery = ['file', 'hls', 'dash', 'segments', 'blob'];
const mimeTypes = ['audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/aacp', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'application/ogg', 'audio/opus', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mp4', 'video/mp4', 'audio/webm', 'video/webm', 'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl', 'application/dash+xml', 'application/octet-stream', 'video/mp2t'];
function isEnumArray(value: unknown, allowed: string[]) {
  return Array.isArray(value) && value.length <= allowed.length && value.every((entry) => typeof entry === 'string' && allowed.includes(entry)) && new Set(value).size === value.length;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function isAudioDiagnostics(value: unknown): value is AudioDiagnostics {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const fields = ['delivery', 'formats', 'hasEncryptedEvent', 'hasMediaKeys', 'mimeTypes', 'quality', 'resourceCount'];
  const hasDiscovery = Object.hasOwn(item, 'hlsDiscovery');
  return hasExactKeys(item, hasDiscovery ? [...fields, 'hlsDiscovery'] : fields)
    && (!hasDiscovery || isHlsDiscovery(item.hlsDiscovery))
    && isEnumArray(item.formats, formats) && isEnumArray(item.delivery, delivery) && isEnumArray(item.mimeTypes, mimeTypes)
    && typeof item.hasMediaKeys === 'boolean' && typeof item.hasEncryptedEvent === 'boolean' && item.quality === null
    && typeof item.resourceCount === 'number' && Number.isInteger(item.resourceCount) && item.resourceCount >= 0 && item.resourceCount <= 10_000;
}
export function isDiagnosticsRecord(value: unknown): value is DiagnosticsRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return hasExactKeys(item, ['tabId', 'isEnabled', 'report', 'updatedAt']) && Number.isInteger(item.tabId) && Number(item.tabId) >= 0 && typeof item.isEnabled === 'boolean'
    && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) && (item.report === null || isAudioDiagnostics(item.report));
}
