/* Paste this entire file into DevTools Console on https://zvuk.com/.
 * It only observes public Web APIs. No requests, downloads or browser API hooks.
 * Report: musicLoaderDiagnostics.report(); Stop: musicLoaderDiagnostics.stop();
 * Copy explicitly: await musicLoaderDiagnostics.copy();
 */
(() => {
  'use strict';

  if (location.protocol !== 'https:' || !(location.hostname === 'zvuk.com' || location.hostname.endsWith('.zvuk.com'))) {
    console.info('MusicLoader: откройте HTTPS-страницу Звука и запустите скрипт в её Console.');
    return;
  }
  try {
    if (typeof window.musicLoaderDiagnostics?.stop === 'function') window.musicLoaderDiagnostics.stop();
  } catch { /* Не используем чужой объект и не выводим его ошибки. */ }

  const limits = { durationSeconds: 60, resourcesPerBatch: 500, resourcesTotal: 10000, resourceBuckets: 64, mediaElements: 10, queryParameters: 100 };
  const mimeFormats = new Map([
    ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['audio/aac', 'aac'], ['audio/aacp', 'aac'],
    ['audio/flac', 'flac'], ['audio/x-flac', 'flac'], ['audio/ogg', 'ogg'], ['application/ogg', 'ogg'],
    ['audio/opus', 'opus'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'],
    ['audio/mp4', 'mp4'], ['video/mp4', 'mp4'], ['audio/webm', null], ['video/webm', null], ['video/mp2t', null],
    ['application/vnd.apple.mpegurl', null], ['application/x-mpegurl', null], ['audio/mpegurl', null],
    ['audio/x-mpegurl', null], ['application/dash+xml', null], ['application/octet-stream', null],
  ]);
  const extensionFormats = new Map([
    ['mp3', 'mp3'], ['aac', 'aac'], ['flac', 'flac'], ['ogg', 'ogg'], ['opus', 'opus'], ['wav', 'wav'], ['m4a', 'mp4'], ['mp4', 'mp4'],
  ]);
  const knownExtensions = new Set([...extensionFormats.keys(), 'webm', 'm3u8', 'mpd', 'm4s', 'ts']);
  const hlsMimeTypes = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);
  const allowedInitiators = new Set(['audio', 'video', 'fetch', 'xmlhttprequest']);
  const resources = new Map();
  let observer = null;
  let timer;
  let isRunning = true;
  let observedResources = 0;
  let audioCandidates = 0;
  let omittedResourceBuckets = 0;
  let encryptedEvents = 0;
  let stoppedReport = null;
  const startedAt = new Date().toISOString();

  function publicText(value) {
    if (typeof value !== 'string') return null;
    const text = value.slice(0, 2048).replace(/(?:https?:\/\/|blob:|data:|javascript:)\S+/gi, '[URL removed]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 512) : null;
  }
  function safeHostname(value) {
    if (typeof value !== 'string' || value.length > 253 || !value.includes('.') || /^[\d.]+$/.test(value)) return null;
    const hostname = value.toLowerCase().replace(/\.$/, '');
    return hostname.split('.').every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ? hostname : null;
  }
  function safeMime(value) {
    if (typeof value !== 'string' || value.length > 256) return null;
    const mime = value.split(';', 1)[0].trim().toLowerCase();
    return mimeFormats.has(mime) ? mime : null;
  }
  function summarizeResource(value, observedMime, initiator = 'other') {
    if (typeof value !== 'string' || !value || value.length > 32768) return null;
    let url;
    try { url = new URL(value, location.href); } catch { return null; }
    if (!['https:', 'http:', 'blob:'].includes(url.protocol)) return null;
    const isBlob = url.protocol === 'blob:';
    let hostname = safeHostname(url.hostname);
    if (isBlob) {
      try { hostname = safeHostname(new URL(url.pathname).hostname); } catch { hostname = null; }
    }
    const rawExtension = isBlob ? '' : url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
    const extension = knownExtensions.has(rawExtension) ? rawExtension : null;
    const mimeType = safeMime(observedMime);
    const format = (mimeType ? mimeFormats.get(mimeType) : null) ?? extensionFormats.get(extension) ?? null;
    let delivery = 'unknown';
    if (isBlob) delivery = 'blob';
    else if (extension === 'm3u8' || hlsMimeTypes.has(mimeType)) delivery = 'hls-manifest';
    else if (extension === 'mpd' || mimeType === 'application/dash+xml') delivery = 'dash-manifest';
    else if (extension === 'm4s' || mimeType === 'video/mp2t' || (extension === 'ts' && (initiator === 'audio' || initiator === 'video'))) delivery = 'segment';
    else if (format || mimeType?.startsWith('audio/') || mimeType?.startsWith('video/')) delivery = 'file-like-resource';
    let queryParameterCount = 0;
    for (const _ of url.searchParams) {
      queryParameterCount += 1;
      if (queryParameterCount >= limits.queryParameters) break;
    }
    return {
      hostname, protocol: url.protocol, extension,
      basenameKind: isBlob ? 'opaque-blob' : extension ? 'known-media-extension' : 'extensionless-or-unrecognized',
      hasQuery: Boolean(url.search), queryParameterCount, format, mimeType, delivery,
      initiator: allowedInitiators.has(initiator) ? initiator : 'other',
    };
  }
  function collectResources(entries) {
    if (!isRunning) return;
    for (const entry of entries.slice(-limits.resourcesPerBatch)) {
      if (observedResources >= limits.resourcesTotal) break;
      observedResources += 1;
      const hints = summarizeResource(entry.name, entry.contentType, entry.initiatorType);
      if (!hints) continue;
      const hasAudioHint = hints.delivery !== 'unknown';
      if (!hasAudioHint && !allowedInitiators.has(hints.initiator)) continue;
      if (hasAudioHint) audioCandidates = Math.min(limits.resourcesTotal, audioCandidates + 1);
      // Ключ содержит только разрешённые признаки: адреса и значения query здесь не остаются.
      const key = JSON.stringify(hints);
      const previous = resources.get(key);
      if (previous) previous.count = Math.min(limits.resourcesTotal, previous.count + 1);
      else if (resources.size < limits.resourceBuckets) resources.set(key, { ...hints, count: 1 });
      else omittedResourceBuckets = Math.min(limits.resourcesTotal, omittedResourceBuckets + 1);
    }
  }
  function readMetadata() {
    try {
      const session = navigator.mediaSession;
      const metadata = session?.metadata;
      const state = session?.playbackState;
      return {
        title: publicText(metadata?.title), artist: publicText(metadata?.artist), album: publicText(metadata?.album),
        playbackState: state === 'playing' || state === 'paused' ? state : 'none',
      };
    } catch { return { title: null, artist: null, album: null, playbackState: 'unknown' }; }
  }
  function readMedia() {
    const media = [];
    for (const element of Array.from(document.querySelectorAll('audio,video')).slice(0, limits.mediaElements)) {
      try {
        const currentSrc = element.currentSrc || '';
        const configuredSrc = currentSrc ? '' : element.src || '';
        const srcObject = element.srcObject;
        let srcObjectKind = 'none';
        if (srcObject) {
          srcObjectKind = 'unknown';
          if (typeof window.MediaStream === 'function' && srcObject instanceof window.MediaStream) srcObjectKind = 'media-stream';
          else if (typeof window.MediaSource === 'function' && srcObject instanceof window.MediaSource) srcObjectKind = 'media-source';
          else if (typeof window.MediaSourceHandle === 'function' && srcObject instanceof window.MediaSourceHandle) srcObjectKind = 'media-source-handle';
        }
        const selectedSource = currentSrc ? Array.from(element.querySelectorAll('source')).find((source) => source.src === currentSrc) : null;
        const declaredMimeType = safeMime(selectedSource?.type);
        media.push({
          element: element.localName === 'audio' ? 'audio' : 'video',
          sourceSelection: currentSrc ? 'currentSrc' : configuredSrc ? 'configured-src-not-confirmed-playing' : 'none',
          srcObjectKind, hasMediaKeys: Boolean(element.mediaKeys),
          resource: summarizeResource(currentSrc || configuredSrc, declaredMimeType, element.localName),
          declaredMimeType,
        });
      } catch {
        media.push({ element: element.localName === 'audio' ? 'audio' : 'video', sourceSelection: 'unavailable', srcObjectKind: 'unknown', hasMediaKeys: false, resource: null, declaredMimeType: null });
      }
    }
    return media;
  }
  function buildReport() {
    const media = readMedia();
    const hasMediaKeys = media.some((item) => item.hasMediaKeys);
    return {
      version: 1, startedAt, reportedAt: new Date().toISOString(), isRunning,
      page: { hostname: safeHostname(location.hostname), protocol: location.protocol },
      metadata: readMetadata(), media,
      network: { observedResources, audioCandidates, omittedResourceBuckets, resources: [...resources.values()].map((item) => ({ ...item })) },
      deliveryAssessment: media.some((item) => item.srcObjectKind === 'media-source' || item.srcObjectKind === 'media-source-handle')
        ? 'media-source-object-observed' : media.some((item) => item.resource?.delivery === 'blob') ? 'blob-observed-mse-unknown'
          : [...resources.values()].some((item) => item.delivery === 'hls-manifest') ? 'hls-playlist-observed-current-track-unconfirmed' : 'inspect-resource-hints',
      drm: { hasMediaKeys, hasEncryptedEvent: encryptedEvents > 0, encryptedEvents, assessment: hasMediaKeys || encryptedEvents > 0 ? 'eme-indicators-observed' : 'unknown' },
      quality: { status: 'unknown', bitrate: null, sampleRate: null, bitDepth: null },
      limits: { ...limits },
      limitations: [
        'Расширения файлов и MIME дают признаки формата; содержимое аудио не проверяется.',
        'blob: не доказывает MSE. Без EME-признаков отсутствие DRM не подтверждено.',
        'MIME может быть недоступен; source.type является декларацией страницы.',
        'Отсоединённые media-элементы и события до запуска могут быть недоступны.',
        'Наличие ресурса не подтверждает возможность или разрешение на его скачивание.',
        'MP4 в HLS может быть начальным фрагментом; целая композиция и её кодек не подтверждены.',
      ],
    };
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function report() { return clone(stoppedReport ?? buildReport()); }
  function handleEncrypted(event) {
    if (isRunning && (event.target?.localName === 'audio' || event.target?.localName === 'video')) encryptedEvents = Math.min(limits.resourcesTotal, encryptedEvents + 1);
  }
  function stop() {
    if (!isRunning) return report();
    isRunning = false;
    window.clearTimeout(timer);
    observer?.disconnect();
    document.removeEventListener('encrypted', handleEncrypted, true);
    window.removeEventListener('pagehide', stop);
    stoppedReport = buildReport();
    console.log(JSON.stringify(stoppedReport, null, 2));
    return report();
  }
  async function copyReport() {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error('Clipboard недоступен. В DevTools выполните copy(JSON.stringify(musicLoaderDiagnostics.report(), null, 2)).');
    }
    await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
    console.info('MusicLoader: обезличенный JSON-отчёт скопирован.');
  }

  document.addEventListener('encrypted', handleEncrypted, { capture: true, passive: true });
  window.addEventListener('pagehide', stop, { once: true });
  try {
    if (typeof PerformanceObserver === 'function') {
      observer = new PerformanceObserver((entries) => collectResources(entries.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch { observer?.disconnect(); observer = null; }
  if (!observer) {
    try { collectResources(performance.getEntriesByType('resource')); } catch { /* API может быть недоступен. */ }
  }
  timer = window.setTimeout(stop, limits.durationSeconds * 1000);
  try { window.musicLoaderDiagnostics = Object.freeze({ report, stop, copy: copyReport }); } catch { stop(); return; }
  console.info('MusicLoader: диагностика включена на 60 секунд. report() — отчёт, stop() — завершить, copy() — скопировать JSON; методы доступны через musicLoaderDiagnostics.');
  console.log(JSON.stringify(report(), null, 2));
})();
