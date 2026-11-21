import type { HlsRequestFailure } from './hls-request';

export const hlsFailureReasons = ['hls-no-source', 'hls-ambiguous', 'hls-private-url', 'hls-unsupported',
  'hls-request-failed', 'hls-wrapped-key', 'hls-too-large', 'hls-cancelled', 'hls-invalid-data', 'protected-media'] as const;
export type HlsFailure = typeof hlsFailureReasons[number];

export class HlsDownloadError extends Error {
  constructor(public readonly code: HlsFailure, public readonly request?: HlsRequestFailure) { super(code); this.name = 'HlsDownloadError'; }
}

export type HlsEncryption = { method: 'none' } | { method: 'aes-128'; url: string; iv: Uint8Array | null };
export interface HlsVariant { url: string; bandwidth: number; codec: 'aac' | 'flac' }
export type HlsManifest =
  | { kind: 'master'; variants: HlsVariant[] }
  | { kind: 'media'; init: { url: string; encryption: HlsEncryption }; segments: { url: string; sequence: bigint; encryption: HlsEncryption }[]; duration: number };

const hlsHost = 'cdn-hls-slicer.zvuk.com';
const maxManifestBytes = 256 * 1024;
const maxSequence = (1n << 64n) - 1n;
const maxIv = (1n << 128n) - 1n;

function fail(code: HlsFailure): never { throw new HlsDownloadError(code); }

/** Resolves only the public, observed HLS origin; no secret URL components are removed. */
export function resolveHlsUrl(value: string, baseUrl?: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) fail('hls-private-url');
  if (value.includes('{$')) fail('hls-unsupported');
  if (value.includes('?') || value.includes('#') || value.includes('\\')) fail('hls-private-url');
  const base = baseUrl === undefined ? undefined : resolveHlsUrl(baseUrl);
  let url: URL;
  try { url = new URL(value, base); } catch { return fail('hls-private-url'); }
  const authority = /^(?:https:)?\/\/([^/?#]+)/i.exec(value)?.[1];
  if ((authority !== undefined && authority.toLowerCase() !== hlsHost)
    || url.protocol !== 'https:' || url.hostname !== hlsHost || url.port || url.username || url.password || url.search || url.hash) fail('hls-private-url');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return fail('hls-private-url'); }
  // The CDN's ordinary AES-128 HLS uses a /drm/ directory. Encryption methods,
  // key formats and media boxes determine supported protection, not this label.
  if (/(?:license|widevine|fairplay|playready)/i.test(path)) fail('protected-media');
  if (/[\u0000-\u0020\u007f]/.test(path) || path.includes('{$')) fail('hls-private-url');
  return url.href;
}

/** Allows only unsigned CDN keys or the observed public identity-key endpoint. */
export function resolveHlsKeyUrl(value: string, baseUrl?: string, expectedTrackId?: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) fail('hls-private-url');
  if (value.includes('{$')) fail('hls-unsupported');
  if (value.includes('#') || value.includes('\\')) fail('hls-private-url');
  const base = baseUrl === undefined ? undefined : resolveHlsUrl(baseUrl);
  let url: URL;
  try { url = new URL(value, base); } catch { return fail('hls-private-url'); }
  if (url.hostname !== 'zvuk.com') return resolveHlsUrl(value, baseUrl);
  const absolute = /^https:\/\/([^/?#]+)(\/[^?#]*)/i.exec(value);
  if (!absolute || absolute[1]?.toLowerCase() !== 'zvuk.com' || absolute[2] !== '/keyserver/api/v1/key'
    || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || url.pathname !== '/keyserver/api/v1/key') fail('hls-private-url');
  const fields = [...url.searchParams.keys()];
  if (fields.length !== 3 || new Set(fields).size !== 3
    || fields.some((field) => !['track_id', 'quality', 'content_type'].includes(field))) fail('hls-private-url');
  const trackId = url.searchParams.get('track_id') ?? '';
  const quality = url.searchParams.get('quality');
  if (!/^[0-9]{1,30}$/.test(trackId) || (quality !== 'hq' && quality !== 'lossless')
    || url.searchParams.get('content_type') !== 'track') fail('hls-private-url');
  if (expectedTrackId !== undefined && expectedTrackId !== trackId) fail('hls-ambiguous');
  return url.href;
}

function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let offset = 0;
  while (offset < value.length) {
    const match = /^([A-Z0-9-]+)=/.exec(value.slice(offset));
    if (!match?.[1]) fail('hls-invalid-data');
    const name = match[1];
    if (Object.hasOwn(result, name)) fail('hls-invalid-data');
    offset += match[0].length;
    let entry: string;
    if (value[offset] === '"') {
      const end = value.indexOf('"', offset + 1);
      if (end === -1) fail('hls-invalid-data');
      entry = value.slice(offset + 1, end);
      offset = end + 1;
    } else {
      const end = value.indexOf(',', offset);
      entry = value.slice(offset, end === -1 ? value.length : end);
      offset = end === -1 ? value.length : end;
      if (!entry || /\s/.test(entry)) fail('hls-invalid-data');
    }
    result[name] = entry;
    if (offset === value.length) break;
    if (value[offset] !== ',' || offset + 1 === value.length) fail('hls-invalid-data');
    offset += 1;
  }
  return result;
}

function unsigned(value: string | undefined): bigint {
  if (!value || !/^[0-9]{1,20}$/.test(value)) fail('hls-invalid-data');
  const integer = BigInt(value);
  if (integer > maxSequence) fail('hls-invalid-data');
  return integer;
}

function cloneEncryption(encryption: HlsEncryption): HlsEncryption {
  return encryption.method === 'none' ? { method: 'none' }
    : { method: 'aes-128', url: encryption.url, iv: encryption.iv?.slice() ?? null };
}

function parseEncryption(value: string, baseUrl: string): HlsEncryption {
  const attrs = attributes(value);
  if (Object.keys(attrs).some((key) => !['METHOD', 'URI', 'IV', 'KEYFORMAT', 'KEYFORMATVERSIONS'].includes(key))) fail('protected-media');
  if (attrs.METHOD === 'NONE') {
    if (Object.keys(attrs).length !== 1) fail('hls-unsupported');
    return { method: 'none' };
  }
  if (attrs.METHOD !== 'AES-128' || (attrs.KEYFORMAT !== undefined && attrs.KEYFORMAT !== 'identity')
    || (attrs.KEYFORMATVERSIONS !== undefined && attrs.KEYFORMATVERSIONS !== '1')) fail('protected-media');
  if (!attrs.URI) fail('hls-invalid-data');
  let iv: Uint8Array | null = null;
  if (attrs.IV !== undefined) {
    if (!/^0[xX][0-9a-fA-F]{1,32}$/.test(attrs.IV)) fail('hls-invalid-data');
    iv = deriveHlsIv(BigInt(attrs.IV));
  }
  return { method: 'aes-128', url: resolveHlsKeyUrl(attrs.URI, baseUrl), iv };
}

function isIgnoredTag(line: string): boolean {
  if (line.startsWith('#EXT-X-VERSION:')) {
    if (unsigned(line.slice('#EXT-X-VERSION:'.length)) === 0n) fail('hls-invalid-data');
    return true;
  }
  if (line === '#EXT-X-INDEPENDENT-SEGMENTS' || /^#EXT-X-ALLOW-CACHE:(?:YES|NO)$/.test(line)
    || line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) return true;
  if (line.startsWith('#EXT-X-START:')) {
    const attrs = attributes(line.slice('#EXT-X-START:'.length));
    if (!attrs['TIME-OFFSET'] || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(attrs['TIME-OFFSET']) || !Number.isFinite(Number(attrs['TIME-OFFSET']))) fail('hls-invalid-data');
    if (Object.keys(attrs).some((key) => key !== 'TIME-OFFSET' && key !== 'PRECISE')
      || (attrs.PRECISE !== undefined && attrs.PRECISE !== 'YES' && attrs.PRECISE !== 'NO')) fail('hls-unsupported');
    return true;
  }
  return false;
}

function parseMaster(lines: string[], baseUrl: string): HlsManifest {
  const variants: HlsVariant[] = [];
  let pending: Record<string, string> | null = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-SESSION-KEY')) fail('protected-media');
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pending) fail('hls-invalid-data');
      pending = attributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (isIgnoredTag(line)) continue;
    if (line.startsWith('#EXT')) fail('hls-unsupported');
    if (line.startsWith('#')) continue;
    if (!pending) fail('hls-invalid-data');
    const attrs = pending; pending = null;
    const url = resolveHlsUrl(line, baseUrl);
    const bandwidthValue = unsigned(attrs.BANDWIDTH);
    if (bandwidthValue < 1n || bandwidthValue > 1_000_000_000n) fail('hls-invalid-data');
    // Mixed video codecs or external renditions cannot be saved as one audio track.
    if (attrs.AUDIO !== undefined || attrs.VIDEO !== undefined || attrs.RESOLUTION !== undefined || attrs['FRAME-RATE'] !== undefined) continue;
    const codec = /^mp4a\.40\.(?:2|5|29|42)$/i.test(attrs.CODECS ?? '') ? 'aac'
      : /^flac$/i.test(attrs.CODECS ?? '') ? 'flac' : null;
    if (codec) variants.push({ url, bandwidth: Number(bandwidthValue), codec });
    if (variants.length > 32) fail('hls-too-large');
  }
  if (pending) fail('hls-invalid-data');
  if (variants.length === 0) fail('hls-unsupported');
  return { kind: 'master', variants };
}

/** Parses the observed finite VOD subset; unsupported media/encryption tags fail closed. */
export function parseHlsManifest(text: string, baseUrl: string): HlsManifest {
  const base = resolveHlsUrl(baseUrl);
  if (text.length > maxManifestBytes || new TextEncoder().encode(text).length > maxManifestBytes) fail('hls-too-large');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || text.startsWith('\ufeff')) fail('hls-invalid-data');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.shift() !== '#EXTM3U') fail('hls-invalid-data');
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'))) return parseMaster(lines, base);

  let encryption: HlsEncryption = { method: 'none' };
  let init: Extract<HlsManifest, { kind: 'media' }>['init'] | null = null;
  const segments: Extract<HlsManifest, { kind: 'media' }>['segments'] = [];
  let sequence = 0n;
  let hasSequence = false;
  let hasTargetDuration = false;
  let hasEnd = false;
  let pendingDuration: number | null = null;
  let duration = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-SESSION-KEY')) fail('protected-media');
    if (line.startsWith('#') && !line.startsWith('#EXT')) continue;
    if (hasEnd) fail('hls-invalid-data');
    if (line.startsWith('#EXT-X-KEY:')) { encryption = parseEncryption(line.slice('#EXT-X-KEY:'.length), base); continue; }
    if (line.startsWith('#EXT-X-MAP:')) {
      if (init || segments.length > 0) fail('hls-unsupported');
      const attrs = attributes(line.slice('#EXT-X-MAP:'.length));
      if (!attrs.URI || Object.keys(attrs).some((key) => key !== 'URI')) fail('hls-unsupported');
      if (encryption.method === 'aes-128' && encryption.iv === null) fail('hls-unsupported');
      init = { url: resolveHlsUrl(attrs.URI, base), encryption: cloneEncryption(encryption) }; continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      if (hasSequence || segments.length > 0 || pendingDuration !== null) fail('hls-invalid-data');
      sequence = unsigned(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)); hasSequence = true; continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      if (hasTargetDuration || unsigned(line.slice('#EXT-X-TARGETDURATION:'.length)) === 0n) fail('hls-invalid-data');
      hasTargetDuration = true; continue;
    }
    if (line.startsWith('#EXTINF:')) {
      if (pendingDuration !== null) fail('hls-invalid-data');
      const match = /^([0-9]+(?:\.[0-9]+)?),[^\r\n]*$/.exec(line.slice('#EXTINF:'.length));
      pendingDuration = match?.[1] ? Number(match[1]) : null;
      if (pendingDuration === null || !Number.isFinite(pendingDuration) || pendingDuration <= 0) fail('hls-invalid-data');
      continue;
    }
    if (line === '#EXT-X-ENDLIST') { if (pendingDuration !== null) fail('hls-invalid-data'); hasEnd = true; continue; }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) { if (line !== '#EXT-X-PLAYLIST-TYPE:VOD') fail('hls-unsupported'); continue; }
    if (isIgnoredTag(line)) continue;
    if (line.startsWith('#EXT')) fail('hls-unsupported');
    if (pendingDuration === null || !init) fail('hls-invalid-data');
    const url = resolveHlsUrl(line, base);
    if (!/\.m4s$/i.test(new URL(url).pathname)) fail('hls-unsupported');
    if (segments.length >= 1000 || duration + pendingDuration > 1800) fail('hls-too-large');
    const segmentSequence = sequence + BigInt(segments.length);
    if (segmentSequence > maxSequence) fail('hls-invalid-data');
    segments.push({ url, sequence: segmentSequence, encryption: cloneEncryption(encryption) });
    duration += pendingDuration; pendingDuration = null;
  }
  if (!hasEnd || !hasTargetDuration || !init || segments.length === 0 || pendingDuration !== null) fail('hls-unsupported');
  return { kind: 'media', init, segments, duration };
}

export function deriveHlsIv(sequence: bigint): Uint8Array {
  if (typeof sequence !== 'bigint' || sequence < 0n || sequence > maxIv) fail('hls-invalid-data');
  const iv = new Uint8Array(16);
  let remaining = sequence;
  for (let index = 15; index >= 0; index -= 1) { iv[index] = Number(remaining & 255n); remaining >>= 8n; }
  return iv;
}

export async function decryptHlsBytes(data: Uint8Array, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array> {
  if (!data.length || data.length % 16 !== 0 || iv.length !== 16) fail('hls-invalid-data');
  if (data.length > 32 * 1024 * 1024) fail('hls-too-large');
  if (key.algorithm.name !== 'AES-CBC' || (key.algorithm as AesKeyAlgorithm).length !== 128 || !key.usages.includes('decrypt')) fail('hls-invalid-data');
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(iv) }, key, new Uint8Array(data));
    return new Uint8Array(plaintext);
  } catch { return fail('hls-invalid-data'); }
}

interface Mp4Box { type: string; payload: number; end: number; children: Mp4Box[] }
const protectedBoxes = new Set(['pssh', 'tenc', 'sinf', 'schm', 'enca', 'encv', 'senc', 'saiz', 'saio', 'uuid', 'ipro']);
const containerBoxes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf', 'udta', 'mfra', 'wave']);

function parseBoxes(data: Uint8Array): Mp4Box[] {
  if (data.length < 8) fail('hls-invalid-data');
  if (data.length > 32 * 1024 * 1024) fail('hls-too-large');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let count = 0;
  function list(start: number, end: number, depth: number): Mp4Box[] {
    if (depth > 16) fail('hls-invalid-data');
    const boxes: Mp4Box[] = [];
    let offset = start;
    while (offset < end) {
      if (++count > 10_000 || end - offset < 8) fail('hls-invalid-data');
      const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
      if (!/^[\x20-\x7e]{4}$/.test(type)) fail('hls-invalid-data');
      if (protectedBoxes.has(type)) fail('protected-media');
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (end - offset < 16) fail('hls-invalid-data');
        const wide = view.getBigUint64(offset + 8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) fail('hls-too-large');
        size = Number(wide); header = 16;
      } else if (size === 0) {
        if (type !== 'mdat' || depth !== 0) fail('hls-invalid-data');
        size = end - offset;
      }
      if (size < header || size > end - offset) fail('hls-invalid-data');
      const payload = offset + header;
      const boxEnd = offset + size;
      let children: Mp4Box[] = [];
      if (containerBoxes.has(type)) children = list(payload, boxEnd, depth + 1);
      else if (type === 'meta') {
        if (boxEnd - payload < 4) fail('hls-invalid-data');
        children = list(payload + 4, boxEnd, depth + 1);
      } else if (type === 'stsd') {
        if (boxEnd - payload < 8) fail('hls-invalid-data');
        children = list(payload + 8, boxEnd, depth + 1);
        if (data[payload] !== 0 || view.getUint32(payload + 4) !== children.length) fail('hls-invalid-data');
      } else if (type === 'mp4a' || type === 'fLaC') {
        if (boxEnd - payload < 28 || view.getUint16(payload + 8) !== 0) fail('hls-invalid-data');
        children = list(payload + 28, boxEnd, depth + 1);
      } else if ((type === 'sgpd' || type === 'sbgp') && boxEnd - payload >= 8
        && String.fromCharCode(...data.subarray(payload + 4, payload + 8)) === 'seig') fail('protected-media');
      boxes.push({ type, payload, end: boxEnd, children });
      offset = boxEnd;
    }
    return boxes;
  }
  return list(0, data.length, 0);
}

function allBoxes(boxes: Mp4Box[]): Mp4Box[] { return boxes.flatMap((box) => [box, ...allBoxes(box.children)]); }

/** Checks bounded ISO box structure and the single unencrypted audio sample entry; it does not decode audio. */
export function validateMp4Init(data: Uint8Array): 'aac' | 'flac' {
  const boxes = parseBoxes(data);
  if (boxes.some((box) => !['ftyp', 'moov', 'free', 'skip', 'pdin', 'sidx'].includes(box.type))) fail('hls-invalid-data');
  const ftyp = boxes.filter((box) => box.type === 'ftyp');
  const movies = boxes.filter((box) => box.type === 'moov');
  if (ftyp.length !== 1 || movies.length !== 1 || !ftyp[0] || !movies[0] || boxes.indexOf(ftyp[0]) > boxes.indexOf(movies[0])) fail('hls-invalid-data');
  if (ftyp[0].end - ftyp[0].payload < 8 || (ftyp[0].end - ftyp[0].payload) % 4 !== 0) fail('hls-invalid-data');
  const tracks = movies[0].children.filter((box) => box.type === 'trak');
  if (tracks.length !== 1 || !tracks[0]) fail('hls-unsupported');
  const media = tracks[0].children.filter((box) => box.type === 'mdia');
  if (media.length !== 1 || !media[0]) fail('hls-invalid-data');
  const handlers = media[0].children.filter((box) => box.type === 'hdlr');
  if (handlers.length !== 1 || !handlers[0] || handlers[0].end - handlers[0].payload < 12) fail('hls-invalid-data');
  const handler = String.fromCharCode(...data.subarray(handlers[0].payload + 8, handlers[0].payload + 12));
  if (handler !== 'soun') fail('hls-unsupported');
  const descriptions = allBoxes(media).filter((box) => box.type === 'stsd');
  if (descriptions.length !== 1 || !descriptions[0] || descriptions[0].children.length !== 1) fail('hls-unsupported');
  const sample = descriptions[0].children[0];
  if (sample?.type === 'mp4a') return 'aac';
  if (sample?.type === 'fLaC') return 'flac';
  return fail('hls-unsupported');
}

export function validateMp4Fragment(data: Uint8Array): void {
  const boxes = parseBoxes(data);
  if (boxes.some((box) => !['styp', 'sidx', 'emsg', 'prft', 'free', 'skip', 'moof', 'mdat'].includes(box.type))) fail('hls-invalid-data');
  const fragments = boxes.filter((box) => box.type === 'moof');
  const payloads = boxes.filter((box) => box.type === 'mdat');
  if (fragments.length !== 1 || !fragments[0] || payloads.length === 0 || payloads.some((box) => box.end === box.payload)) fail('hls-invalid-data');
  const fragmentIndex = boxes.indexOf(fragments[0]);
  if (payloads.some((box) => boxes.indexOf(box) < fragmentIndex)) fail('hls-invalid-data');
  if (fragments[0].children.filter((box) => box.type === 'traf').length !== 1) fail('hls-unsupported');
}
