import type { Track } from '../../../shared/types/track';

const maxTextLength = 512;
const maxArtworkLength = 2048;
const trackFields = ['id', 'title', 'artist', 'album', 'artwork', 'url'] as const;
const trackIdPattern = /^[0-9]{1,30}$/;
const artworkOptimizerPaths = new Map([
  ['https://cdn-new.zvuk.com', '/desktop-data/_next/image'],
  ['https://zvuk.com', '/_next/image'],
]);
const artworkSourceHosts = new Set([
  'cdn-image.zvuk.com', 'cdn41.zvuk.com', 'cdn42.zvuk.com', 'cdn51.zvuk.com',
  'cdn52.zvuk.com', 'cdn61.zvuk.com', 'cdn62.zvuk.com',
  'obs-image-service-mz.obs.ru-moscow-1.hc.sbercloud.ru',
]);
const artworkWidths = new Set(['64', '120', '280', '420', '700']);

function isOptimizedArtwork(url: URL, original: string): boolean {
  const expectedPath = artworkOptimizerPaths.get(url.origin);
  const absolute = /^https:\/\/([^/?#]+)(\/[^?#]*)/i.exec(original);
  if (!expectedPath || url.pathname !== expectedPath || !absolute
    || absolute[1]?.toLowerCase() !== url.hostname || absolute[2] !== expectedPath
    || /[\u0000-\u0020\u007f\\]/.test(original)) return false;
  const fields = [...url.searchParams.keys()];
  if (url.search.slice(1).split('&').length !== 3 || fields.length !== 3 || new Set(fields).size !== 3
    || fields.some((field) => !['url', 'w', 'q'].includes(field))) return false;
  if (!artworkWidths.has(url.searchParams.get('w') ?? '') || !/^(?:[1-9][0-9]?|100)$/.test(url.searchParams.get('q') ?? '')) return false;
  const source = url.searchParams.get('url') ?? '';
  if (!source || /[\u0000-\u0020\u007f\\?#]/.test(source)) return false;
  try {
    const image = new URL(source);
    const authority = /^https:\/\/([^/?#]+)/i.exec(source)?.[1];
    const isSafeSource = image.protocol === 'https:' && artworkSourceHosts.has(image.hostname)
      && authority?.toLowerCase() === image.hostname && !image.port && !image.username && !image.password && !image.search && !image.hash;
    return isSafeSource && !/[\u0000-\u0020\u007f\\]/.test(decodeURIComponent(image.pathname));
  } catch { return false; }
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > maxTextLength * 4) return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= maxTextLength ? text : null;
}

function normalizeArtwork(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > maxArtworkLength || value.includes('#')) return null;
  try {
    const url = new URL(value);
    const isSafe = url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (value.includes('?') ? isOptimizedArtwork(url, value) : !url.search);
    return isSafe ? url.href : null;
  } catch {
    return null;
  }
}

/** Reads only the metadata fields used by the popup; unrelated page data is discarded. */
export function normalizeMetadata(value: unknown): Track | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  const title = normalizeText(metadata.title);
  if (!title) return null;

  let artwork: string | null = null;
  if (Array.isArray(metadata.artwork)) {
    for (const image of metadata.artwork.slice(0, 16)) {
      if (typeof image !== 'object' || image === null || !('src' in image)) continue;
      artwork = normalizeArtwork(image.src);
      if (artwork) break;
    }
  }

  return {
    id: null,
    title,
    artist: normalizeText(metadata.artist) ?? '',
    album: normalizeText(metadata.album) || null,
    artwork,
    url: null,
  };
}

/** Messages carry exactly the normalized public track fields, including explicit nulls. */
export function isTrack(value: unknown): value is Track {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const track = value as Record<string, unknown>;
  const keys = Object.keys(track);
  if (keys.length !== trackFields.length || !trackFields.every((field) => Object.hasOwn(track, field))) return false;
  if (typeof track.title !== 'string' || !track.title || normalizeText(track.title) !== track.title) return false;
  if (typeof track.artist !== 'string' || normalizeText(track.artist) !== track.artist) return false;
  if (track.album !== null && (typeof track.album !== 'string' || !track.album || normalizeText(track.album) !== track.album)) return false;
  if (track.artwork !== null && normalizeArtwork(track.artwork) !== track.artwork) return false;
  if (track.id !== null && (typeof track.id !== 'string' || !trackIdPattern.test(track.id))) return false;
  if (track.url !== null && (track.id === null || track.url !== `https://zvuk.com/track/${track.id}`)) return false;
  return true;
}

function comparableText(value: string): string {
  return (normalizeText(value) ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU');
}

function comparableArtist(value: string): string {
  // Separate inline name/separator nodes can introduce whitespace before a comma.
  // Keep the separator and the full name intact; this is only a comparison value.
  return comparableText(value).replace(/\s*,\s*/g, ',');
}

function getLinkedTrackId(anchor: HTMLAnchorElement, document: Document): string | null {
  try {
    const url = new URL(anchor.getAttribute('href') ?? '', document.baseURI);
    const isZvuk = url.hostname === 'zvuk.com' || url.hostname.endsWith('.zvuk.com');
    if (url.protocol !== 'https:' || !isZvuk || url.port || url.username || url.password) return null;
    return /^\/track\/([0-9]{1,30})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function hasMatchingTitle(anchor: HTMLAnchorElement, title: string): boolean {
  const candidates = [anchor.getAttribute('title'), anchor.textContent,
    ...Array.from(anchor.querySelectorAll('[title]'), (element) => element.getAttribute('title'))];
  return candidates.some((candidate) => candidate !== null && comparableText(candidate) === title);
}

function containsArtist(text: string, artist: string): boolean {
  const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(comparableArtist(text));
}

function hasArtistEvidence(anchor: HTMLAnchorElement, artist: string, document: Document): boolean {
  if (!artist) return false;
  let container = anchor.parentElement;
  for (let depth = 0; depth < 2 && container; depth += 1, container = container.parentElement) {
    if (container === document.body || container === document.documentElement) break;
    // A whole playlist must not supply an artist belonging to another row.
    const linkedIds = new Set(Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map((link) => getLinkedTrackId(link, document)).filter((id) => id !== null));
    if (linkedIds.size > 1) continue;

    const walker = document.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
    const text: string[] = [];
    let node = walker.nextNode();
    for (let count = 0; node && count < 128; count += 1, node = walker.nextNode()) {
      const isIgnored = anchor.contains(node) || Boolean(node.parentElement?.closest('script, style, noscript, [hidden], [aria-hidden="true"]'));
      if (!isIgnored) text.push(node.textContent ?? '');
    }
    const artistText = text.join(' ');
    if (artistText.length <= 2048 && containsArtist(artistText, artist)) return true;
  }
  return false;
}

/** A title alone cannot identify a track: require nearby matching artist and one unique ID. */
export function resolveTrackIdentity(track: Track, document: Document): Track {
  const title = comparableText(track.title);
  const artist = comparableArtist(track.artist);
  const ids = new Set<string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const id = getLinkedTrackId(anchor, document);
    if (id && hasMatchingTitle(anchor, title) && hasArtistEvidence(anchor, artist, document)) ids.add(id);
  }
  const id = ids.size === 1 ? ids.values().next().value ?? null : null;
  return { ...track, id, url: id === null ? null : `https://zvuk.com/track/${id}` };
}
