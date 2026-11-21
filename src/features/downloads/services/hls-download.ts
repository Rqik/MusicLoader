import {
  HlsDownloadError, decryptHlsBytes, deriveHlsIv, parseHlsManifest, resolveHlsKeyUrl, resolveHlsUrl,
  validateMp4Fragment, validateMp4Init,
  type HlsEncryption, type HlsManifest, type HlsVariant,
} from '../lib/hls';
import { createHlsResourceReader, maxHlsDownloadBytes, type HlsTransportOptions } from './hls-resource-reader';

const maxCandidates = 8;
const maxKeys = 16;
type MediaPlaylist = Extract<HlsManifest, { kind: 'media' }>;

function isCompleteClearMedia(manifest: HlsManifest | undefined, duration: number): manifest is MediaPlaylist {
  // Allow small rounding differences between renditions and skip shorter previews.
  return manifest?.kind === 'media' && Math.abs(manifest.duration - duration) <= 1
    && manifest.init.encryption.method === 'none' && manifest.segments.every((segment) => segment.encryption.method === 'none');
}

/** Called only by the explicit download action; never observes or starts playback. */
export async function downloadHlsTrack(
  candidateUrls: readonly string[],
  trackId: string,
  signal: AbortSignal,
  onProgress: (value: number) => void,
  transport?: HlsTransportOptions,
): Promise<Blob> {
  const operation = new AbortController();
  const readResource = createHlsResourceReader(trackId, operation.signal, transport);
  const keys = new Map<string, Promise<CryptoKey>>();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let lastProgress = -1;

  function cancel() { operation.abort(); }
  function checkCancelled() {
    if (signal.aborted || operation.signal.aborted) throw new HlsDownloadError('hls-cancelled');
  }
  function progress(value: number) {
    checkCancelled();
    const next = Math.min(99, Math.max(0, Math.floor(value)));
    if (next <= lastProgress) return;
    lastProgress = next;
    onProgress(next);
  }
  signal.addEventListener('abort', cancel, { once: true });

  async function readManifest(url: string): Promise<HlsManifest> {
    const { bytes } = await readResource(url, 'manifest');
    checkCancelled();
    return parseHlsManifest(new TextDecoder('utf-8').decode(bytes), url);
  }
  async function findClearVariant(
    variants: readonly HlsVariant[], observed: ReadonlyMap<string, HlsManifest>, duration: number,
    masterUrl: string, trackPath: RegExp,
  ) {
    for (const variant of variants) {
      const media = observed.get(variant.url);
      if (isCompleteClearMedia(media, duration)) return { variant, media };
    }

    // Only probe listed public playlist URLs in this track's master directory.
    const directory = new URL('.', masterUrl).pathname;
    const inspected = new Set<string>();
    for (const variant of variants) {
      if (observed.has(variant.url) || inspected.has(variant.url)) continue;
      const pathname = new URL(variant.url).pathname;
      if (!pathname.startsWith(directory) || !trackPath.test(pathname) || !/\.m3u8$/i.test(pathname)) continue;
      if (inspected.size >= maxCandidates) break;
      inspected.add(variant.url);
      try {
        const media = await readManifest(variant.url);
        if (isCompleteClearMedia(media, duration)) return { variant, media };
      } catch (error) {
        checkCancelled();
        if (error instanceof HlsDownloadError && error.code === 'hls-too-large') throw error;
      }
    }
    return null;
  }
  async function concurrent<T, R>(values: readonly T[], action: (value: T, index: number) => Promise<R>): Promise<R[]> {
    const result: R[] = new Array(values.length);
    let index = 0;
    let firstFailure: unknown;
    async function work() {
      while (index < values.length && !operation.signal.aborted) {
        const current = index++;
        try {
          checkCancelled();
          result[current] = await action(values[current]!, current);
        } catch (error) {
          if (firstFailure === undefined) firstFailure = error;
          operation.abort();
          return;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, values.length) }, work));
    if (firstFailure !== undefined) throw firstFailure;
    checkCancelled();
    return result;
  }
  async function getKey(url: string): Promise<CryptoKey> {
    const safeUrl = resolveHlsKeyUrl(url, undefined, trackId);
    const cached = keys.get(safeUrl);
    if (cached) return cached;
    if (keys.size >= maxKeys) throw new HlsDownloadError('hls-unsupported');
    const pending = (async () => {
      const { bytes, httpStatus } = await readResource(safeUrl, 'key');
      try {
        if (bytes.byteLength !== 16) {
          throw new HlsDownloadError('hls-invalid-data', { resource: 'key', kind: 'invalid-data', httpStatus });
        }
        checkCancelled();
        return await crypto.subtle.importKey('raw', bytes, { name: 'AES-CBC' }, false, ['decrypt']);
      } finally { bytes.fill(0); }
    })();
    keys.set(safeUrl, pending);
    return pending;
  }
  async function readPart(url: string, encryption: HlsEncryption, resource: 'init' | 'segment', sequence?: bigint): Promise<Uint8Array<ArrayBuffer>> {
    const { bytes, httpStatus } = await readResource(url, resource);
    if (encryption.method === 'none') return bytes;
    const iv = encryption.iv ?? (sequence === undefined ? null : deriveHlsIv(sequence));
    if (!iv) throw new HlsDownloadError('hls-invalid-data');
    const key = await getKey(encryption.url);
    checkCancelled();
    try {
      const clear = await decryptHlsBytes(bytes, key, iv);
      checkCancelled();
      return new Uint8Array(clear);
    } catch (error) {
      if (error instanceof HlsDownloadError && error.code === 'hls-invalid-data') {
        throw new HlsDownloadError(error.code, { resource, kind: 'invalid-data', httpStatus });
      }
      throw error;
    }
  }

  async function readInit(media: MediaPlaylist, variant: HlsVariant) {
    const init = await readPart(media.init.url, media.init.encryption, 'init');
    if (validateMp4Init(init) !== variant.codec) throw new HlsDownloadError('hls-invalid-data');
    return init;
  }

  try {
    checkCancelled();
    if (!/^[0-9]{1,30}$/.test(trackId)) throw new HlsDownloadError('hls-invalid-data');
    progress(0);
    const pattern = new RegExp(`(^|[^0-9])${trackId}(?=$|[^0-9])`);
    const urls = new Set<string>();
    for (const value of candidateUrls) {
      const url = resolveHlsUrl(value);
      const pathname = new URL(url).pathname;
      if (!/\.m3u8$/i.test(pathname) || !pattern.test(pathname)) continue;
      urls.add(url);
      if (urls.size > maxCandidates) throw new HlsDownloadError('hls-ambiguous');
    }
    if (!urls.size) throw new HlsDownloadError('hls-no-source');
    let inspected = 0;
    const manifests = await concurrent([...urls], async (url) => {
      const manifest = await readManifest(url);
      inspected += 1;
      progress(2 + inspected / urls.size * 10);
      return { url, manifest };
    });
    const masters = manifests.filter((entry) => entry.manifest.kind === 'master');
    if (masters.length > 1) throw new HlsDownloadError('hls-ambiguous');
    const masterEntry = masters[0];
    if (!masterEntry || masterEntry.manifest.kind !== 'master') throw new HlsDownloadError('hls-no-source');
    const master = masterEntry.manifest;
    const variants = [...master.variants].sort((left, right) => {
      if (left.codec !== right.codec) return left.codec === 'aac' ? -1 : 1;
      return right.bandwidth - left.bandwidth || left.url.localeCompare(right.url);
    });
    const [selected, ...alternatives] = variants;
    if (!selected) throw new HlsDownloadError('hls-unsupported');
    const observed = new Map(manifests.map(({ url, manifest }) => [url, manifest]));
    const selectedMedia = observed.get(selected.url) ?? await readManifest(selected.url);
    if (selectedMedia.kind !== 'media') throw new HlsDownloadError('hls-unsupported');
    let media = selectedMedia;
    progress(15);
    const encryptionKeys = new Set<string>();
    for (const part of [media.init, ...media.segments]) {
      if (part.encryption.method === 'aes-128') encryptionKeys.add(resolveHlsKeyUrl(part.encryption.url, undefined, trackId));
      if (encryptionKeys.size > maxKeys) throw new HlsDownloadError('hls-unsupported');
    }
    try {
      parts.push(await readInit(media, selected));
    } catch (error) {
      if (!(error instanceof HlsDownloadError) || error.request?.resource !== 'key') throw error;
      const canUseClearVariant = error.code === 'hls-wrapped-key'
        || (error.request.kind === 'http' && error.request.httpStatus === 400);
      if (!canUseClearVariant) throw error;
      const alternative = await findClearVariant(alternatives, observed, media.duration, masterEntry.url, pattern);
      if (!alternative) throw error;
      media = alternative.media;
      parts.push(await readInit(media, alternative.variant));
    }
    progress(20);
    let completedSegments = 0;
    const segments = await concurrent(media.segments, async (segment) => {
      const bytes = await readPart(segment.url, segment.encryption, 'segment', segment.sequence);
      validateMp4Fragment(bytes);
      completedSegments += 1;
      progress(20 + completedSegments / media.segments.length * 79);
      return bytes;
    });
    parts.push(...segments);
    checkCancelled();
    const blob = new Blob(parts, { type: 'audio/mp4' });
    if (blob.size > maxHlsDownloadBytes) throw new HlsDownloadError('hls-too-large');
    progress(99);
    return blob;
  } catch (error) {
    operation.abort();
    if (error instanceof HlsDownloadError) throw error;
    if (signal.aborted) throw new HlsDownloadError('hls-cancelled');
    throw new HlsDownloadError('hls-request-failed');
  } finally {
    signal.removeEventListener('abort', cancel);
    keys.clear();
    parts.length = 0;
  }
}
