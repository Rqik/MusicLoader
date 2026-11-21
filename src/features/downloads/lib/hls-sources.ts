import { resolveHlsUrl } from './hls';
import type { HlsDiscovery } from './hls-discovery';

const maxObservations = 10_000;
const maxPlaylistsPerBatch = 10_000;

/** Keeps a small, page-local set of observed playlist addresses; never requests them. */
export function createHlsSourceTracker() {
  const urls = new Set<string>();
  let observer: PerformanceObserver | null = null;
  let isDisposed = false;
  let observations = 0;
  let playlistObservations = 0;
  let acceptedObservations = 0;
  let rejectedPrivate = 0;
  let rejectedHost = 0;
  let rejectedOther = 0;
  function collect(entries: readonly Pick<PerformanceEntry, 'name'>[]) {
    if (isDisposed) return;
    observations = Math.min(maxObservations, observations + entries.length);
    let inspectedPlaylists = 0;
    // A master can be the first resource in a large batch. Scan names before applying
    // the expensive URL parse budget, rather than discarding the first entries.
    for (const entry of entries) {
      try {
        if (typeof entry.name !== 'string' || entry.name.length > 4096 || !/\.m3u8(?:[?#]|$)/i.test(entry.name)) continue;
        if (inspectedPlaylists++ >= maxPlaylistsPerBatch) break;
        let candidate: URL;
        try { candidate = new URL(entry.name); }
        catch {
          playlistObservations = Math.min(maxObservations, playlistObservations + 1);
          rejectedOther = Math.min(maxObservations, rejectedOther + 1); continue;
        }
        if (!/\.m3u8$/i.test(candidate.pathname)) continue;
        playlistObservations = Math.min(maxObservations, playlistObservations + 1);
        if (candidate.username || candidate.password || entry.name.includes('?') || entry.name.includes('#')) {
          rejectedPrivate = Math.min(maxObservations, rejectedPrivate + 1); continue;
        }
        if (candidate.hostname !== 'cdn-hls-slicer.zvuk.com') {
          rejectedHost = Math.min(maxObservations, rejectedHost + 1); continue;
        }
        let url: string;
        try { url = resolveHlsUrl(entry.name); }
        catch { rejectedOther = Math.min(maxObservations, rejectedOther + 1); continue; }
        acceptedObservations = Math.min(maxObservations, acceptedObservations + 1);
        if (urls.has(url)) continue;
        urls.add(url);
        if (urls.size > 32) urls.delete(urls.values().next().value!);
      } catch { /* Other resources and private addresses are not retained. */ }
    }
  }
  function readHistory() {
    try { collect(performance.getEntriesByType('resource')); } catch { /* No history available. */ }
  }
  readHistory();
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      observer = new PerformanceObserver((entries) => collect(entries.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch { observer?.disconnect(); observer = null; }
  function matchingUrls(id: string | null): string[] {
    if (isDisposed || id === null || !/^[0-9]{1,30}$/.test(id)) return [];
    const pattern = new RegExp(`(^|[^0-9])${id}(?=$|[^0-9])`);
    return [...urls].filter((url) => pattern.test(new URL(url).pathname)).slice(-8);
  }
  return {
    hasObserved() { if (!observer && !isDisposed) readHistory(); return urls.size > 0; },
    forTrack(id: string): string[] {
      if (isDisposed || !/^[0-9]{1,30}$/.test(id)) return [];
      if (!observer) readHistory();
      return matchingUrls(id);
    },
    readDiscovery(trackId: string | null): HlsDiscovery {
      if (!observer && !isDisposed) readHistory();
      return { observerMode: observer ? 'observer' : 'history', observations, playlistObservations,
        acceptedObservations, storedPlaylists: urls.size, matchingPlaylists: matchingUrls(trackId).length,
        rejectedPrivate, rejectedHost, rejectedOther };
    },
    dispose() { isDisposed = true; observer?.disconnect(); observer = null; urls.clear(); },
  };
}
