import type { Track } from '../../../shared/types/track';
import { hlsFailureReasons, type HlsFailure } from './hls';
import { isHlsRequestFailure, type HlsRequestFailure } from './hls-request';

const extensions = ['mp3', 'aac', 'flac', 'ogg', 'opus', 'wav', 'm4a', 'mp4'] as const;
export type DownloadExtension = typeof extensions[number];
export type DownloadUnavailableReason = 'no-track' | 'track-changed' | 'no-source' | 'hls-source' | 'multiple-sources' | 'protected-media'
  | 'stream-source' | 'private-url' | 'unsupported-source' | 'bridge-unavailable' | HlsFailure;

export type DownloadResolution =
  | { status: 'ready'; url: string; extension: DownloadExtension }
  | { status: 'assembled'; url: string; extension: 'm4a' }
  | { status: 'unavailable'; reason: DownloadUnavailableReason; request?: HlsRequestFailure };

const unavailableReasons: readonly DownloadUnavailableReason[] = [
  'no-track', 'track-changed', 'no-source', 'hls-source', 'multiple-sources', 'protected-media',
  'stream-source', 'private-url', 'unsupported-source', 'bridge-unavailable', ...hlsFailureReasons,
];

function inspectUrl(value: string): DownloadResolution {
  if (value.startsWith('blob:') || value.startsWith('data:')) return { status: 'unavailable', reason: 'stream-source' };
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return { status: 'unavailable', reason: 'unsupported-source' };
  // Do not strip signed or private URL components: omitting them would change the resource.
  if (value.includes('?') || value.includes('#')) return { status: 'unavailable', reason: 'private-url' };
  try {
    const url = new URL(value);
    if (url.username || url.password) return { status: 'unavailable', reason: 'private-url' };
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
    const isAllowedHost = authority !== undefined && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*zvuk\.com$/i.test(authority);
    if (url.protocol !== 'https:' || !isAllowedHost || url.port) return { status: 'unavailable', reason: 'unsupported-source' };
    const extension = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (extension && ['m3u', 'm3u8', 'mpd', 'm4s', 'ts', 'ism', 'isml'].includes(extension)) return { status: 'unavailable', reason: 'stream-source' };
    if (!extensions.some((allowed) => allowed === extension)) return { status: 'unavailable', reason: 'unsupported-source' };
    return { status: 'ready', url: url.href, extension: extension as DownloadExtension };
  } catch {
    return { status: 'unavailable', reason: 'unsupported-source' };
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isDownloadResolution(value: unknown): value is DownloadResolution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const resolution = value as Record<string, unknown>;
  if (resolution.status === 'unavailable') {
    const hasRequest = Object.hasOwn(resolution, 'request');
    return hasExactKeys(resolution, hasRequest ? ['status', 'reason', 'request'] : ['status', 'reason'])
      && unavailableReasons.some((reason) => reason === resolution.reason)
      && (!hasRequest || isHlsRequestFailure(resolution.request));
  }
  if (resolution.status === 'assembled') {
    return hasExactKeys(resolution, ['status', 'url', 'extension']) && resolution.extension === 'm4a'
      && typeof resolution.url === 'string'
      && /^blob:https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*zvuk\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resolution.url);
  }
  if (resolution.status !== 'ready' || !hasExactKeys(resolution, ['status', 'url', 'extension']) || typeof resolution.url !== 'string') return false;
  const checked = inspectUrl(resolution.url);
  return checked.status === 'ready' && checked.url === resolution.url && checked.extension === resolution.extension;
}

/** Reads the existing media element without requesting, playing, decoding or rewriting anything. */
export function inspectDownloadSource(document: Document, hasEncrypted: (element: HTMLMediaElement) => boolean): DownloadResolution {
  try {
    const candidates = Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'))
      .filter((element) => Boolean(element.currentSrc) || element.srcObject !== null && element.srcObject !== undefined);
    if (candidates.length === 0) return { status: 'unavailable', reason: 'no-source' };
    if (candidates.length !== 1) return { status: 'unavailable', reason: 'multiple-sources' };
    const media = candidates[0];
    if (!media) return { status: 'unavailable', reason: 'no-source' };
    if (media.mediaKeys || hasEncrypted(media)) return { status: 'unavailable', reason: 'protected-media' };
    if (media.srcObject) return { status: 'unavailable', reason: 'stream-source' };
    return inspectUrl(media.currentSrc);
  } catch {
    // A page can replace DOM accessors. Fail closed rather than attempting another source.
    return { status: 'unavailable', reason: 'unsupported-source' };
  }
}

function filenamePart(value: string, fallback: string): string {
  const normalized = value.normalize('NFKC')
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  // Bound UTF-16 length as Windows does, without cutting a surrogate pair in half.
  const characters: string[] = [];
  let length = 0;
  for (const character of normalized) {
    if (length + character.length > 80) break;
    characters.push(character);
    length += character.length;
  }
  const part = characters.join('').replace(/[. ]+$/g, '') || fallback;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ? `_${part}` : part;
}

export function createDownloadFilename(track: Track, extension: DownloadExtension): string {
  if (!extensions.includes(extension)) throw new Error('Unsupported download extension');
  const artist = filenamePart(track.artist, 'Неизвестный исполнитель');
  const title = filenamePart(track.title, 'Без названия');
  return `MusicLoader/${artist} - ${title}.${extension}`;
}
