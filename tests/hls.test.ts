import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { decryptHlsBytes, deriveHlsIv, HlsDownloadError, parseHlsManifest, resolveHlsKeyUrl, resolveHlsUrl, validateMp4Fragment, validateMp4Init, type HlsFailure, type HlsManifest } from '../src/features/downloads/lib/hls';

const base = 'https://cdn-hls-slicer.zvuk.com/track/81400222/master.m3u8';

function rejects(code: HlsFailure, operation: () => unknown) {
  assert.throws(operation, (error: unknown) => error instanceof HlsDownloadError && error.code === code);
}

function vod(lines: string[], targetDuration = 10): string {
  return ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${targetDuration}`, '#EXT-X-PLAYLIST-TYPE:VOD',
    ...lines, '#EXT-X-ENDLIST'].join('\n');
}

function media(text: string): Extract<HlsManifest, { kind: 'media' }> {
  const manifest = parseHlsManifest(text, base);
  assert.equal(manifest.kind, 'media');
  if (manifest.kind !== 'media') throw new Error('Expected media fixture');
  return manifest;
}

describe('strict public HLS URL scope', () => {
  it('resolves relative paths on exactly the observed CDN origin', () => {
    assert.equal(resolveHlsUrl('../audio/0.m4s', base), 'https://cdn-hls-slicer.zvuk.com/track/audio/0.m4s');
    assert.equal(resolveHlsUrl('/init.mp4', base), 'https://cdn-hls-slicer.zvuk.com/init.mp4');
    assert.equal(resolveHlsUrl(base), base);
  });

  it('rejects query/hash, credentials, explicit ports, other hosts and control characters', () => {
    for (const url of [
      `${base}?token=secret`, `${base}#secret`, `${base}?`, `${base}#`,
      'https://user:password@cdn-hls-slicer.zvuk.com/key.bin',
      'https://cdn-hls-slicer.zvuk.com:443/key.bin', 'https://cdn-hls-slicer.zvuk.com:8443/key.bin',
      'https://cdn-hls-slicer.zvuk.com.attacker.test/key.bin', 'https://zvuk.com/key.bin',
      'http://cdn-hls-slicer.zvuk.com/key.bin', 'https://cdn-hls-slicer.zvuk.com/\nkey.bin',
      'https://cdn-hls-slicer.zvuk.com/%00key.bin', 'data:application/x-mpegurl,anything',
    ]) rejects('hls-private-url', () => resolveHlsUrl(url, base));
    rejects('hls-private-url', () => resolveHlsUrl('key.bin', 'https://elsewhere.test/master.m3u8'));
    rejects('hls-unsupported', () => resolveHlsUrl('{$secret}/key.bin', base));
  });

  it('accepts ordinary HLS in the observed drm directory without interpreting a path name as a protection method', () => {
    const master = 'https://cdn-hls-slicer.zvuk.com/drm/track/t60001-a/master.m3u8';
    assert.equal(resolveHlsUrl(master), master);
    assert.equal(resolveHlsUrl('init.mp4', master), 'https://cdn-hls-slicer.zvuk.com/drm/track/t60001-a/init.mp4');
    assert.equal(resolveHlsKeyUrl('key.bin', master), 'https://cdn-hls-slicer.zvuk.com/drm/track/t60001-a/key.bin');
  });

  it('never allows known license-system paths, including percent-encoded paths', () => {
    for (const path of ['license/key.bin', 'widevine/key.bin', 'fairplay/key.bin', 'playready/key.bin', '%6cicense/key.bin']) {
      rejects('protected-media', () => resolveHlsUrl(path, base));
    }
  });
});

describe('observed HLS identity key endpoint', () => {
  const keyUrl = 'https://zvuk.com/keyserver/api/v1/key?track_id=60001&quality=hq&content_type=track';

  it('preserves the declared endpoint and public parameters for the confirmed track', () => {
    assert.equal(resolveHlsKeyUrl(keyUrl, base, '60001'), keyUrl);
    const reordered = 'https://zvuk.com/keyserver/api/v1/key?content_type=track&quality=lossless&track_id=60001';
    assert.equal(resolveHlsKeyUrl(reordered, undefined, '60001'), reordered);
    assert.equal(resolveHlsKeyUrl('key.bin', base, '60001'), 'https://cdn-hls-slicer.zvuk.com/track/81400222/key.bin');
    rejects('hls-ambiguous', () => resolveHlsKeyUrl(keyUrl, base, '60002'));
    rejects('hls-ambiguous', () => resolveHlsKeyUrl(keyUrl, base, '60001.*'));
  });

  it('rejects missing, duplicate, extra, private or unsupported parameters without rewriting them', () => {
    for (const value of [
      keyUrl.replace('&content_type=track', ''), keyUrl.replace('track_id=60001', 'track_id='),
      keyUrl.replace('track_id=60001', 'track_id=60001%20'), keyUrl.replace('track_id=60001', `track_id=${'1'.repeat(31)}`),
      keyUrl.replace('quality=hq', 'quality=mq'), keyUrl.replace('content_type=track', 'content_type=episode'),
      `${keyUrl}&track_id=60001`, `${keyUrl}&token=secret`, `${keyUrl}&signature=secret`, `${keyUrl}&extra=1`,
      keyUrl.replace('track_id=60001', 'id=60001'), `${keyUrl}#fragment`, `${keyUrl}#`,
    ]) rejects('hls-private-url', () => resolveHlsKeyUrl(value, base, '60001'));
  });

  it('rejects other origins, ports, paths, credentials, variables and hidden path rewrites', () => {
    for (const value of [
      keyUrl.replace('https:', 'http:'), keyUrl.replace('zvuk.com', 'other.zvuk.com'),
      keyUrl.replace('zvuk.com', 'zvuk.com.attacker.test'), keyUrl.replace('zvuk.com', 'zvuk.com:443'),
      keyUrl.replace('zvuk.com', 'zvuk.com:8443'), keyUrl.replace('zvuk.com', 'user:password@zvuk.com'),
      keyUrl.replace('/keyserver/', '/other/'), keyUrl.replace('/keyserver/', '/x/../keyserver/'),
      keyUrl.replace('/keyserver/', '/%6beyserver/'), keyUrl.replace('https:', ''),
      keyUrl.replace('keyserver', 'key\\server'), keyUrl.replace('track_id=60001', 'track_id=60001\n'),
    ]) rejects('hls-private-url', () => resolveHlsKeyUrl(value, base));
    rejects('hls-unsupported', () => resolveHlsKeyUrl(keyUrl.replace('track_id=60001', 'track_id={$track}'), base));
  });

  it('parses declared identity encryption in drm-prefixed VOD while keeping SAMPLE-AES and nonidentity formats blocked', () => {
    const playlist = vod([`#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x01`, '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.m4s']);
    const parsed = parseHlsManifest(playlist, 'https://cdn-hls-slicer.zvuk.com/drm/track/t60001-a/hq.m3u8');
    assert.equal(parsed.kind, 'media');
    if (parsed.kind !== 'media') throw new Error('Expected media');
    assert.equal(parsed.init.encryption.method === 'aes-128' && parsed.init.encryption.url, keyUrl);
    assert.equal(parsed.segments[0]?.encryption.method === 'aes-128' && parsed.segments[0].encryption.url, keyUrl);
    rejects('protected-media', () => parseHlsManifest(playlist.replace('METHOD=AES-128', 'METHOD=SAMPLE-AES'), base));
    rejects('protected-media', () => parseHlsManifest(playlist.replace(',IV=0x01', ',KEYFORMAT="com.apple.streamingkeydelivery",IV=0x01'), base));
  });
});

describe('master playlist parsing', () => {
  it('preserves supported quality variants without choosing or inventing bitrate', () => {
    const manifest = parseHlsManifest(['#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.29",NAME="AAC, small"', 'heaac.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=129000,CODECS="mp4a.40.2"', 'aac128.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=257000,CODECS="mp4a.40.2"', 'aac256.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=945000,CODECS="fLaC"', 'flac.m3u8',
    ].join('\n'), base);
    assert.equal(manifest.kind, 'master');
    if (manifest.kind !== 'master') throw new Error('Expected master');
    assert.deepEqual(manifest.variants.map((variant) => [variant.bandwidth, variant.codec]), [[64000, 'aac'], [129000, 'aac'], [257000, 'aac'], [945000, 'flac']]);
    assert.equal(manifest.variants[0]?.url, 'https://cdn-hls-slicer.zvuk.com/track/81400222/heaac.m3u8');
  });

  it('accepts each supported AAC profile but skips mixed-video codec/rendition variants', () => {
    for (const profile of [2, 5, 29, 42]) {
      const manifest = parseHlsManifest(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.${profile}"\naac.m3u8`, base);
      assert.equal(manifest.kind === 'master' && manifest.variants[0]?.codec, 'aac');
    }
    const manifest = parseHlsManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.4d401f,mp4a.40.2"\nvideo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\naudio.m3u8', base);
    assert.equal(manifest.kind === 'master' && manifest.variants.length, 1);
  });

  it('rejects duplicate/malformed attributes, missing URIs and unsupported master structures', () => {
    for (const text of [
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,BANDWIDTH=2,CODECS="mp4a.40.2"\naac.m3u8',
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2\naac.m3u8',
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2",\naac.m3u8',
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="mp4a.40.2"',
    ]) rejects('hls-invalid-data', () => parseHlsManifest(text, base));
    rejects('hls-unsupported', () => parseHlsManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="alac"\nalac.m3u8', base));
  });
});

describe('finite VOD fMP4 media playlists', () => {
  it('resolves map/segments, retains sequence as bigint and sums actual EXTINF durations', () => {
    const manifest = media(vod(['#EXT-X-MEDIA-SEQUENCE:9007199254740993', '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:9.5,A title, containing commas', '0.m4s', '#EXTINF:9.25,', '1.m4s']));
    assert.equal(manifest.duration, 18.75);
    assert.equal(manifest.init.url, 'https://cdn-hls-slicer.zvuk.com/track/81400222/init.mp4');
    assert.deepEqual(manifest.segments.map((segment) => segment.sequence), [9007199254740993n, 9007199254740994n]);
    assert.deepEqual(manifest.segments[0]?.encryption, { method: 'none' });
  });

  it('snapshots key rotation, explicit IVs, implicit segment IVs and METHOD=NONE separately', () => {
    const manifest = media(vod([
      '#EXT-X-MEDIA-SEQUENCE:17', '#EXT-X-KEY:METHOD=AES-128,URI="init.key",IV=0x01', '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="key-1.bin",KEYFORMAT="identity",KEYFORMATVERSIONS="1"', '#EXTINF:9,', '0.m4s',
      '#EXT-X-KEY:METHOD=AES-128,URI="key-2.bin",IV=0x0100', '#EXTINF:9,', '1.m4s',
      '#EXT-X-KEY:METHOD=NONE', '#EXTINF:9,', '2.m4s',
    ]));
    assert.equal(manifest.init.encryption.method, 'aes-128');
    if (manifest.init.encryption.method === 'aes-128') assert.deepEqual(manifest.init.encryption.iv, deriveHlsIv(1n));
    const first = manifest.segments[0]; const second = manifest.segments[1];
    assert.ok(first && second);
    assert.equal(first.sequence, 17n);
    assert.equal(first.encryption.method === 'aes-128' && first.encryption.iv, null);
    assert.equal(first.encryption.method === 'aes-128' && first.encryption.url, 'https://cdn-hls-slicer.zvuk.com/track/81400222/key-1.bin');
    assert.deepEqual(second.encryption.method === 'aes-128' && second.encryption.iv, deriveHlsIv(256n));
    assert.deepEqual(manifest.segments[2]?.encryption, { method: 'none' });
  });

  it('does not share mutable IV arrays between map and segments', () => {
    const manifest = media(vod(['#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.m4s', '#EXTINF:9,', '1.m4s']));
    const first = manifest.segments[0]; const second = manifest.segments[1];
    assert.ok(first?.encryption.method === 'aes-128' && first.encryption.iv);
    first.encryption.iv[15] = 99;
    assert.deepEqual(second?.encryption.method === 'aes-128' && second.encryption.iv, deriveHlsIv(1n));
    assert.deepEqual(manifest.init.encryption.method === 'aes-128' && manifest.init.encryption.iv, deriveHlsIv(1n));
  });

  it('requires an explicit IV for an encrypted initialization map', () => {
    rejects('hls-unsupported', () => parseHlsManifest(vod(['#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.m4s']), base));
    rejects('hls-invalid-data', () => parseHlsManifest(vod(['#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0xno', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.m4s']), base));
  });

  it('blocks DRM/sample encryption, session keys and private key URLs', () => {
    for (const key of [
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key.bin"',
    ]) rejects('protected-media', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', key, '#EXTINF:9,', '0.m4s']), base));
    rejects('protected-media', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', '#EXT-X-KEY:METHOD=AES-128,URI="license/key"', '#EXTINF:9,', '0.m4s']), base));
    rejects('hls-private-url', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=secret"', '#EXTINF:9,', '0.m4s']), base));
  });

  it('allows harmless playback hints but still downloads the entire finite VOD', () => {
    const manifest = media(vod(['#EXT-X-ALLOW-CACHE:NO', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-29T00:00:00Z', '#EXT-X-START:TIME-OFFSET=-3.5,PRECISE=YES',
      '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.m4s', '#EXTINF:9,', '1.m4s']));
    assert.equal(manifest.segments.length, 2);
    assert.equal(manifest.duration, 18);
  });

  it('rejects unsupported structural tags, TS, byte ranges and changed maps', () => {
    for (const tag of ['#EXT-X-BYTERANGE:10@0', '#EXT-X-DISCONTINUITY', '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-GAP', '#EXT-X-PART:DURATION=1,URI="x.m4s"', '#EXT-X-UNKNOWN-ENCRYPTION:yes']) {
      rejects('hls-unsupported', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', tag, '#EXTINF:9,', '0.m4s']), base));
    }
    rejects('hls-unsupported', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"', '#EXTINF:9,', '0.m4s']), base));
    rejects('hls-unsupported', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.ts']), base));
    rejects('hls-unsupported', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.m4s', '#EXT-X-MAP:URI="other.mp4"', '#EXTINF:9,', '1.m4s']), base));
    rejects('hls-unsupported', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9,', '0.m4s']).replace('\n#EXT-X-ENDLIST', ''), base));
  });

  it('enforces text bytes, segment count, duration and integer sequence bounds', () => {
    rejects('hls-too-large', () => parseHlsManifest('a'.repeat(256 * 1024 + 1), base));
    rejects('hls-too-large', () => parseHlsManifest('#EXTM3U\n#' + 'я'.repeat(140000), base));
    const segments = Array.from({ length: 1001 }, (_, index) => ['#EXTINF:1,', `${index}.m4s`]).flat();
    rejects('hls-too-large', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', ...segments]), base));
    rejects('hls-too-large', () => parseHlsManifest(vod(['#EXT-X-MAP:URI="init.mp4"', '#EXTINF:1800.01,', '0.m4s'], 1801), base));
    rejects('hls-invalid-data', () => parseHlsManifest(vod(['#EXT-X-MEDIA-SEQUENCE:18446744073709551615', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:1,', '0.m4s', '#EXTINF:1,', '1.m4s']), base));
  });
});

describe('AES-128 identity helpers', () => {
  it('derives the exact 128-bit big-endian sequence IV without Number precision loss', () => {
    assert.deepEqual(Array.from(deriveHlsIv(0x010203n)), [...Array<number>(13).fill(0), 1, 2, 3]);
    assert.equal(Buffer.from(deriveHlsIv(9007199254740993n)).toString('hex'), '00000000000000000020000000000001');
    rejects('hls-invalid-data', () => deriveHlsIv(-1n));
    rejects('hls-invalid-data', () => deriveHlsIv(1n << 128n));
  });

  it('decrypts own synthetic AES-CBC data and removes PKCS7 padding through WebCrypto', async () => {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from({ length: 16 }, (_, index) => index), 'AES-CBC', false, ['encrypt', 'decrypt']);
    for (const length of [1, 16, 17, 128]) {
      const original = Uint8Array.from({ length }, (_, index) => index % 251);
      const iv = deriveHlsIv(23n);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(iv) }, key, original));
      assert.deepEqual(await decryptHlsBytes(ciphertext, key, iv), original);
    }
  });

  it('rejects invalid block lengths, IVs, incompatible keys and invalid padding', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-CBC', false, ['decrypt']);
    for (const operation of [
      () => decryptHlsBytes(new Uint8Array(15), key, deriveHlsIv(0n)),
      () => decryptHlsBytes(new Uint8Array(16), key, new Uint8Array(15)),
      () => decryptHlsBytes(new Uint8Array(16), key, deriveHlsIv(0n)),
    ]) await assert.rejects(operation, (error: unknown) => error instanceof HlsDownloadError && error.code === 'hls-invalid-data');
    const wrongKey = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', false, ['decrypt']);
    await assert.rejects(() => decryptHlsBytes(new Uint8Array(16), wrongKey, deriveHlsIv(0n)), HlsDownloadError);
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  return joined;
}

function ascii(value: string): Uint8Array { return Uint8Array.from(value, (character) => character.charCodeAt(0)); }
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(...parts);
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(ascii(type), 4); bytes.set(payload, 8);
  return bytes;
}
function init(codec = 'mp4a', child: Uint8Array = new Uint8Array(0), handler = 'soun'): Uint8Array {
  return concat(box('ftyp', ascii('iso6'), new Uint8Array(4)), box('moov', box('trak', box('mdia',
    box('hdlr', new Uint8Array(8), ascii(handler)), box('minf', box('stbl', box('stsd', new Uint8Array(4), Uint8Array.of(0, 0, 0, 1), box(codec, new Uint8Array(28), child))))))));
}
function fragment(child: Uint8Array = new Uint8Array(0)): Uint8Array { return concat(box('moof', box('traf', child)), box('mdat', Uint8Array.of(1, 2, 3, 4))); }

describe('bounded unencrypted ISO BMFF checks', () => {
  it('recognizes one audio mp4a/fLaC sample entry instead of guessing from the master filename', () => {
    assert.equal(validateMp4Init(init('mp4a')), 'aac');
    assert.equal(validateMp4Init(init('fLaC')), 'flac');
    validateMp4Fragment(fragment());
    rejects('hls-unsupported', () => validateMp4Init(init('mp4a', new Uint8Array(0), 'vide')));
    rejects('hls-unsupported', () => validateMp4Init(init('alac')));
  });

  it('blocks encryption boxes at top level and inside nested sample/fragment containers', () => {
    for (const type of ['pssh', 'tenc', 'sinf', 'schm', 'enca', 'encv', 'senc', 'saiz', 'saio']) {
      rejects('protected-media', () => validateMp4Init(concat(init(), box(type))));
      rejects('protected-media', () => validateMp4Fragment(fragment(box(type))));
    }
    rejects('protected-media', () => validateMp4Init(init('mp4a', box('sinf', box('schm')))));
    rejects('protected-media', () => validateMp4Init(init('enca')));
    rejects('protected-media', () => validateMp4Fragment(fragment(box('sgpd', new Uint8Array(4), ascii('seig')))));
  });

  it('rejects truncated/oversized boxes, arbitrary payloads and missing moof/mdat', () => {
    for (const bytes of [new Uint8Array(0), Uint8Array.of(0, 0, 0), init().slice(0, -1), ascii('<html>failed request</html>')]) {
      rejects('hls-invalid-data', () => validateMp4Init(bytes));
    }
    const wrongSize = box('free'); new DataView(wrongSize.buffer).setUint32(0, 7);
    rejects('hls-invalid-data', () => validateMp4Fragment(wrongSize));
    rejects('hls-invalid-data', () => validateMp4Fragment(box('moof', box('traf'))));
    rejects('hls-invalid-data', () => validateMp4Fragment(box('mdat', Uint8Array.of(1))));
    rejects('hls-invalid-data', () => validateMp4Fragment(concat(box('mdat', Uint8Array.of(1)), box('moof', box('traf')))));
    rejects('hls-invalid-data', () => validateMp4Fragment(concat(box('moof', box('traf')), box('mdat'))));
  });

  it('supports bounded extended-size boxes and rejects excessive nested structures', () => {
    const extended = new Uint8Array(17);
    new DataView(extended.buffer).setUint32(0, 1); extended.set(ascii('mdat'), 4);
    new DataView(extended.buffer).setBigUint64(8, 17n); extended[16] = 1;
    validateMp4Fragment(concat(box('moof', box('traf')), extended));
    let nested = box('free');
    for (let depth = 0; depth < 20; depth += 1) nested = box('moov', nested);
    rejects('hls-invalid-data', () => validateMp4Init(nested));
  });

  it('accepts the actual AAC initialization and five fragments recorded from our own synthetic Chrome audio fixture', async () => {
    assert.equal(validateMp4Init(new Uint8Array(await readFile(new URL('./fixtures/hls/init.mp4', import.meta.url)))), 'aac');
    for (let index = 0; index < 5; index += 1) validateMp4Fragment(new Uint8Array(await readFile(new URL(`./fixtures/hls/segment${index}.m4s`, import.meta.url))));
  });
});
