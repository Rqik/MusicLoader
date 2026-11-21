import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const snippet = readFileSync(new URL('../scripts/collect-zvuk-diagnostics.js', import.meta.url), 'utf8');
interface DiagnosticResource {
  hostname: string | null; protocol: string; extension: string | null; basenameKind: string;
  hasQuery: boolean; queryParameterCount: number; format: string | null; mimeType: string | null;
  delivery: string; initiator: string; count: number;
}
interface ConsoleReport {
  isRunning: boolean;
  metadata: { title: string | null; artist: string | null; album: string | null; playbackState: string };
  media: Array<{ srcObjectKind: string; hasMediaKeys: boolean; resource: DiagnosticResource | null; declaredMimeType: string | null }>;
  network: { observedResources: number; audioCandidates: number; omittedResourceBuckets: number; resources: DiagnosticResource[] };
  deliveryAssessment: string;
  drm: { hasMediaKeys: boolean; hasEncryptedEvent: boolean; encryptedEvents: number; assessment: string };
  quality: { status: string; bitrate: null; sampleRate: null; bitDepth: null };
}
interface ConsoleApi { report: () => ConsoleReport; stop: () => ConsoleReport; copy: () => Promise<void> }
type ResourceEntry = { name: string; initiatorType?: string; contentType?: string };

function setup(html = '<audio></audio>', url = 'https://zvuk.com/player?private-page=secret', initialEntries: ResourceEntry[] = []) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const logs: string[] = [];
  const copied: string[] = [];
  const timers = new Map<number, { handler: () => void; delay: number }>();
  let nextTimer = 0;
  let requestCalls = 0;
  let callback: ((list: { getEntries: () => ResourceEntry[] }) => void) | undefined;
  const observers: Array<{ isDisconnected: boolean; options: unknown }> = [];
  const fetch = () => { requestCalls += 1; throw new Error('No requests allowed'); };
  const xhr = function () { requestCalls += 1; throw new Error('No XHR allowed'); };
  Object.defineProperty(window, 'fetch', { configurable: true, value: fetch });
  Object.defineProperty(window, 'XMLHttpRequest', { configurable: true, value: xhr });
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  Object.defineProperty(window.navigator, 'mediaSession', { configurable: true, value: { metadata: null, playbackState: 'none' } });
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: (handler: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { handler, delay }); return id; } });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id: number) => { timers.delete(id); } });
  Object.defineProperty(window.console, 'log', { configurable: true, value: (text: string) => { logs.push(text); } });
  Object.defineProperty(window.console, 'info', { configurable: true, value: () => {} });
  class FakeObserver {
    isDisconnected = false;
    options: unknown;
    constructor(listener: typeof callback) { callback = listener; observers.push(this); }
    observe(options: unknown) { this.options = options; }
    disconnect() { this.isDisconnected = true; }
  }
  Object.defineProperty(window, 'PerformanceObserver', { configurable: true, value: FakeObserver });
  Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true, value: () => initialEntries });
  const context = dom.getInternalVMContext();
  function run() { vm.runInContext(snippet, context); }
  function api(): ConsoleApi { return (window as unknown as { musicLoaderDiagnostics: ConsoleApi }).musicLoaderDiagnostics; }
  function feed(entries: ResourceEntry[]) { callback?.({ getEntries: () => entries }); }
  function cleanup() { api()?.stop(); dom.window.close(); }
  return { dom, window, logs, copied, timers, observers, fetch, xhr, run, api, feed, cleanup, requestCalls: () => requestCalls };
}

describe('standalone Console diagnostics', () => {
  it('reports HLS without claiming a whole MP4 song or associating cached playlists with current metadata', () => {
    const fixture = setup('');
    try {
      fixture.run();
      fixture.feed([
        { name: 'https://cdn-hls-slicer.zvuk.com/private/master.m3u8', contentType: 'application/vnd.apple.mpegurl', initiatorType: 'fetch' },
        { name: 'https://cdn-hls-slicer.zvuk.com/private/init.mp4', contentType: 'audio/mp4', initiatorType: 'fetch' },
        { name: 'https://cdn-hls-slicer.zvuk.com/private/part.m4s', contentType: 'audio/mp4', initiatorType: 'fetch' },
      ]);
      const report = fixture.api().report();
      assert.equal(report.media.length, 0);
      assert.equal(report.deliveryAssessment, 'hls-playlist-observed-current-track-unconfirmed');
      assert.equal(report.network.resources[1]!.delivery, 'file-like-resource');
      assert.equal(report.drm.assessment, 'unknown');
      assert.equal(JSON.stringify(report).includes('/private/'), false);
    } finally { fixture.cleanup(); }
  });
  it('only starts on the allowed HTTPS Zvuk domains', () => {
    for (const url of ['https://zvuk.com.attacker.test/', 'http://zvuk.com/', 'https://example.test/']) {
      const fixture = setup('', url);
      try {
        fixture.run();
        assert.equal(fixture.api(), undefined);
        assert.equal(fixture.observers.length, 0);
        assert.equal(fixture.timers.size, 0);
      } finally { fixture.cleanup(); }
    }
  });

  it('redacts resource paths, signed query values, fragment and MIME parameters', () => {
    const fixture = setup();
    try {
      fixture.run();
      fixture.feed([
        { name: 'https://cdn.zvuk.com/private-user/track.mp3?token=hidden-value&signature=hidden-signature#hidden-fragment', initiatorType: 'audio', contentType: 'audio/mpeg; secret=hidden-header' },
        { name: 'https://cdn.zvuk.com/private-user/other.mp3?token=different', initiatorType: 'audio', contentType: 'audio/mpeg' },
        { name: 'https://stream.example.test/private-route?auth=hidden-auth', initiatorType: 'fetch' },
      ]);
      const report = fixture.api().report();
      const resource = report.network.resources[0]!;
      assert.equal(resource.hostname, 'cdn.zvuk.com');
      assert.equal(resource.protocol, 'https:');
      assert.equal(resource.extension, 'mp3');
      assert.equal(resource.mimeType, 'audio/mpeg');
      assert.equal(resource.hasQuery, true);
      assert.equal(resource.queryParameterCount, 2);
      assert.equal(report.network.resources[2]!.delivery, 'unknown');
      assert.equal(report.network.resources[2]!.extension, null);
      const json = JSON.stringify(report);
      for (const secret of ['private-user', 'hidden-value', 'hidden-signature', 'hidden-fragment', 'hidden-header', 'hidden-auth', 'private-route', 'private-page']) assert.equal(json.includes(secret), false, secret);
      assert.equal(json.includes('https://'), false);
    } finally { fixture.cleanup(); }
  });

  it('does not fabricate MIME types, quality, MSE or DRM from a blob source', () => {
    const fixture = setup();
    try {
      const audio = fixture.window.document.querySelector('audio')!;
      Object.defineProperty(audio, 'currentSrc', { configurable: true, value: 'blob:https://zvuk.com/hidden-blob-id' });
      fixture.run();
      const report = fixture.api().report();
      assert.equal(report.media[0]!.resource!.delivery, 'blob');
      assert.equal(report.media[0]!.resource!.format, null);
      assert.equal(report.media[0]!.resource!.mimeType, null);
      assert.equal(report.deliveryAssessment, 'blob-observed-mse-unknown');
      assert.equal(report.drm.assessment, 'unknown');
      assert.deepEqual({ ...report.quality }, { status: 'unknown', bitrate: null, sampleRate: null, bitDepth: null });
      assert.equal(JSON.stringify(report).includes('hidden-blob-id'), false);
    } finally { fixture.cleanup(); }
  });

  it('reports direct MediaSource/EME indicators without inspecting encrypted event data', () => {
    const fixture = setup();
    try {
      class MediaSource {}
      Object.defineProperty(fixture.window, 'MediaSource', { configurable: true, value: MediaSource });
      const audio = fixture.window.document.querySelector('audio')!;
      Object.defineProperty(audio, 'srcObject', { configurable: true, value: new MediaSource() });
      Object.defineProperty(audio, 'mediaKeys', { configurable: true, value: {} });
      fixture.run();
      audio.dispatchEvent(new fixture.window.Event('encrypted', { bubbles: false }));
      const report = fixture.api().report();
      assert.equal(report.deliveryAssessment, 'media-source-object-observed');
      assert.equal(report.drm.hasMediaKeys, true);
      assert.equal(report.drm.hasEncryptedEvent, true);
      assert.equal(report.drm.encryptedEvents, 1);
    } finally { fixture.cleanup(); }
  });

  it('reads only bounded public Media Session fields and strips URL-shaped metadata text', () => {
    const fixture = setup();
    try {
      const metadata = { title: '  Очень-очень  ', artist: 'ARTIK & ASTI', album: '#РайОдинНаДвоих https://signed.test/path?token=hidden' };
      Object.defineProperty(metadata, 'artwork', { get() { throw new Error('Artwork must not be read'); } });
      Object.defineProperty(fixture.window.navigator, 'mediaSession', { configurable: true, value: { metadata, playbackState: 'playing' } });
      fixture.run();
      const report = fixture.api().report();
      assert.equal(report.metadata.title, 'Очень-очень');
      assert.equal(report.metadata.artist, 'ARTIK & ASTI');
      assert.equal(report.metadata.album, '#РайОдинНаДвоих [URL removed]');
      assert.equal(report.metadata.playbackState, 'playing');
      assert.equal(JSON.stringify(report).includes('token'), false);
    } finally { fixture.cleanup(); }
  });

  it('replaces a previous run and releases observer, capture listener and timer', () => {
    const fixture = setup();
    try {
      fixture.run();
      const previous = fixture.api();
      assert.equal(fixture.timers.size, 1);
      fixture.run();
      assert.equal(previous.report().isRunning, false);
      assert.equal(fixture.observers[0]!.isDisconnected, true);
      assert.equal(fixture.observers[1]!.isDisconnected, false);
      assert.equal(fixture.timers.size, 1);
      fixture.window.document.querySelector('audio')!.dispatchEvent(new fixture.window.Event('encrypted'));
      assert.equal(previous.report().drm.encryptedEvents, 0);
      assert.equal(fixture.api().report().drm.encryptedEvents, 1);
      fixture.api().stop();
      assert.equal(fixture.observers[1]!.isDisconnected, true);
      assert.equal(fixture.timers.size, 0);
    } finally { fixture.cleanup(); }
  });

  it('stops automatically after 60 seconds or when the page is hidden', () => {
    const fixture = setup();
    try {
      fixture.run();
      const timeout = [...fixture.timers.values()][0]!;
      assert.equal(timeout.delay, 60_000);
      timeout.handler();
      assert.equal(fixture.api().report().isRunning, false);
      assert.equal(fixture.timers.size, 0);
      fixture.run();
      fixture.window.dispatchEvent(new fixture.window.Event('pagehide'));
      assert.equal(fixture.api().report().isRunning, false);
      assert.equal(fixture.observers.at(-1)!.isDisconnected, true);
    } finally { fixture.cleanup(); }
  });

  it('bounds observed resources, resource buckets, media and query counters', () => {
    const fixture = setup('<audio></audio>'.repeat(20));
    try {
      fixture.run();
      const entries = Array.from({ length: 700 }, (_, index) => ({ name: `https://cdn${index}.example.test/file.mp3${index === 200 ? `?${'a=x&'.repeat(200)}` : ''}`, initiatorType: 'audio' }));
      fixture.feed(entries);
      assert.equal(fixture.api().report().network.observedResources, 500);
      assert.equal(fixture.api().report().network.resources.length, 64);
      assert.equal(fixture.api().report().network.resources[0]!.queryParameterCount, 100);
      assert.equal(fixture.api().report().media.length, 10);
      const repeatedEntries = Array.from({ length: 500 }, () => ({ name: 'https://cdn200.example.test/file.mp3', initiatorType: 'audio' }));
      for (let count = 0; count < 30; count += 1) fixture.feed(repeatedEntries);
      const report = fixture.api().report();
      assert.equal(report.network.observedResources, 10_000);
      assert.equal(report.network.resources.length, 64);
      assert.ok(report.network.omittedResourceBuckets <= 10_000);
    } finally { fixture.cleanup(); }
  });

  it('never sends requests or overrides network APIs and only copies after explicit invocation', async () => {
    const fixture = setup();
    try {
      fixture.run();
      fixture.feed([{ name: 'https://cdn.example.test/audio.aac?token=never-copy-me', initiatorType: 'fetch' }]);
      fixture.api().report();
      assert.equal(fixture.requestCalls(), 0);
      assert.equal(fixture.window.fetch, fixture.fetch);
      assert.equal(fixture.window.XMLHttpRequest, fixture.xhr);
      assert.equal(fixture.copied.length, 0);
      await fixture.api().copy();
      assert.equal(fixture.copied.length, 1);
      assert.equal(fixture.copied[0]!.includes('never-copy-me'), false);
      assert.equal(fixture.copied[0]!.includes('https://'), false);
      fixture.api().stop();
      assert.equal(fixture.requestCalls(), 0);
      for (const log of fixture.logs) assert.doesNotThrow(() => JSON.parse(log));
    } finally { fixture.cleanup(); }
  });
});
