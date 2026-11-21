import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { downloadHlsTrack } from '../src/features/downloads/services/hls-download';
import { HlsDownloadError, type HlsFailure } from '../src/features/downloads/lib/hls';
import { isHlsRequestFailure, type HlsRequestFailure } from '../src/features/downloads/lib/hls-request';

const trackId = '81400222';
const root = `https://cdn-hls-slicer.zvuk.com/hls/${trackId}/`;
const masterUrl = `${root}master.m3u8`;
type Bytes = Uint8Array<ArrayBuffer>;
type Resource = string | Uint8Array | ((options: RequestInit) => Promise<Response>);

function concat(...parts: readonly Uint8Array[]): Bytes {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
function box(type: string, payload: Uint8Array = new Uint8Array()): Bytes {
  const bytes = new Uint8Array(8 + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}
function initialization(codec: 'aac' | 'flac' = 'aac'): Bytes {
  const handler = new Uint8Array(12);
  handler.set(new TextEncoder().encode('soun'), 8);
  const description = new Uint8Array(8);
  new DataView(description.buffer).setUint32(4, 1);
  const sample = new Uint8Array(28);
  const sampleView = new DataView(sample.buffer);
  sampleView.setUint16(6, 1); sampleView.setUint16(16, 2); sampleView.setUint16(18, 16);
  sampleView.setUint32(24, 44100 * 65536);
  const stsd = box('stsd', concat(description, box(codec === 'aac' ? 'mp4a' : 'fLaC', sample)));
  return concat(box('ftyp', concat(new TextEncoder().encode('isom'), new Uint8Array(4))),
    box('moov', box('trak', box('mdia', concat(box('hdlr', handler), box('minf', box('stbl', stsd)))))));
}
function fragment(marker: number, totalSize?: number): Bytes {
  const moof = box('moof', box('traf'));
  const data = new Uint8Array(totalSize === undefined ? 3 : totalSize - moof.byteLength - 8);
  data[0] = marker;
  return concat(moof, box('mdat', data));
}
function master(variants = [{ uri: 'aac/playlist.m3u8', bandwidth: 256000, codec: 'mp4a.40.2' }]): string {
  return ['#EXTM3U', ...variants.flatMap((variant) => [`#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},CODECS="${variant.codec}"`, variant.uri])].join('\n');
}
function media(segmentCount = 2, keyTags: string[] = []): string {
  return ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...keyTags.slice(0, 1), '#EXT-X-MAP:URI="init.mp4"', ...keyTags.slice(1),
    ...Array.from({ length: segmentCount }, (_, index) => ['#EXTINF:4,', `segment-${index}.m4s`]).flat(), '#EXT-X-ENDLIST'].join('\n');
}
function iv(sequence: number): Bytes {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setBigUint64(8, BigInt(sequence));
  return bytes;
}
async function encrypt(bytes: Bytes, key: CryptoKey, vector: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: vector }, key, bytes));
}
function fixture() {
  const resources = new Map<string, Resource>();
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const exposedChunks: Array<{ url: string; bytes: Uint8Array }> = [];
  async function fetchResource(url: string, options: RequestInit) {
    calls.push({ url, options });
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const resource = resources.get(url);
    if (typeof resource === 'function') return resource(options);
    if (resource === undefined) throw new Error('https://private.test/missing?token=do-not-expose');
    const bytes = typeof resource === 'string' ? new TextEncoder().encode(resource) : new Uint8Array(resource);
    exposedChunks.push({ url, bytes });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }));
  }
  function download(candidates: readonly string[], id: string, signal: AbortSignal, onProgress: (value: number) => void) {
    return downloadHlsTrack(candidates, id, signal, onProgress, {
      fetchResource,
      // Pacing is covered separately. This fixture controls the response and cancellation.
      pacer: { start: (_signal, action) => action() },
    });
  }
  function install(codec: 'aac' | 'flac' = 'aac', segmentCount = 2) {
    resources.set(masterUrl, master([{ uri: 'aac/playlist.m3u8', bandwidth: 256000, codec: codec === 'aac' ? 'mp4a.40.2' : 'fLaC' }]));
    resources.set(`${root}aac/playlist.m3u8`, media(segmentCount));
    resources.set(`${root}aac/init.mp4`, initialization(codec));
    for (let index = 0; index < segmentCount; index += 1) resources.set(`${root}aac/segment-${index}.m4s`, fragment(index + 1));
  }
  return { resources, calls, exposedChunks, install, download };
}
function failure(code: HlsFailure) {
  return (error: unknown) => error instanceof HlsDownloadError && error.code === code && error.message === code;
}

function requestFailure(expected: HlsRequestFailure, code: HlsFailure = 'hls-request-failed') {
  return (error: unknown) => {
    assert.ok(error instanceof HlsDownloadError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(error.request, expected);
    assert.equal(isHlsRequestFailure(error.request), true);
    assert.doesNotMatch(JSON.stringify(error), /private\.test|DO_NOT_EXPOSE|token=|Authorization|headers/);
    return true;
  };
}

describe('user initiated HLS download service', () => {
  it('sends a fresh nonce on the declared Zvuk key route and does not import its wrapped response', async () => {
    const network = fixture();
    const cdnRoot = `https://cdn-hls-slicer.zvuk.com/drm/track/t${trackId}-a/`;
    const playlistUrl = `${cdnRoot}master.m3u8`;
    const keyUrl = `https://zvuk.com/keyserver/api/v1/key?quality=hq&track_id=${trackId}&content_type=track`;
    network.resources.set(playlistUrl, master());
    network.resources.set(`${cdnRoot}aac/playlist.m3u8`, media(2, [
      `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x00000000000000000000000000000009`,
      `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}"`,
    ]));
    network.resources.set(`${cdnRoot}aac/init.mp4`, new Uint8Array(32));
    let cancellations = 0;
    network.resources.set(keyUrl, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16)); },
      cancel() { cancellations += 1; },
    })));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(network.download([playlistUrl], trackId, new AbortController().signal, () => {}),
        requestFailure({ resource: 'key', kind: 'invalid-data', httpStatus: 200 }, 'hls-wrapped-key'));
    }
    assert.equal(cancellations, 2);
    const keyCalls = network.calls.filter((call) => call.url === keyUrl);
    assert.equal(keyCalls.length, 2);
    const nonces = keyCalls.map(({ options }) => new Headers(options.headers).get('x-encrypted-key'));
    for (const nonce of nonces) assert.match(nonce ?? '', /^[A-Za-z0-9]{8}$/);
    assert.notEqual(nonces[0], nonces[1]);
    assert.equal(network.calls.some(({ url }) => url.endsWith('.m4s')), false);
    for (const call of network.calls) {
      assert.equal(call.options.credentials, call.url === keyUrl ? 'same-origin' : 'omit');
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.referrerPolicy, 'no-referrer');
      assert.equal(call.options.mode, 'cors');
      assert.deepEqual([...new Headers(call.options.headers).keys()], call.url === keyUrl ? ['x-encrypted-key'] : []);
      assert.equal(call.url === keyUrl || new URL(call.url).hostname === 'cdn-hls-slicer.zvuk.com', true);
    }
  });

  it('binds every declared key track ID before requesting init, segments or keys', async () => {
    const network = fixture();
    network.install();
    const wrongKey = `https://zvuk.com/keyserver/api/v1/key?track_id=9${trackId}&quality=hq&content_type=track`;
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, [
      '#EXT-X-KEY:METHOD=NONE',
      `#EXT-X-KEY:METHOD=AES-128,URI="${wrongKey}"`,
    ]));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-ambiguous'));
    assert.deepEqual(network.calls.map((call) => call.url), [masterUrl, `${root}aac/playlist.m3u8`]);
  });

  it('rejects key route authorization parameters and SAMPLE-AES without requesting the key or audio', async () => {
    const network = fixture();
    network.install();
    const keyUrl = `https://zvuk.com/keyserver/api/v1/key?track_id=${trackId}&quality=hq&content_type=track`;
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, [`#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}&token=DO_NOT_EXPOSE",IV=0x01`]));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-private-url'));
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, [`#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${keyUrl}",KEYFORMAT="com.apple.streamingkeydelivery"`]));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('protected-media'));
    assert.equal(network.calls.every((call) => call.url === masterUrl || call.url === `${root}aac/playlist.m3u8`), true);
  });

  it('reports key server HTTP 401/403 without retrying, exposing secrets or requesting segments', async () => {
    const network = fixture();
    network.install();
    const keyUrl = `https://zvuk.com/keyserver/api/v1/key?track_id=${trackId}&quality=hq&content_type=track`;
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, [`#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x01`]));
    for (const status of [401, 403]) {
      network.resources.set(keyUrl, async () => new Response('DO_NOT_EXPOSE', { status }));
      await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}),
        requestFailure({ resource: 'key', kind: 'http', httpStatus: status }));
    }
    assert.equal(network.calls.filter((call) => call.url === keyUrl).length, 2);
    assert.equal(network.calls.some((call) => call.url.endsWith('.m4s')), false);
  });

  it('saves a complete clear variant from the same master after the selected init key returns HTTP 400', async () => {
    const network = fixture();
    network.install();
    const selected = `${root}aac/playlist.m3u8`;
    const preview = `${root}preview/playlist.m3u8`;
    const alternate = `${root}clear/playlist.m3u8`;
    const keyUrl = `https://zvuk.com/keyserver/api/v1/key?track_id=${trackId}&quality=hq&content_type=track`;
    network.resources.set(masterUrl, master([
      { uri: 'aac/playlist.m3u8', bandwidth: 256000, codec: 'mp4a.40.2' },
      { uri: 'preview/playlist.m3u8', bandwidth: 192000, codec: 'mp4a.40.2' },
      { uri: 'clear/playlist.m3u8', bandwidth: 128000, codec: 'mp4a.40.2' },
    ]));
    network.resources.set(selected, media(2, [`#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x01`]));
    network.resources.set(keyUrl, async () => new Response(null, { status: 400 }));
    network.resources.set(preview, media(1));
    network.resources.set(alternate, media(2));
    const init = initialization();
    const segments = [fragment(42), fragment(43)];
    network.resources.set(`${root}clear/init.mp4`, init);
    for (const [index, bytes] of segments.entries()) network.resources.set(`${root}clear/segment-${index}.m4s`, bytes);

    const progress: number[] = [];
    const blob = await network.download([masterUrl, selected, preview, alternate], trackId, new AbortController().signal,
      (value) => progress.push(value));
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), concat(init, ...segments));
    assert.equal(network.calls.filter(({ url }) => url === keyUrl).length, 1);
    assert.deepEqual(network.calls.filter(({ url }) => url.endsWith('.m4s')).map(({ url }) => url), [
      `${root}clear/segment-0.m4s`, `${root}clear/segment-1.m4s`,
    ]);
    assert.equal(network.calls.some(({ url }) => url === `${root}preview/init.mp4`), false);
    assert.equal(progress.includes(15), true);
    assert.equal(progress.at(-1), 99);
  });

  it('keeps the key HTTP 400 failure when observed variants are encrypted or belong outside the master', async () => {
    const network = fixture();
    network.install();
    const keyUrl = `https://zvuk.com/keyserver/api/v1/key?track_id=${trackId}&quality=hq&content_type=track`;
    const selected = `${root}aac/playlist.m3u8`;
    const partlyEncrypted = `${root}alternate/playlist.m3u8`;
    const unrelated = `${root}unrelated/playlist.m3u8`;
    const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x01`;
    network.resources.set(masterUrl, master([
      { uri: 'aac/playlist.m3u8', bandwidth: 256000, codec: 'mp4a.40.2' },
      { uri: 'alternate/playlist.m3u8', bandwidth: 192000, codec: 'mp4a.40.2' },
      { uri: 'unobserved/playlist.m3u8', bandwidth: 128000, codec: 'mp4a.40.2' },
    ]));
    network.resources.set(selected, media(2, [keyTag]));
    network.resources.set(partlyEncrypted, media(2, ['#EXT-X-KEY:METHOD=NONE', keyTag]));
    network.resources.set(unrelated, media(2));
    network.resources.set(keyUrl, async () => new Response(null, { status: 400 }));

    await assert.rejects(network.download([masterUrl, selected, partlyEncrypted, unrelated], trackId, new AbortController().signal, () => {}),
      requestFailure({ resource: 'key', kind: 'http', httpStatus: 400 }));
    assert.equal(network.calls.filter(({ url }) => url === keyUrl).length, 1);
    assert.equal(network.calls.some(({ url }) => url.includes('/unobserved/') || url.endsWith('.m4s')), false);
    assert.deepEqual(network.calls.filter(({ url }) => url.endsWith('/init.mp4')).map(({ url }) => url), [`${root}aac/init.mp4`]);
  });

  it('distinguishes initial-fragment HTTP 503 from a key failure at 15 percent', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/init.mp4`, async () => new Response('DO_NOT_EXPOSE', { status: 503 }));
    const progress: number[] = [];
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, (value) => progress.push(value)),
      requestFailure({ resource: 'init', kind: 'http', httpStatus: 503 }));
    assert.equal(progress.at(-1), 15);
    assert.equal(network.calls.some((call) => call.url.endsWith('.m4s') || call.url.includes('/key')), false);
  });

  it('does not invent HTTP status for hidden network/CORS failures', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/init.mp4`, async () => { throw new TypeError('https://private.test/init?token=DO_NOT_EXPOSE'); });
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}),
      requestFailure({ resource: 'init', kind: 'network', httpStatus: null }));
    assert.equal(network.calls.filter((call) => call.url.endsWith('/init.mp4')).length, 1);
    network.resources.set(`${root}aac/init.mp4`, async () => Response.error());
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}),
      requestFailure({ resource: 'init', kind: 'network', httpStatus: null }));
  });

  it('distinguishes an empty HTTP response and retains visible status on a failed body read', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/init.mp4`, async () => new Response(null, { status: 204 }));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}),
      requestFailure({ resource: 'init', kind: 'empty-body', httpStatus: 204 }));
    network.resources.set(`${root}aac/init.mp4`, async () => new Response('', { status: 200 }));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}),
      requestFailure({ resource: 'init', kind: 'empty-body', httpStatus: 200 }));
    network.resources.set(`${root}aac/init.mp4`, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new TypeError('DO_NOT_EXPOSE')); },
    }), { status: 200 }));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}),
      requestFailure({ resource: 'init', kind: 'network', httpStatus: 200 }));
  });

  it('reports segment failures after successful init instead of attributing them to the manifest or key', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/segment-0.m4s`, async () => new Response(null, { status: 429 }));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}),
      requestFailure({ resource: 'segment', kind: 'http', httpStatus: 429 }));
    assert.equal(network.calls.filter((call) => call.url.endsWith('/segment-0.m4s')).length, 1);
  });

  it('cancels an identity key response and clears partial key bytes', async () => {
    const network = fixture();
    network.install();
    const keyUrl = `${root}aac/key.bin`;
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, [`#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x01`]));
    const partial = new Uint8Array(8).fill(71);
    let hasCancelled = false;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    network.resources.set(keyUrl, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partial); signalStarted!(); },
      cancel() { hasCancelled = true; },
    })));
    const controller = new AbortController();
    const pending = network.download([masterUrl], trackId, controller.signal, () => {});
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, failure('hls-cancelled'));
    assert.equal(hasCancelled, true);
    assert.equal(partial.every((value) => value === 0), true);
    assert.equal(network.calls.some((call) => call.url.endsWith('.m4s')), false);
  });

  it('reports a stalled key body as a timeout at 15 percent and clears partial key bytes', async (context) => {
    const network = fixture();
    network.install();
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const keyUrl = `${root}aac/key.bin`;
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, [`#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x01`]));
    const partial = new Uint8Array(8).fill(91);
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    network.resources.set(keyUrl, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partial); signalStarted!(); },
    })));
    const progress: number[] = [];
    const pending = network.download([masterUrl], trackId, new AbortController().signal, (value) => progress.push(value));
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(15_000);
    await assert.rejects(pending, requestFailure({ resource: 'key', kind: 'timeout', httpStatus: 200 }));
    assert.equal(progress.at(-1), 15);
    assert.equal(partial.every((value) => value === 0), true);
    assert.equal(network.calls.some((call) => call.url.endsWith('.m4s')), false);
  });

  it('decrypts its own AES-128 init/segments into one ordered MP4 Blob, caches a nonextractable key and clears raw key bytes', async (context) => {
    const network = fixture();
    network.install();
    const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const encryptionKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    const init = initialization();
    const first = fragment(17);
    const second = fragment(29);
    const explicitIv = '00000000000000000000000000000009';
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, [
      `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${explicitIv}`,
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    ]));
    network.resources.set(`${root}aac/key.bin`, keyBytes);
    network.resources.set(`${root}aac/init.mp4`, await encrypt(init, encryptionKey, iv(9)));
    network.resources.set(`${root}aac/segment-0.m4s`, await encrypt(first, encryptionKey, iv(5)));
    network.resources.set(`${root}aac/segment-1.m4s`, await encrypt(second, encryptionKey, iv(6)));
    const originalImport = crypto.subtle.importKey.bind(crypto.subtle);
    const imported: CryptoKey[] = [];
    context.mock.method(crypto.subtle, 'importKey', async (...args: Parameters<SubtleCrypto['importKey']>) => {
      const key = await originalImport(...args);
      imported.push(key);
      return key;
    });
    const progress: number[] = [];
    const blob = await network.download([masterUrl], trackId, new AbortController().signal, (value) => progress.push(value));
    assert.equal(blob.type, 'audio/mp4');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), concat(init, first, second));
    assert.equal(network.calls.filter((call) => call.url.endsWith('/key.bin')).length, 1);
    assert.equal(imported.length, 1);
    assert.equal(imported[0]!.extractable, false);
    assert.deepEqual(imported[0]!.usages, ['decrypt']);
    const rawKeyChunk = network.exposedChunks.find((entry) => entry.url.endsWith('/key.bin'))!;
    assert.equal(rawKeyChunk.bytes.every((value) => value === 0), true);
    assert.equal(progress[0], 0);
    assert.equal(progress.at(-1), 99);
    assert.equal(progress.every((value, index) => value >= 0 && value <= 99 && (index === 0 || value > progress[index - 1]!)), true);
    for (const call of network.calls) {
      assert.equal(new URL(call.url).hostname, 'cdn-hls-slicer.zvuk.com');
      assert.equal(call.options.credentials, 'omit');
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.referrerPolicy, 'no-referrer');
      assert.equal(call.options.mode, 'cors');
      assert.equal('headers' in call.options, false);
    }
  });

  it('selects highest declared bandwidth AAC ahead of FLAC and uses referenced cached media rather than the first candidate', async () => {
    const network = fixture();
    network.install();
    network.resources.set(masterUrl, master([
      { uri: 'flac/playlist.m3u8', bandwidth: 1000000, codec: 'fLaC' },
      { uri: 'aac-low/playlist.m3u8', bandwidth: 128000, codec: 'mp4a.40.2' },
      { uri: 'aac/playlist.m3u8', bandwidth: 256000, codec: 'mp4a.40.2' },
    ]));
    const irrelevantMedia = `${root}unselected/playlist.m3u8`;
    network.resources.set(irrelevantMedia, media());
    const selected = `${root}aac/playlist.m3u8`;
    const blob = await network.download([irrelevantMedia, selected, masterUrl, masterUrl], trackId, new AbortController().signal, () => {});
    assert.ok(blob.size > 0);
    assert.equal(network.calls.filter((call) => call.url === selected).length, 1);
    assert.equal(network.calls.some((call) => call.url.includes('/flac/') || call.url.includes('/aac-low/') || call.url.includes('/unselected/init')), false);
  });

  it('supports a validated FLAC fMP4 variant only when no AAC variant is present', async () => {
    const network = fixture();
    network.install('flac');
    const blob = await network.download([masterUrl], trackId, new AbortController().signal, () => {});
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), concat(initialization('flac'), fragment(1), fragment(2)));
  });

  it('rejects codec/init disagreement before requesting any media segment', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/init.mp4`, initialization('flac'));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-invalid-data'));
    assert.equal(network.calls.some((call) => call.url.endsWith('.m4s')), false);
  });

  it('requires a unique master and never downloads the first observed media playlist as a song', async () => {
    const network = fixture();
    network.install();
    const mediaUrl = `${root}aac/playlist.m3u8`;
    await assert.rejects(network.download([mediaUrl], trackId, new AbortController().signal, () => {}), failure('hls-no-source'));
    assert.deepEqual(network.calls.map((call) => call.url), [mediaUrl]);
    const otherMaster = `${root}other/master.m3u8`;
    network.resources.set(otherMaster, master());
    await assert.rejects(network.download([masterUrl, otherMaster], trackId, new AbortController().signal, () => {}), failure('hls-ambiguous'));
    assert.equal(network.calls.some((call) => call.url.endsWith('init.mp4') || call.url.endsWith('.m4s')), false);
  });

  it('enforces track ID numeric boundaries, candidate limits and public CDN URL rules before fetching', async () => {
    const network = fixture();
    const signal = new AbortController().signal;
    await assert.rejects(network.download(['https://cdn-hls-slicer.zvuk.com/hls/1814002223/master.m3u8'], trackId, signal, () => {}), failure('hls-no-source'));
    await assert.rejects(network.download([`${root}init.mp4`], trackId, signal, () => {}), failure('hls-no-source'));
    await assert.rejects(network.download([`${masterUrl}?token=private`], trackId, signal, () => {}), failure('hls-private-url'));
    await assert.rejects(network.download(['https://other.example.test/81400222/master.m3u8'], trackId, signal, () => {}), failure('hls-private-url'));
    await assert.rejects(network.download(Array.from({ length: 9 }, (_, index) => `${root}${index}.m3u8`), trackId, signal, () => {}), failure('hls-ambiguous'));
    assert.equal(network.calls.length, 0);
  });

  it('rejects SAMPLE-AES/DRM signaling before requesting keys, init or segments', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin",KEYFORMAT="com.apple.streamingkeydelivery"']));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('protected-media'));
    assert.equal(network.calls.length, 2);
    assert.equal(network.calls.some((call) => /key|init|segment/.test(new URL(call.url).pathname)), false);
  });

  it('enforces exactly sixteen key bytes and clears a malformed key buffer', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, ['#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001']));
    network.resources.set(`${root}aac/key.bin`, new Uint8Array(15).fill(123));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), requestFailure({ resource: 'key', kind: 'invalid-data', httpStatus: 200 }, 'hls-invalid-data'));
    assert.equal(network.exposedChunks.find((entry) => entry.url.endsWith('/key.bin'))!.bytes.every((value) => value === 0), true);
    network.resources.set(`${root}aac/key.bin`, new Uint8Array(17).fill(123));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), requestFailure({ resource: 'key', kind: 'invalid-data', httpStatus: 200 }, 'hls-invalid-data'));
    assert.equal(network.exposedChunks.filter((entry) => entry.url.endsWith('/key.bin')).every((entry) => entry.bytes.every((value) => value === 0)), true);
  });

  it('identifies invalid encrypted init data after both HTTP requests succeed', async () => {
    const network = fixture();
    network.install();
    network.resources.set(`${root}aac/playlist.m3u8`, media(2, ['#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01']));
    network.resources.set(`${root}aac/key.bin`, new Uint8Array(16).fill(17));
    network.resources.set(`${root}aac/init.mp4`, new Uint8Array(15).fill(9));
    const progress: number[] = [];
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, (value) => progress.push(value)),
      requestFailure({ resource: 'init', kind: 'invalid-data', httpStatus: 200 }, 'hls-invalid-data'));
    assert.equal(progress.at(-1), 15);
    assert.equal(network.calls.some((call) => call.url.endsWith('.m4s')), false);
  });

  it('rejects more than sixteen rotating keys before requesting their bytes', async () => {
    const network = fixture();
    network.install();
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MAP:URI="init.mp4"',
      ...Array.from({ length: 17 }, (_, index) => [`#EXT-X-KEY:METHOD=AES-128,URI="key-${index}.bin"`, '#EXTINF:4,', `segment-${index}.m4s`]).flat(), '#EXT-X-ENDLIST'].join('\n');
    network.resources.set(`${root}aac/playlist.m3u8`, text);
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-unsupported'));
    assert.equal(network.calls.length, 2);
  });

  it('rejects oversized resource bodies and cumulative downloads above 64 MiB', async () => {
    const network = fixture();
    network.install();
    network.resources.set(masterUrl, '#EXTM3U\n'.padEnd(256 * 1024 + 1, ' '));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-too-large'));
    network.install();
    network.resources.set(`${root}aac/init.mp4`, new Uint8Array(8 * 1024 * 1024 + 1));
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-too-large'));
    network.install('aac', 9);
    const large = fragment(1, 8 * 1024 * 1024);
    for (let index = 0; index < 9; index += 1) network.resources.set(`${root}aac/segment-${index}.m4s`, large);
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-too-large'));
  });

  it('preserves segment order while reading no more than two resources concurrently', async () => {
    const network = fixture();
    network.install('aac', 4);
    let active = 0;
    let maximumActive = 0;
    const resolvers: Array<() => void> = [];
    for (let index = 0; index < 4; index += 1) {
      network.resources.set(`${root}aac/segment-${index}.m4s`, async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          active += 1; maximumActive = Math.max(active, maximumActive);
          resolvers.push(() => { active -= 1; controller.enqueue(fragment(index + 1)); controller.close(); });
        },
      })));
    }
    const pending = network.download([masterUrl], trackId, new AbortController().signal, () => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolvers.length, 2);
    resolvers[1]!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolvers.length, 3);
    resolvers[0]!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolvers.length, 4);
    resolvers[3]!(); resolvers[2]!();
    const blob = await pending;
    assert.equal(maximumActive, 2);
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), concat(initialization(), fragment(1), fragment(2), fragment(3), fragment(4)));
  });

  it('cancels before work and during active reads, and never exposes request error strings', async () => {
    const network = fixture();
    network.install();
    const early = new AbortController(); early.abort();
    await assert.rejects(network.download([masterUrl], trackId, early.signal, () => {}), failure('hls-cancelled'));
    assert.equal(network.calls.length, 0);
    let cancelCount = 0;
    for (let index = 0; index < 2; index += 1) network.resources.set(`${root}aac/segment-${index}.m4s`, async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelCount += 1; } })));
    const controller = new AbortController();
    const pending = network.download([masterUrl], trackId, controller.signal, () => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, failure('hls-cancelled'));
    assert.equal(cancelCount, 2);
    assert.equal(network.calls.filter((call) => call.url.endsWith('.m4s')).every((call) => call.options.signal?.aborted), true);
    network.resources.delete(masterUrl);
    await assert.rejects(network.download([masterUrl], trackId, new AbortController().signal, () => {}), failure('hls-request-failed'));
  });

  it('aborts a request after fifteen seconds without misreporting a timeout as user cancellation', async (context) => {
    const network = fixture();
    context.mock.timers.enable({ apis: ['setTimeout'] });
    network.resources.set(masterUrl, async (options) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('https://private.test/timeout?token=do-not-expose')), { once: true });
    }));
    const pending = network.download([masterUrl], trackId, new AbortController().signal, () => {});
    assert.equal(network.calls.length, 1);
    context.mock.timers.tick(14_999);
    assert.equal(network.calls[0]!.options.signal?.aborted, false);
    context.mock.timers.tick(1);
    await assert.rejects(pending, requestFailure({ resource: 'manifest', kind: 'timeout', httpStatus: null }));
    assert.equal(network.calls[0]!.options.signal?.aborted, true);
  });
});
