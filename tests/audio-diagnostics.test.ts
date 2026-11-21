import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { createAudioDiagnostics, hasObservedZvukHls, summarizeAudioResource } from '../src/features/diagnostics/observe-audio';

describe('audio resource hints', () => {
  it('recognizes observed Zvuk HLS without treating an MP4 fragment as a playlist', () => {
    assert.equal(hasObservedZvukHls([{ name: 'https://cdn-hls-slicer.zvuk.com/private/manifest.m3u8?token=secret' }]), true);
    for (const name of ['https://cdn-hls-slicer.zvuk.com/init.mp4', 'https://zvuk.com/not-hls?file=playlist.m3u8', 'https://zvuk.com.attacker.test/song.m3u8', 'http://zvuk.com/song.m3u8', 'https://user:pass@zvuk.com/song.m3u8', 'invalid']) {
      assert.equal(hasObservedZvukHls([{ name }]), false, name);
    }
    assert.equal(hasObservedZvukHls([{ name: 'https://zvuk.com/old.m3u8' }, ...Array.from({ length: 500 }, () => ({ name: 'https://zvuk.com/image.png' }))]), false);
  });
  it('returns only enum hints and never signed URLs or MIME parameters', () => {
    const hints = summarizeAudioResource('https://secret.cdn.test/private/user/track.FLAC?token=do-not-store#signature', 'audio/flac; token=do-not-store');
    assert.deepEqual(hints, { format: 'flac', delivery: 'file', mimeType: 'audio/flac' });
    assert.equal(/secret|private|token|signature/.test(JSON.stringify(hints)), false);
  });

  it('does not invent MIME types from a file extension', () => {
    assert.deepEqual(summarizeAudioResource('https://cdn.test/audio.mp3?key=1'), { format: 'mp3', delivery: 'file', mimeType: null });
    assert.deepEqual(summarizeAudioResource('https://cdn.test/stream?key=1'), { format: null, delivery: null, mimeType: null });
    assert.deepEqual(summarizeAudioResource('https://cdn.test/stream?format=flac'), { format: null, delivery: null, mimeType: null });
  });

  it('recognizes observed MIME types and sanitizes unsupported MIME values', () => {
    assert.deepEqual(summarizeAudioResource('https://cdn.test/stream', ' Audio/AAC ; codecs=mp4a.40.2'), { format: 'aac', delivery: 'file', mimeType: 'audio/aac' });
    assert.deepEqual(summarizeAudioResource('https://cdn.test/stream', 'audio/private-auth-token'), { format: null, delivery: null, mimeType: null });
    assert.deepEqual(summarizeAudioResource('https://cdn.test/stream', 'application/octet-stream'), { format: null, delivery: null, mimeType: 'application/octet-stream' });
  });

  it('distinguishes playlists, segments and blob hints without claiming MSE', () => {
    assert.equal(summarizeAudioResource('https://cdn.test/live.m3u8').delivery, 'hls');
    assert.equal(summarizeAudioResource('https://cdn.test/live.mpd').delivery, 'dash');
    assert.equal(summarizeAudioResource('https://cdn.test/part.m4s').delivery, 'segments');
    assert.equal(summarizeAudioResource('https://cdn.test/script.ts').delivery, null);
    assert.deepEqual(summarizeAudioResource('blob:https://zvuk.com/private-id'), { format: null, delivery: 'blob', mimeType: null });
  });

  it('rejects invalid URLs and executable/data schemes', () => {
    for (const url of ['invalid', '/track.flac', 'data:audio/flac;base64,private', 'javascript:private.mp3']) {
      assert.deepEqual(summarizeAudioResource(url, 'audio/flac'), { format: null, delivery: null, mimeType: null });
    }
  });
});

function withDocument(html: string, action: (window: JSDOM['window']) => void, entries: PerformanceEntry[] = []) {
  const dom = new JSDOM(html, { url: 'https://zvuk.com/' });
  const descriptors = new Map(['document', 'performance', 'PerformanceObserver'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { getEntriesByType: () => entries } });
  Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, value: undefined });
  try { action(dom.window); } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

describe('opt-in audio observation', () => {
  it('detects current media, ignores unused source declarations and cleans encrypted listeners', () => {
    withDocument('<audio><source src="https://cdn.test/not-playing.flac" type="audio/flac"><source src="https://cdn.test/current" type="audio/aac"></audio>', (window) => {
      const audio = window.document.querySelector('audio')!;
      Object.defineProperty(audio, 'currentSrc', { configurable: true, value: 'https://cdn.test/current' });
      const diagnostics = createAudioDiagnostics();
      assert.deepEqual(diagnostics.read().formats, ['aac']);
      assert.equal(diagnostics.read().hasEncryptedEvent, false);
      assert.equal(diagnostics.read().quality, null);
      audio.dispatchEvent(new window.Event('encrypted'));
      assert.equal(diagnostics.read().hasEncryptedEvent, true);
      diagnostics.dispose();
      diagnostics.dispose();
      assert.deepEqual(diagnostics.read().formats, ['aac']);
    });
  });

  it('records EME/blob indicators without reporting a codec, DRM system or quality', () => {
    withDocument('<audio></audio>', (window) => {
      const audio = window.document.querySelector('audio')!;
      Object.defineProperty(audio, 'currentSrc', { configurable: true, value: 'blob:https://zvuk.com/secret-id' });
      Object.defineProperty(audio, 'mediaKeys', { configurable: true, value: {} });
      const diagnostics = createAudioDiagnostics();
      const report = diagnostics.read();
      assert.deepEqual(report.formats, []);
      assert.deepEqual(report.mimeTypes, []);
      assert.deepEqual(report.delivery, ['blob']);
      assert.equal(report.hasMediaKeys, true);
      assert.equal(report.hasEncryptedEvent, false);
      assert.equal(report.quality, null);
      assert.equal(JSON.stringify(report).includes('secret'), false);
      diagnostics.dispose();
    });
  });

  it('removes listeners from detached elements and observes no more than ten media elements', () => {
    withDocument(Array.from({ length: 11 }, () => '<audio></audio>').join(''), (window) => {
      const elements = [...window.document.querySelectorAll('audio')];
      const diagnostics = createAudioDiagnostics();
      diagnostics.read();
      elements[10]!.dispatchEvent(new window.Event('encrypted'));
      assert.equal(diagnostics.read().hasEncryptedEvent, false);
      const removed = elements[0]!;
      removed.remove();
      diagnostics.read();
      removed.dispatchEvent(new window.Event('encrypted'));
      assert.equal(diagnostics.read().hasEncryptedEvent, false);
      diagnostics.dispose();
      elements[1]!.dispatchEvent(new window.Event('encrypted'));
      assert.equal(diagnostics.read().hasEncryptedEvent, false);
    });
  });

  it('bounds performance history and does not recount entries on each read', () => {
    const entries = Array.from({ length: 800 }, (_, index) => ({ name: `https://cdn.test/${index}.mp3?token=secret`, entryType: 'resource' }) as PerformanceEntry);
    withDocument('', () => {
      const diagnostics = createAudioDiagnostics();
      const first = diagnostics.read();
      assert.equal(first.resourceCount, 500);
      assert.deepEqual(first.mimeTypes, []);
      assert.equal(diagnostics.read().resourceCount, 500);
      assert.equal(JSON.stringify(first).includes('token'), false);
      diagnostics.dispose();
    }, entries);
  });

  it('observes buffered resources once, caps counters and disconnects the observer', () => {
    withDocument('', () => {
      let callback: PerformanceObserverCallback | undefined;
      let isDisconnected = false;
      let options: PerformanceObserverInit | undefined;
      class FakePerformanceObserver {
        constructor(listener: PerformanceObserverCallback) { callback = listener; }
        observe(value: PerformanceObserverInit) { options = value; }
        disconnect() { isDisconnected = true; }
      }
      Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, value: FakePerformanceObserver });
      const diagnostics = createAudioDiagnostics();
      assert.deepEqual(options, { type: 'resource', buffered: true });
      const entries = Array.from({ length: 600 }, () => ({ name: 'https://cdn.test/audio', contentType: 'audio/mpeg; token=private', entryType: 'resource' }));
      const list = { getEntries: () => entries } as unknown as PerformanceObserverEntryList;
      for (let count = 0; count < 25; count += 1) callback!(list, {} as PerformanceObserver);
      assert.equal(diagnostics.read().resourceCount, 10_000);
      assert.deepEqual(diagnostics.read().mimeTypes, ['audio/mpeg']);
      diagnostics.dispose();
      assert.equal(isDisconnected, true);
    });
  });
});
