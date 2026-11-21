import type { AudioDelivery, AudioDiagnostics, AudioFormat, ResourceHints } from './types';

const mimeFormats = new Map<string, AudioFormat | null>([
  ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'],
  ['audio/aac', 'aac'], ['audio/aacp', 'aac'],
  ['audio/flac', 'flac'], ['audio/x-flac', 'flac'],
  ['audio/ogg', 'ogg'], ['application/ogg', 'ogg'], ['audio/opus', 'opus'],
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'],
  ['audio/mp4', 'mp4'], ['video/mp4', 'mp4'],
  ['audio/webm', null], ['video/webm', null], ['video/mp2t', null],
  ['application/vnd.apple.mpegurl', null], ['application/x-mpegurl', null],
  ['audio/mpegurl', null], ['audio/x-mpegurl', null],
  ['application/dash+xml', null], ['application/octet-stream', null],
]);

const extensionFormats = new Map<string, AudioFormat>([
  ['mp3', 'mp3'], ['aac', 'aac'], ['flac', 'flac'], ['ogg', 'ogg'],
  ['opus', 'opus'], ['wav', 'wav'], ['m4a', 'mp4'], ['mp4', 'mp4'],
]);
const hlsMimeTypes = new Set([
  'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl',
]);
const maxResourcesPerBatch = 500;
const maxResourceCount = 10_000;
const maxMediaElements = 10;

/** Resource history confirms the presence of HLS, not its association with the current song. */
export function hasObservedZvukHls(entries: readonly Pick<PerformanceEntry, 'name'>[]): boolean {
  return entries.slice(-maxResourcesPerBatch).some((entry) => {
    try {
      const url = new URL(entry.name);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname === 'zvuk.com' || url.hostname.endsWith('.zvuk.com')) && /\.m3u8$/i.test(url.pathname);
    } catch { return false; }
  });
}

function normalizeMimeType(value: string | undefined): string | null {
  if (!value || value.length > 256) return null;
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  // Неизвестные MIME не сохраняются: произвольное значение может содержать секрет.
  return mimeFormats.has(mimeType) ? mimeType : null;
}

export function summarizeAudioResource(resourceUrl: string, observedMimeType?: string): ResourceHints {
  const empty: ResourceHints = { format: null, delivery: null, mimeType: null };
  let url: URL;
  try { url = new URL(resourceUrl); } catch { return empty; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'blob:') return empty;

  const mimeType = normalizeMimeType(observedMimeType);
  const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
  const format = (mimeType ? mimeFormats.get(mimeType) : null) ?? extensionFormats.get(extension) ?? null;
  let delivery: AudioDelivery | null = null;
  if (url.protocol === 'blob:') delivery = 'blob';
  else if (extension === 'm3u8' || (mimeType !== null && hlsMimeTypes.has(mimeType))) delivery = 'hls';
  else if (extension === 'mpd' || mimeType === 'application/dash+xml') delivery = 'dash';
  else if (extension === 'm4s' || mimeType === 'video/mp2t') delivery = 'segments';
  else if (format !== null || mimeType?.startsWith('audio/') || mimeType?.startsWith('video/')) delivery = 'file';
  return { format, delivery, mimeType };
}

/** Создавать только после явного включения диагностики пользователем. */
export function createAudioDiagnostics(): { read: () => AudioDiagnostics; dispose: () => void } {
  const formats = new Set<AudioFormat>();
  const delivery = new Set<AudioDelivery>();
  const mimeTypes = new Set<string>();
  const mediaListeners = new Map<HTMLMediaElement, EventListener>();
  let observer: PerformanceObserver | null = null;
  let hasMediaKeys = false;
  let hasEncryptedEvent = false;
  let resourceCount = 0;
  let isDisposed = false;

  function collect(hints: ResourceHints) {
    if (hints.format) formats.add(hints.format);
    if (hints.delivery) delivery.add(hints.delivery);
    if (hints.mimeType) mimeTypes.add(hints.mimeType);
  }

  function collectResourceEntries(entries: PerformanceEntry[]) {
    if (isDisposed) return;
    for (const entry of entries.slice(-maxResourcesPerBatch)) {
      const observedMimeType = 'contentType' in entry && typeof entry.contentType === 'string' ? entry.contentType : undefined;
      const hints = summarizeAudioResource(entry.name, observedMimeType);
      if (hints.format === null && hints.delivery === null) continue;
      collect(hints);
      resourceCount = Math.min(maxResourceCount, resourceCount + 1);
    }
  }

  try {
    if (typeof PerformanceObserver !== 'undefined') {
      observer = new PerformanceObserver((entries) => collectResourceEntries(entries.getEntries()));
      // buffered даёт уже наблюдавшиеся ресурсы без второго подсчёта через getEntriesByType.
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch {
    observer?.disconnect();
    observer = null;
  }
  if (!observer) collectResourceEntries(performance.getEntriesByType('resource'));

  function inspectMediaElements() {
    const elements = Array.from(document.querySelectorAll<HTMLMediaElement>('audio,video')).slice(0, maxMediaElements);
    const currentElements = new Set(elements);
    for (const [element, listener] of mediaListeners) {
      if (currentElements.has(element)) continue;
      element.removeEventListener('encrypted', listener);
      mediaListeners.delete(element);
    }
    for (const element of elements) {
      if (!mediaListeners.has(element)) {
        const handleEncrypted: EventListener = () => { hasEncryptedEvent = true; };
        element.addEventListener('encrypted', handleEncrypted, { passive: true });
        mediaListeners.set(element, handleEncrypted);
      }
      hasMediaKeys ||= Boolean(element.mediaKeys);
      const currentSrc = element.currentSrc;
      if (!currentSrc) continue;
      const source = Array.from(element.querySelectorAll('source')).find((item) => item.src === currentSrc);
      collect(summarizeAudioResource(currentSrc, source?.type));
    }
  }

  return {
    read() {
      if (!isDisposed) inspectMediaElements();
      return {
        formats: [...formats].sort(), delivery: [...delivery].sort(), mimeTypes: [...mimeTypes].sort(),
        hasMediaKeys, hasEncryptedEvent, resourceCount,
        // Ни размер ответа, ни расширение файла не подтверждают битрейт или качество.
        quality: null,
      };
    },
    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      observer?.disconnect();
      for (const [element, listener] of mediaListeners) element.removeEventListener('encrypted', listener);
      mediaListeners.clear();
    },
  };
}
