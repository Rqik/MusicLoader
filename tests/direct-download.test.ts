import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDownloadFilename, inspectDownloadSource, isDownloadResolution, type DownloadExtension, type DownloadResolution } from '../src/features/downloads/lib/direct-download';
import { hlsFailureReasons } from '../src/features/downloads/lib/hls';
import type { Track } from '../src/shared/types/track';

interface MediaFixture { source?: string; tag?: 'audio' | 'video'; hasKeys?: boolean; hasObject?: boolean; hasEncrypted?: boolean }

function inspect(fixtures: MediaFixture[]): DownloadResolution {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://zvuk.com/' });
  const encrypted = new WeakSet<HTMLMediaElement>();
  try {
    for (const fixture of fixtures) {
      const element = dom.window.document.createElement(fixture.tag ?? 'audio');
      Object.defineProperties(element, {
        currentSrc: { value: fixture.source ?? '', configurable: true },
        mediaKeys: { value: fixture.hasKeys ? {} : null, configurable: true },
        srcObject: { value: fixture.hasObject ? {} : null, configurable: true },
      });
      if (fixture.hasEncrypted) encrypted.add(element);
      dom.window.document.body.append(element);
    }
    return inspectDownloadSource(dom.window.document, (element) => encrypted.has(element));
  } finally { dom.window.close(); }
}

const track: Track = { id: null, title: 'Очень-очень', artist: 'ARTIK & ASTI', album: null, artwork: null, url: null };

describe('direct existing media source inspection', () => {
  it('accepts supported HTTPS file candidates on Zvuk and its subdomains', () => {
    const extensions = ['mp3', 'aac', 'flac', 'ogg', 'opus', 'wav', 'm4a', 'mp4'] as const;
    for (const extension of extensions) {
      const url = `https://cdn.audio.zvuk.com/public/song.${extension}`;
      assert.deepEqual(inspect([{ source: url }]), { status: 'ready', url, extension });
    }
    assert.deepEqual(inspect([{ source: 'https://zvuk.com/song.MP3', tag: 'video' }]), {
      status: 'ready', url: 'https://zvuk.com/song.MP3', extension: 'mp3',
    });
  });

  it('does not use unloaded src attributes or a missing currentSrc', () => {
    assert.deepEqual(inspect([]), { status: 'unavailable', reason: 'no-source' });
    assert.deepEqual(inspect([{}]), { status: 'unavailable', reason: 'no-source' });
    const dom = new JSDOM('<audio src="https://zvuk.com/loaded-later.mp3"></audio>', { url: 'https://zvuk.com/' });
    try { assert.deepEqual(inspectDownloadSource(dom.window.document, () => false), { status: 'unavailable', reason: 'no-source' }); }
    finally { dom.window.close(); }
  });

  it('never chooses the first of two media sources, even with identical URLs', () => {
    const source = 'https://zvuk.com/song.mp3';
    assert.deepEqual(inspect([{ source }, { source: 'https://zvuk.com/other.mp3' }]), { status: 'unavailable', reason: 'multiple-sources' });
    assert.deepEqual(inspect([{ source }, { source, tag: 'video' }]), { status: 'unavailable', reason: 'multiple-sources' });
    assert.deepEqual(inspect([{ source }, { hasObject: true }]), { status: 'unavailable', reason: 'multiple-sources' });
    assert.deepEqual(inspect([{}, { source }]), { status: 'ready', url: source, extension: 'mp3' });
  });

  it('rejects media keys and observed encrypted events before exposing a URL', () => {
    for (const fixture of [{ hasKeys: true }, { hasEncrypted: true }]) {
      assert.deepEqual(inspect([{ source: 'https://zvuk.com/song.mp3', ...fixture }]), { status: 'unavailable', reason: 'protected-media' });
    }
  });

  it('rejects object sources, MSE blob URLs, playlists and known segment paths', () => {
    assert.deepEqual(inspect([{ hasObject: true }]), { status: 'unavailable', reason: 'stream-source' });
    for (const source of [
      'blob:https://zvuk.com/opaque-source', 'data:audio/mp3;base64,not-a-file',
      'https://zvuk.com/live.m3u8', 'https://zvuk.com/live.mpd', 'https://zvuk.com/part.m4s', 'https://zvuk.com/part.ts',
    ]) assert.deepEqual(inspect([{ source }]), { status: 'unavailable', reason: 'stream-source' }, source);
  });

  it('rejects signed, credentialed and fragment URLs without returning any URL', () => {
    for (const source of [
      'https://zvuk.com/song.mp3?token=secret', 'https://zvuk.com/song.mp3#secret',
      'https://user:password@zvuk.com/song.mp3', 'https://zvuk.com/song.mp3?', 'https://zvuk.com/song.mp3#',
    ]) assert.deepEqual(inspect([{ source }]), { status: 'unavailable', reason: 'private-url' }, source);
  });

  it('enforces HTTPS, exact domain suffix, no explicit ports and supported file suffixes', () => {
    for (const source of [
      'http://zvuk.com/song.mp3', 'https://evilzvuk.com/song.mp3', 'https://zvuk.com.attacker.test/song.mp3',
      'https://zvuk.com:443/song.mp3', 'https://zvuk.com:8443/song.mp3', '//zvuk.com/song.mp3',
      '/song.mp3', 'not a URL', 'https://zvuk.com/play/123', 'https://zvuk.com/song.mp3/extra',
      'https://zvuk.com/song.exe', 'https://zvuk.com/\nsong.mp3',
    ]) assert.deepEqual(inspect([{ source }]), { status: 'unavailable', reason: 'unsupported-source' }, source);
  });

  it('fails closed if a page replaces a media accessor with a throwing getter', () => {
    const dom = new JSDOM('<audio></audio>', { url: 'https://zvuk.com/' });
    try {
      const media = dom.window.document.querySelector('audio');
      assert.ok(media);
      Object.defineProperty(media, 'currentSrc', { get() { throw new Error('page getter'); } });
      assert.deepEqual(inspectDownloadSource(dom.window.document, () => false), { status: 'unavailable', reason: 'unsupported-source' });
    } finally { dom.window.close(); }
  });
});

describe('download resolution protocol validation', () => {
  it('accepts only exact ready/unavailable schemas with known reasons', () => {
    assert.equal(isDownloadResolution({ status: 'ready', url: 'https://zvuk.com/song.mp3', extension: 'mp3' }), true);
    for (const reason of ['no-track', 'track-changed', 'no-source', 'hls-source', 'multiple-sources', 'protected-media', 'stream-source', 'private-url', 'unsupported-source', 'bridge-unavailable']) {
      assert.equal(isDownloadResolution({ status: 'unavailable', reason }), true);
    }
    assert.ok(hlsFailureReasons.length > 0);
    for (const reason of hlsFailureReasons) {
      assert.equal(isDownloadResolution({ status: 'unavailable', reason }), true, reason);
      assert.equal(isDownloadResolution({ status: 'unavailable', reason, url: 'https://zvuk.com/private?token=secret' }), false, reason);
    }
  });

  it('accepts assembled m4a blobs only with a Zvuk origin and UUID object URL', () => {
    const id = 'd9199b7a-2191-41c0-a7ed-88e7ad97fa22';
    for (const origin of ['https://zvuk.com', 'https://audio.zvuk.com', 'https://cdn.audio.zvuk.com']) {
      const assembled: DownloadResolution = { status: 'assembled', url: `blob:${origin}/${id}`, extension: 'm4a' };
      assert.equal(isDownloadResolution(assembled), true, assembled.url);
      assert.equal(isDownloadResolution({ ...assembled, status: 'ready' }), false, assembled.url);
    }
  });

  it('rejects foreign, signed, malformed and data object URLs from assembled results', () => {
    const id = 'd9199b7a-2191-41c0-a7ed-88e7ad97fa22';
    const assembled: DownloadResolution = { status: 'assembled', url: `blob:https://zvuk.com/${id}`, extension: 'm4a' };
    const invalidUrls = [
      `blob:https://other.test/${id}`, `blob:https://evilzvuk.com/${id}`,
      `blob:https://zvuk.com.attacker.test/${id}`, `blob:http://zvuk.com/${id}`,
      `blob:https://user:password@zvuk.com/${id}`, `blob:https://zvuk.com:443/${id}`,
      `blob:https://zvuk.com/${id}?token=secret`, `blob:https://zvuk.com/${id}#secret`,
      `blob:https://zvuk.com/${id}/extra`, `blob:https://zvuk.com/${id}/`,
      'blob:https://zvuk.com/invalid-uuid', 'blob:https://zvuk.com/d9199b7a-2191-41c0-a7ed-88e7ad97fa2x',
      'blob:https://zvuk.com/', 'blob:null/d9199b7a-2191-41c0-a7ed-88e7ad97fa22',
      'data:audio/mp4;base64,AAAA', 'https://zvuk.com/song.m4a', '',
    ];
    for (const url of invalidUrls) {
      assert.equal(isDownloadResolution({ ...assembled, url }), false, url);
    }
    for (const value of [
      { ...assembled, extension: 'mp3' }, { ...assembled, extension: 'mp4' },
      { ...assembled, extension: undefined }, { ...assembled, url: null },
      { ...assembled, headers: { Authorization: 'secret' } },
      { ...assembled, reason: 'no-source' }, { status: 'assembled', extension: 'm4a' },
      Object.assign({ ...assembled }, { [Symbol('private')]: 'secret' }),
    ]) assert.equal(isDownloadResolution(value), false);
  });

  it('rejects extra fields, mismatched extensions and unsafe ready URLs', () => {
    for (const value of [
      null, [], {}, { status: 'unavailable', reason: 'unknown' },
      { status: 'unavailable', reason: 'no-source', url: 'https://zvuk.com/private?token=secret' },
      { status: 'ready', url: 'https://zvuk.com/song.mp3', extension: 'flac' },
      { status: 'ready', url: 'https://zvuk.com/song.mp3', extension: 'mp3', headers: { Authorization: 'secret' } },
      { status: 'ready', url: 'https://zvuk.com/song.mp3?token=secret', extension: 'mp3' },
      { status: 'ready', url: 'https://other.test/song.mp3', extension: 'mp3' },
      { status: 'ready', url: 'blob:https://zvuk.com/id', extension: 'mp3' },
      { status: 'ready', url: 'https://zvuk.com/live.m3u8', extension: 'mp3' },
    ]) assert.equal(isDownloadResolution(value), false, JSON.stringify(value));
  });
});

describe('safe download filenames', () => {
  it('uses the MusicLoader folder and public metadata', () => {
    assert.equal(createDownloadFilename(track, 'mp3'), 'MusicLoader/ARTIK & ASTI - Очень-очень.mp3');
  });

  it('removes traversal, Windows invalid characters, controls and bidi controls', () => {
    const filename = createDownloadFilename({ ...track, artist: '../../AUX\u0000<>:"/\\|?*', title: '../Song\u202e.exe. ' }, 'flac');
    assert.equal(filename, 'MusicLoader/_AUX - Song .exe.flac');
    assert.equal(filename.includes('..'), false);
    assert.equal(filename.split('/').length, 2);
    assert.doesNotMatch(filename.slice('MusicLoader/'.length), /[<>:"/\\|?*\p{Cc}\p{Cf}]/u);
  });

  it('escapes Windows reserved basenames, including NFKC normalized variants', () => {
    for (const title of ['CON', 'prn', 'AUX.txt', 'NUL', 'COM1', 'LPT9', 'COM¹', 'ＣＯＮ']) {
      const filename = createDownloadFilename({ ...track, artist: '', title }, 'wav');
      assert.match(filename, /^MusicLoader\/Неизвестный исполнитель - _/);
    }
  });

  it('bounds very long Unicode names without cutting a surrogate pair', () => {
    const filename = createDownloadFilename({ ...track, artist: '🎵'.repeat(200), title: 'Песня'.repeat(200) }, 'm4a');
    assert.ok(filename.length <= 180);
    assert.equal(filename.includes('�'), false);
    assert.match(filename, /\.m4a$/);
    assert.doesNotMatch(filename, /[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it('provides useful fallbacks and cannot inject the extension as a path', () => {
    assert.equal(createDownloadFilename({ ...track, title: '..', artist: ' ' }, 'ogg'), 'MusicLoader/Неизвестный исполнитель - Без названия.ogg');
    assert.throws(() => createDownloadFilename(track, '../evil' as DownloadExtension), /Unsupported download extension/);
  });
});
