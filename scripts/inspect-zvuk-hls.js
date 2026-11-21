/* MusicLoader HLS inspector v2. Paste explicitly into the Zvuk page's DevTools Console.
 * Discovers resources for 15 s and reads only up to 8 observed unsigned .m3u8 on the
 * exact cdn-hls-slicer.zvuk.com host. No segments, maps, keys or licenses.
 * API: musicLoaderHlsReport.report(), musicLoaderHlsReport.stop().
 */
(() => {
  'use strict';
  if (location.protocol !== 'https:' || !(location.hostname === 'zvuk.com' || location.hostname.endsWith('.zvuk.com'))) {
    console.info('MusicLoader HLS: запустите скрипт на HTTPS-странице Звука.');
    return;
  }
  try { window.musicLoaderHlsReport?.stop?.('replaced'); } catch { /* Чужие ошибки не выводятся. */ }

  const limits = { candidates: 8, historyEntries: 500, observations: 10000, observedHostnames: 8, discoveryWindowMs: 15000, pollingIntervalMs: 1000, concurrentRequests: 2, requestIntervalMs: 300, requestTimeoutMs: 5000, totalTimeoutMs: 30000, manifestBytes: 128 * 1024, lines: 10000, variants: 32, codecsPerVariant: 8 };
  const allowedHost = 'cdn-hls-slicer.zvuk.com';
  const candidates = [];
  const seen = new Set();
  const controllers = new Set();
  const timers = new Set();
  const requestQueue = [];
  let lastRequestStartedAt = null;
  let requestStartTimer;
  const items = [];
  const observedHlsHostnames = new Set();
  const skipped = { host: 0, query: 0, fragment: 0, credentials: 0, port: 0, protocol: 0, extension: 0, malformed: 0, 'candidate-limit': 0 };
  let observer = null;
  let pollingTimer;
  let discoveryTimer;
  let isDiscovering = true;
  let discoveryEndedAt = null;
  let discoveryEndedReason = null;
  let observerMode = 'unavailable';
  let historyEntryCount = 0;
  let historyAvailable = false;
  let historyWasTruncated = false;
  let resourceTimingBufferSize = null;
  let historyAtBufferCapacity = null;
  let observationCount = 0;
  let hlsObservationCount = 0;
  let duplicateCount = 0;
  let activeRequests = 0;
  let completionReason = null;
  let isRunning = true;
  let status = 'discovering';
  let nextIndex = 0;
  let metadataAtEnd = null;
  let metadataStableDuringInspection = null;
  let completedAt = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const startedAt = new Date().toISOString();

  function publicText(value) {
    if (typeof value !== 'string') return null;
    const text = value.slice(0, 2048).replace(/(?:https?:\/\/|blob:|data:|javascript:)\S+/gi, '[URL removed]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 512) : null;
  }
  function readMetadata() {
    try {
      const metadata = navigator.mediaSession?.metadata;
      return { title: publicText(metadata?.title), artist: publicText(metadata?.artist), album: publicText(metadata?.album) };
    } catch { return { title: null, artist: null, album: null }; }
  }
  const metadataAtStart = readMetadata();
  function comparable(value) { return (publicText(value) ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU'); }
  function comparableArtist(value) { return comparable(value).replace(/\s*,\s*/g, ', '); }
  function linkedTrackId(anchor) {
    try {
      const url = new URL(anchor.getAttribute('href') ?? '', location.href);
      const isZvuk = url.hostname === 'zvuk.com' || url.hostname.endsWith('.zvuk.com');
      if (url.protocol !== 'https:' || !isZvuk || url.port || url.username || url.password) return null;
      return /^\/track\/([0-9]{1,30})\/?$/.exec(url.pathname)?.[1] ?? null;
    } catch { return null; }
  }
  function readUniqueTrackId(metadata) {
    const title = comparable(metadata.title);
    const artist = comparableArtist(metadata.artist);
    if (!title || !artist) return null;
    const ids = new Set();
    const artistPattern = new RegExp(`(^|[^\\p{L}\\p{N}])${artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u');
    const links = document.querySelectorAll('a[href]');
    if (links.length > 2000) return null;
    for (const anchor of links) {
      const id = linkedTrackId(anchor);
      if (!id) continue;
      const labels = [anchor.getAttribute('title'), anchor.textContent,
        ...Array.from(anchor.querySelectorAll('[title]')).slice(0, 16).map((element) => element.getAttribute('title'))];
      if (!labels.some((label) => comparable(label) === title)) continue;
      let container = anchor.parentElement;
      for (let depth = 0; depth < 2 && container && container !== document.body && container !== document.documentElement; depth += 1, container = container.parentElement) {
        const nearbyLinks = container.querySelectorAll('a[href]');
        if (nearbyLinks.length > 128) continue;
        const nearbyIds = new Set(Array.from(nearbyLinks).map(linkedTrackId).filter(Boolean));
        if (nearbyIds.size > 1) continue;
        const walker = document.createTreeWalker(container, 4);
        let node = walker.nextNode();
        let artistText = '';
        for (let count = 0; node && count < 128; count += 1, node = walker.nextNode()) {
          if (anchor.contains(node) || node.parentElement?.closest('script,style,noscript,[hidden],[aria-hidden="true"]')) continue;
          artistText += ` ${node.textContent ?? ''}`;
          if (artistText.length > 2048) break;
        }
        if (artistText.length <= 2048 && artistPattern.test(comparableArtist(artistText))) { ids.add(id); break; }
      }
      if (ids.size > 1) return null;
    }
    return ids.size === 1 ? ids.values().next().value : null;
  }
  let uniqueTrackId = null;
  try { uniqueTrackId = readUniqueTrackId(metadataAtStart); } catch { /* Неоднозначность означает отсутствие подтверждённого ID. */ }
  let trackIdentityStableDuringInspection = null;
  function safeHostname(value) {
    if (typeof value !== 'string' || value.length > 253 || !value.includes('.') || /^[\d.]+$/.test(value)) return null;
    const hostname = value.toLowerCase().replace(/\.$/, '');
    return hostname.split('.').every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ? hostname : null;
  }
  function classifyPlaylist(value, contentType) {
    if (typeof value !== 'string' || value.length > 4096) return { url: null, reason: 'malformed', isHls: false, hostname: null };
    try {
      const url = new URL(value);
      const isHls = /\.m3u8$/i.test(url.pathname) || (typeof contentType === 'string' && contentType.length <= 256 && ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(contentType.split(';', 1)[0].trim().toLowerCase()));
      const hostname = safeHostname(url.hostname);
      const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] ?? '';
      let reason = null;
      if (url.protocol !== 'https:') reason = 'protocol';
      else if (url.username || url.password) reason = 'credentials';
      // URL.port скрывает явно заданный стандартный :443, поэтому проверяем authority.
      else if (url.port || /:\d*$/.test(authority)) reason = 'port';
      else if (url.hostname !== allowedHost) reason = 'host';
      else if (url.search || value.includes('?')) reason = 'query';
      else if (url.hash || value.includes('#')) reason = 'fragment';
      else if (!/\.m3u8$/i.test(url.pathname)) reason = 'extension';
      return { url: reason ? null : url.href, reason, isHls, hostname };
    } catch { return { url: null, reason: 'malformed', isHls: false, hostname: null }; }
  }
  function collectEntries(entries, observedVia) {
    if (!isRunning || !isDiscovering) return;
    for (const entry of entries.slice(-limits.historyEntries)) {
      if (observationCount >= limits.observations) break;
      observationCount += 1;
      const candidate = classifyPlaylist(entry.name, entry.contentType);
      if (candidate.isHls) {
        hlsObservationCount += 1;
        if (candidate.hostname && observedHlsHostnames.size < limits.observedHostnames) observedHlsHostnames.add(candidate.hostname);
      }
      if (candidate.reason) { skipped[candidate.reason] += 1; continue; }
      if (seen.has(candidate.url)) { duplicateCount += 1; continue; }
      if (candidates.length >= limits.candidates) { skipped['candidate-limit'] += 1; continue; }
      seen.add(candidate.url);
      const observationStartTime = typeof entry.startTime === 'number' && Number.isFinite(entry.startTime) && entry.startTime >= 0 ? Math.round(entry.startTime * 1000) / 1000 : null;
      const metadataAtObservation = readMetadata();
      let identity = null;
      try { identity = readUniqueTrackId(metadataAtObservation); } catch { /* ID остаётся неподтверждённым. */ }
      candidates.push({ url: candidate.url });
      items.push({
        index: items.length + 1, observationStartTime, observedVia, observedAt: new Date().toISOString(),
        metadataAtObservation, metadataObservationContext: 'at-discovery-time-not-resource-start',
        hasUniqueTrackIdAtObservation: identity !== null, currentPlaylistAssociation: 'unconfirmed',
        matchesCurrentTrackIdInPath: identity ? new RegExp(`(^|[^0-9])${identity}(?=$|[^0-9])`).test(new URL(candidate.url).pathname) : null,
        status: 'not-requested', httpStatus: null, manifest: null,
      });
    }
    pump();
  }
  function readHistory(observedVia) {
    try {
      const entries = performance.getEntriesByType('resource');
      if (observedVia === 'history') {
        historyAvailable = true;
        historyEntryCount = Math.min(limits.observations, entries.length);
        historyWasTruncated = entries.length > limits.historyEntries;
        const bufferSize = performance.resourceTimingBufferSize;
        resourceTimingBufferSize = typeof bufferSize === 'number' && Number.isFinite(bufferSize) && bufferSize > 0 && bufferSize <= 100000 ? bufferSize : null;
        historyAtBufferCapacity = resourceTimingBufferSize === null ? null : entries.length >= resourceTimingBufferSize;
      }
      collectEntries(entries, observedVia);
    } catch { /* Без истории ждём live observer; произвольные адреса не подставляются. */ }
  }

  function boundedCount(value) { return Math.min(limits.lines, value); }
  function boundedInteger(value, max = 1000000000) {
    if (typeof value !== 'string' || !/^[0-9]{1,10}$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= max ? number : null;
  }
  function attributes(line) {
    const result = Object.create(null);
    if (line.length > 4096) return result;
    const allowed = new Set(['BANDWIDTH', 'AVERAGE-BANDWIDTH', 'CODECS', 'METHOD', 'KEYFORMAT', 'TYPE', 'BYTERANGE']);
    let index = 0;
    while (index < line.length) {
      while (line[index] === ',' || line[index] === ' ') index += 1;
      const start = index;
      while (index < line.length && line[index] !== '=' && line[index] !== ',') index += 1;
      if (line[index] !== '=') { index += 1; continue; }
      const key = line.slice(start, index).trim().toUpperCase();
      index += 1;
      const isQuoted = line[index] === '"';
      if (isQuoted) index += 1;
      const valueStart = index;
      while (index < line.length && line[index] !== (isQuoted ? '"' : ',')) index += 1;
      if (allowed.has(key)) result[key] = key === 'BYTERANGE' ? true : line.slice(valueStart, index).trim();
      if (isQuoted && line[index] === '"') index += 1;
      while (index < line.length && line[index] !== ',') index += 1;
    }
    return result;
  }
  function codec(value) {
    const name = value.trim().toLowerCase();
    if (name === 'mp4a.40.2') return 'aac-lc';
    if (name === 'mp4a.40.5') return 'he-aac';
    if (name === 'mp4a.40.29') return 'he-aac-v2';
    if (name === 'mp4a.40.42') return 'xhe-aac';
    if (name === 'flac' || name === 'alac' || name === 'opus') return name;
    if (/^avc[13]\.[0-9a-f]{6}$/.test(name)) return 'avc';
    return 'unknown';
  }
  function keyFormat(value) {
    if (value === undefined || value === 'identity') return 'identity';
    const name = value.toLowerCase();
    if (name === 'com.apple.streamingkeydelivery') return 'fairplay';
    if (name === 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' || name === 'com.widevine' || name === 'com.widevine.alpha') return 'widevine';
    if (name === 'com.microsoft.playready' || name === 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95') return 'playready';
    return 'unknown';
  }
  function parseManifest(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[0]?.trim() !== '#EXTM3U') return null;
    const variants = [];
    const methods = new Set();
    const keyFormats = new Set();
    const mediaTypes = new Set();
    let variantCount = 0;
    let mediaTagCount = 0;
    let segmentCount = 0;
    let declaredDuration = 0;
    let mapCount = 0;
    let byteRangeCount = 0;
    let mapByteRangeCount = 0;
    let discontinuityCount = 0;
    let keyCount = 0;
    let sessionKeyCount = 0;
    let hasEndList = false;
    let declaredPlaylistType = 'unknown';
    for (const original of lines.slice(1, limits.lines + 1)) {
      const line = original.trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        variantCount = boundedCount(variantCount + 1);
        const attrs = attributes(line.slice(18));
        if (variants.length < limits.variants) variants.push({
          declaredBandwidth: boundedInteger(attrs.BANDWIDTH), declaredAverageBandwidth: boundedInteger(attrs['AVERAGE-BANDWIDTH']),
          codecs: typeof attrs.CODECS === 'string' ? [...new Set(attrs.CODECS.split(',').slice(0, limits.codecsPerVariant).map(codec))] : [],
        });
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        mediaTagCount = boundedCount(mediaTagCount + 1);
        const type = attributes(line.slice(13)).TYPE;
        mediaTypes.add(['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'].includes(type) ? type.toLowerCase() : 'unknown');
      } else if (line.startsWith('#EXTINF:')) {
        segmentCount = boundedCount(segmentCount + 1);
        const rawDuration = line.slice(8).split(',', 1)[0].trim();
        if (/^[0-9]{1,5}(?:\.[0-9]{1,6})?$/.test(rawDuration)) {
          const duration = Number(rawDuration);
          if (duration <= 86400) declaredDuration = Math.min(100000000, declaredDuration + duration);
        }
      } else if (line === '#EXT-X-ENDLIST') hasEndList = true;
      else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        const type = line.slice(21).trim();
        declaredPlaylistType = type === 'VOD' ? 'vod' : type === 'EVENT' ? 'event' : 'unknown';
      } else if (line.startsWith('#EXT-X-MAP:')) {
        mapCount = boundedCount(mapCount + 1);
        if (attributes(line.slice(11)).BYTERANGE === true) mapByteRangeCount = boundedCount(mapByteRangeCount + 1);
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) byteRangeCount = boundedCount(byteRangeCount + 1);
      else if (line === '#EXT-X-DISCONTINUITY') discontinuityCount = boundedCount(discontinuityCount + 1);
      else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
        const isSession = line.startsWith('#EXT-X-SESSION-KEY:');
        if (isSession) sessionKeyCount = boundedCount(sessionKeyCount + 1);
        else keyCount = boundedCount(keyCount + 1);
        const attrs = attributes(line.slice(isSession ? 19 : 11));
        const method = ['NONE', 'AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(attrs.METHOD) ? attrs.METHOD : 'unknown';
        methods.add(method);
        if (method !== 'NONE') keyFormats.add(keyFormat(attrs.KEYFORMAT));
      }
      // URI-строки и атрибуты URI/IV/KEYID не сохраняются и никогда не становятся запросами.
    }
    const isMaster = variantCount > 0 || mediaTagCount > 0;
    const isMedia = segmentCount > 0 || mapCount > 0 || hasEndList;
    const hasDrmSignaling = [...keyFormats].some((format) => format === 'fairplay' || format === 'widevine' || format === 'playready');
    return {
      kind: isMaster && isMedia ? 'mixed' : isMaster ? 'master' : isMedia ? 'media' : 'unknown',
      variantCount, variants, mediaTagCount, mediaTypes: [...mediaTypes].sort(),
      segmentCount, declaredDurationSeconds: Math.round(declaredDuration * 1000) / 1000,
      hasEndList, declaredPlaylistType, mapCount, byteRangeCount, mapByteRangeCount, discontinuityCount,
      encryption: { keyCount, sessionKeyCount, methods: [...methods].sort(), keyFormats: [...keyFormats].sort(),
        assessment: hasDrmSignaling ? 'drm-signaling-observed' : keyCount + sessionKeyCount > 0 ? 'key-tags-observed-drm-unknown' : 'unknown-no-key-tags-observed' },
      isLineLimitReached: lines.length > limits.lines + 1,
      isVariantLimitReached: variantCount > limits.variants,
      quality: 'unknown-declared-bandwidth-is-not-decoded-audio-bitrate',
    };
  }
  function report() {
    return JSON.parse(JSON.stringify({
      version: 2, startedAt, completedAt, status, completionReason, isRunning, candidateCount: items.length,
      discovery: {
        windowMs: limits.discoveryWindowMs, isOpen: isDiscovering, endedAt: discoveryEndedAt, endedReason: discoveryEndedReason, observerMode,
        historyAvailable, historyEntryCount, historyWasTruncated, resourceTimingBufferSize, historyAtBufferCapacity,
        observationCount, hlsObservationCount, acceptedCount: items.length, duplicateCount, skipped: { ...skipped },
        observedHlsHostnames: [...observedHlsHostnames], observationLimitReached: observationCount >= limits.observations,
      },
      resourceHostname: allowedHost, currentPlaylistAssociation: 'unconfirmed',
      metadataAtStart, metadataAtEnd, metadataStableDuringInspection,
      hasUniqueTrackId: uniqueTrackId !== null, trackIdentityObservation: 'at-inspection-start', trackIdentityStableDuringInspection,
      playlists: items,
      limits, quality: 'unknown',
      limitations: [
        'Проверяются только уже наблюдавшиеся разрешённые unsigned .m3u8; другие адреса не запрашиваются.',
        'История Resource Timing может быть пустой или заполненной; новые события собираются 15 секунд без очистки браузерного буфера.',
        'Причины skipped отражают первый сработавший фильтр; повторные наблюдения могут увеличивать счётчики.',
        'Плейлисты из истории не сопоставлены с текущей песней, даже при неизменных metadata.',
        'BANDWIDTH/AVERAGE-BANDWIDTH — декларация HLS, а не измеренный битрейт декодированного аудио.',
        '.mp4 может быть init-фрагментом; .m4s — сегментом. Они не объявляются целой песней.',
        'Отсутствие KEY-тегов не доказывает отсутствие DRM или право на сохранение аудио.',
        'CORS и ограничения доступа не обходятся; сегменты, init, ключи и лицензии не читаются.',
      ],
    }));
  }
  function endDiscovery(reason) {
    if (!isDiscovering) return;
    isDiscovering = false;
    discoveryEndedAt = new Date().toISOString();
    discoveryEndedReason = reason;
    observer?.disconnect(); observer = null;
    if (pollingTimer !== undefined) window.clearInterval(pollingTimer);
    window.clearTimeout(discoveryTimer); timers.delete(discoveryTimer);
    if (isRunning) { status = 'draining'; pump(); }
  }
  function complete(nextStatus, reason = 'drained') {
    if (!isRunning) return report();
    isRunning = false;
    status = nextStatus;
    completionReason = reason;
    endDiscovery(reason);
    completedAt = new Date().toISOString();
    metadataAtEnd = readMetadata();
    metadataStableDuringInspection = metadataAtStart.title && metadataAtEnd.title ? JSON.stringify(metadataAtStart) === JSON.stringify(metadataAtEnd) : null;
    try {
      const finalId = readUniqueTrackId(metadataAtEnd);
      trackIdentityStableDuringInspection = uniqueTrackId && finalId ? uniqueTrackId === finalId : null;
    } catch { trackIdentityStableDuringInspection = null; }
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    window.removeEventListener('pagehide', handlePagehide);
    for (const item of items) if (item.status === 'not-requested' || item.status === 'reading') item.status = 'stopped';
    candidates.length = 0;
    seen.clear();
    const result = report();
    resolveDone(result);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  function stop(reason = 'manual-stop') {
    return complete('stopped', ['manual-stop', 'hard-timeout', 'pagehide', 'replaced'].includes(reason) ? reason : 'manual-stop');
  }
  function handlePagehide() { stop('pagehide'); }
  function pumpRequestStarts() {
    if (requestStartTimer !== undefined) { window.clearTimeout(requestStartTimer); timers.delete(requestStartTimer); requestStartTimer = undefined; }
    if (!isRunning || !requestQueue.length) return;
    const remaining = lastRequestStartedAt === null ? 0 : Math.ceil(lastRequestStartedAt + limits.requestIntervalMs - performance.now());
    if (remaining > 0) {
      requestStartTimer = window.setTimeout(() => {
        timers.delete(requestStartTimer); requestStartTimer = undefined;
        pumpRequestStarts();
      }, remaining);
      timers.add(requestStartTimer);
      return;
    }
    requestQueue.shift().launch();
    if (requestQueue.length) pumpRequestStarts();
  }
  function startRequest(signal, action) {
    return new Promise((resolve, reject) => {
      if (!isRunning || signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const entry = { launch() {
        signal.removeEventListener('abort', cancel);
        lastRequestStartedAt = performance.now();
        try { resolve(action()); } catch (error) { reject(error); }
      } };
      function cancel() {
        const index = requestQueue.indexOf(entry);
        if (index < 0) return;
        requestQueue.splice(index, 1);
        signal.removeEventListener('abort', cancel);
        reject(new DOMException('Aborted', 'AbortError'));
        pumpRequestStarts();
      }
      signal.addEventListener('abort', cancel, { once: true });
      requestQueue.push(entry);
      pumpRequestStarts();
    });
  }
  async function inspect(index) {
    const item = items[index];
    const candidate = candidates[index];
    if (!isRunning || !candidate) return;
    item.status = 'reading';
    const controller = new AbortController();
    controllers.add(controller);
    let reader = null;
    let hasTimedOut = false;
    let timer;
    const cancelReader = () => { if (reader) void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      const response = await startRequest(controller.signal, () => {
        timer = window.setTimeout(() => { hasTimedOut = true; controller.abort(); }, limits.requestTimeoutMs);
        timers.add(timer);
        return fetch(candidate.url, {
          method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
        });
      });
      if (!isRunning || controller.signal.aborted) return;
      item.httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      if (!response.ok) { item.status = 'request-failed'; await response.body?.cancel?.(); return; }
      if (!response.body || typeof response.body.getReader !== 'function') { item.status = 'stream-unavailable'; return; }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let bytes = 0;
      let text = '';
      while (isRunning && !controller.signal.aborted) {
        const chunk = await reader.read();
        if (controller.signal.aborted || !isRunning) break;
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limits.manifestBytes) { item.status = 'size-limit'; await reader.cancel(); return; }
        text += decoder.decode(chunk.value, { stream: true });
      }
      if (!isRunning || controller.signal.aborted) return;
      text += decoder.decode();
      const manifest = parseManifest(text);
      item.status = manifest ? 'inspected' : 'not-hls';
      item.manifest = manifest;
    } catch { if (isRunning) item.status = hasTimedOut ? 'timeout' : 'request-failed'; }
    finally {
      if (isRunning && controller.signal.aborted) item.status = hasTimedOut ? 'timeout' : 'request-failed';
      controller.signal.removeEventListener('abort', cancelReader);
      if (timer !== undefined) { window.clearTimeout(timer); timers.delete(timer); }
      controllers.delete(controller);
      try { reader?.releaseLock(); } catch { /* Закрываем только локальную read-сессию. */ }
    }
  }
  function pump() {
    if (!isRunning) return;
    while (activeRequests < limits.concurrentRequests && nextIndex < candidates.length) {
      const index = nextIndex++;
      activeRequests += 1;
      void inspect(index).catch(() => { if (isRunning) items[index].status = 'request-failed'; }).finally(() => {
        activeRequests -= 1;
        pump();
      });
    }
    if (!isDiscovering && activeRequests === 0 && nextIndex >= candidates.length) complete('completed');
  }
  window.addEventListener('pagehide', handlePagehide, { once: true });
  const totalTimer = window.setTimeout(() => stop('hard-timeout'), limits.totalTimeoutMs);
  timers.add(totalTimer);
  discoveryTimer = window.setTimeout(() => endDiscovery('capture-window-elapsed'), limits.discoveryWindowMs);
  timers.add(discoveryTimer);
  try { window.musicLoaderHlsReport = Object.freeze({ version: 2, report, stop, done }); } catch { stop(); return; }
  readHistory('history');
  try {
    if (typeof PerformanceObserver === 'function' && (!Array.isArray(PerformanceObserver.supportedEntryTypes) || PerformanceObserver.supportedEntryTypes.includes('resource'))) {
      observer = new PerformanceObserver((entries) => collectEntries(entries.getEntries(), 'observer'));
      observer.observe({ type: 'resource', buffered: true });
      observerMode = 'performance-observer';
    }
  } catch { observer?.disconnect(); observer = null; }
  if (!observer) {
    observerMode = 'polling';
    pollingTimer = window.setInterval(() => readHistory('polling'), limits.pollingIntervalMs);
  }
  console.info('MusicLoader HLS v2: в течение 15 секунд переключите один трек. Затем дождитесь .done: безопасный JSON появится после завершения очереди, максимум через 30 секунд.');
})();
