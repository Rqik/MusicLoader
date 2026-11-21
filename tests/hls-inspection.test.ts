import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const snippet = readFileSync(new URL('../scripts/inspect-zvuk-hls.js', import.meta.url), 'utf8');
const observedUrl = 'https://cdn-hls-slicer.zvuk.com/private-observed-path/playlist.m3u8';
interface Manifest {
  kind: string;
  variantCount: number;
  variants: Array<{ declaredBandwidth: number | null; declaredAverageBandwidth: number | null; codecs: string[] }>;
  mediaTagCount: number; mediaTypes: string[]; segmentCount: number; declaredDurationSeconds: number;
  hasEndList: boolean; declaredPlaylistType: string; mapCount: number; byteRangeCount: number; mapByteRangeCount: number;
  discontinuityCount: number;
  encryption: { keyCount: number; sessionKeyCount: number; methods: string[]; keyFormats: string[]; assessment: string };
}
interface HlsReport {
  version: number;
  status: string; isRunning: boolean; candidateCount: number; metadataStableDuringInspection: boolean | null;
  completionReason: string | null;
  discovery: {
    isOpen: boolean; observerMode: string; endedReason: string | null;
    historyEntryCount: number; historyAvailable: boolean; historyWasTruncated: boolean; historyAtBufferCapacity: boolean | null;
    observationCount: number; hlsObservationCount: number; acceptedCount: number; duplicateCount: number;
    skipped: Record<string, number>; observedHlsHostnames: string[]; observationLimitReached: boolean;
  };
  currentPlaylistAssociation: string;
  hasUniqueTrackId: boolean;
  trackIdentityStableDuringInspection: boolean | null;
  playlists: Array<{ index: number; observationStartTime: number | null; observedVia: string; metadataAtObservation: { title: string | null; artist: string | null; album: string | null }; currentPlaylistAssociation: string; matchesCurrentTrackIdInPath: boolean | null; status: string; httpStatus: number | null; manifest: Manifest | null }>;
}
interface HlsApi { version: number; report: () => HlsReport; stop: () => HlsReport; done: Promise<HlsReport> }
type Entry = { name: string; startTime?: number; contentType?: string };
type FetchOptions = { method: string; mode: string; credentials: string; redirect: string; referrerPolicy: string; cache: string; signal: AbortSignal };
type Reply = { ok: boolean; status?: number; body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void>; releaseLock: () => void }; cancel?: () => Promise<void> } | null };

function setup(entries: Entry[] = [{ name: observedUrl, startTime: 321.1234 }], contents = '#EXTM3U\n#EXTINF:3,private title\nprivate-segment.m4s\n#EXT-X-ENDLIST') {
  const dom = new JSDOM('', { url: 'https://zvuk.com/private-page?token=do-not-log', runScripts: 'outside-only' });
  const { window } = dom;
  const timers = new Map<number, { handler: () => void; delay: number; at: number }>();
  const intervals = new Map<number, { handler: () => void; delay: number }>();
  const observers: Array<{ isDisconnected: boolean; options: unknown; listener: (entries: { getEntries: () => Entry[] }) => void }> = [];
  const requests: Array<{ url: string; options: FetchOptions; startedAt: number }> = [];
  const logs: string[] = [];
  let nextTimer = 0;
  let now = 0;
  let cancelledReaders = 0;
  let releasedReaders = 0;
  let fetchReply: (url: string, options: FetchOptions) => Promise<Reply> = async () => response(contents);
  function response(text: string, chunks?: Uint8Array[]): Reply {
    const bytes = chunks ?? [new TextEncoder().encode(text)];
    let index = 0;
    let isCancelled = false;
    return { ok: true, status: 200, body: {
      getReader: () => ({
        read: async () => isCancelled || index >= bytes.length ? { done: true } : { done: false, value: bytes[index++]! },
        cancel: async () => { isCancelled = true; cancelledReaders += 1; },
        releaseLock: () => { releasedReaders += 1; },
      }),
      cancel: async () => { isCancelled = true; cancelledReaders += 1; },
    } };
  }
  Object.defineProperty(window.navigator, 'mediaSession', { configurable: true, value: { metadata: { title: 'Очень-очень', artist: 'ARTIK & ASTI', album: '#РайОдинНаДвоих' } } });
  Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true, value: () => entries });
  Object.defineProperty(window.performance, 'now', { configurable: true, value: () => now });
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: (handler: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { handler, delay, at: now + delay }); return id; } });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id: number) => { timers.delete(id); } });
  Object.defineProperty(window, 'setInterval', { configurable: true, value: (handler: () => void, delay: number) => { const id = ++nextTimer; intervals.set(id, { handler, delay }); return id; } });
  Object.defineProperty(window, 'clearInterval', { configurable: true, value: (id: number) => { intervals.delete(id); } });
  class FakePerformanceObserver {
    isDisconnected = false;
    options: unknown;
    constructor(readonly listener: (entries: { getEntries: () => Entry[] }) => void) { observers.push(this); }
    observe(options: unknown) { this.options = options; }
    disconnect() { this.isDisconnected = true; }
  }
  Object.defineProperty(window, 'PerformanceObserver', { configurable: true, value: FakePerformanceObserver });
  Object.defineProperty(window, 'TextDecoder', { configurable: true, value: TextDecoder });
  Object.defineProperty(window, 'fetch', { configurable: true, value: async (url: string, options: FetchOptions) => { requests.push({ url, options, startedAt: now }); return fetchReply(url, options); } });
  Object.defineProperty(window.console, 'log', { configurable: true, value: (text: string) => { logs.push(text); } });
  Object.defineProperty(window.console, 'info', { configurable: true, value: () => {} });
  const context = dom.getInternalVMContext();
  function api(): HlsApi { return (window as unknown as { musicLoaderHlsReport: HlsApi }).musicLoaderHlsReport; }
  function run() { vm.runInContext(snippet, context); }
  function finishDiscovery() { [...timers.values()].find((timer) => timer.delay === 15000)?.handler(); }
  async function advance(ms: number) {
    const target = now + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].handler();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    now = target;
  }
  async function done() {
    // Остальные тесты проверяют парсер/requests; завершаем их fake capture window явно.
    finishDiscovery();
    for (let iteration = 0; iteration < 20 && api().report().isRunning; iteration += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const timer = [...timers.values()].find((entry) => entry.delay <= 300);
      if (!timer) break;
      await advance(Math.max(0, timer.at - now));
    }
    return JSON.parse(JSON.stringify(await api().done)) as HlsReport;
  }
  function feed(observed: Entry[]) {
    for (const observer of observers) if (!observer.isDisconnected) observer.listener({ getEntries: () => observed });
  }
  return {
    dom, window, timers, intervals, observers, requests, logs, response, run, api, done, feed, finishDiscovery, advance,
    setReply: (reply: typeof fetchReply) => { fetchReply = reply; },
    cancelledReaders: () => cancelledReaders, releasedReaders: () => releasedReaders,
    cleanup: () => { api()?.stop(); dom.window.close(); },
  };
}

describe('HLS playlist inspection', () => {
  it('spaces manifest request starts by at least 300 ms even when replies are immediate', async () => {
    const fixture = setup(Array.from({ length: 4 }, (_, index) => ({ name: `https://cdn-hls-slicer.zvuk.com/paced-${index}.m3u8` })));
    try {
      fixture.run();
      assert.equal(fixture.requests.length, 1);
      await fixture.advance(299);
      assert.equal(fixture.requests.length, 1);
      await fixture.advance(1);
      assert.equal(fixture.requests.length, 2);
      await fixture.advance(600);
      const report = await fixture.done();
      assert.deepEqual(fixture.requests.map((request) => request.startedAt), [0, 300, 600, 900]);
      assert.equal(report.playlists.every((item) => item.status === 'inspected'), true);
      assert.equal(fixture.timers.size, 0);
    } finally { fixture.cleanup(); }
  });

  it('starts each five-second request timeout after pacing and removes queued starts on stop', async () => {
    const fixture = setup(Array.from({ length: 3 }, (_, index) => ({ name: `https://cdn-hls-slicer.zvuk.com/pending-${index}.m3u8` })));
    try {
      fixture.setReply(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })));
      fixture.run();
      assert.equal([...fixture.timers.values()].filter((timer) => timer.delay === 5000).length, 1);
      await fixture.advance(299);
      assert.equal(fixture.requests.length, 1);
      await fixture.advance(1);
      assert.deepEqual([...fixture.timers.values()].filter((timer) => timer.delay === 5000).map((timer) => timer.at), [5000, 5300]);
      fixture.api().stop();
      await fixture.done();
      await fixture.advance(1000);
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.requests.every((request) => request.options.signal.aborted), true);
      assert.equal(fixture.timers.size, 0);
    } finally { fixture.cleanup(); }
  });

  it('cancels a pending paced request before it reaches the network', async () => {
    const fixture = setup(Array.from({ length: 2 }, (_, index) => ({ name: `https://cdn-hls-slicer.zvuk.com/cancel-${index}.m3u8` })));
    try {
      fixture.run();
      assert.equal(fixture.requests.length, 1);
      assert.ok([...fixture.timers.values()].some((timer) => timer.delay === 300));
      fixture.api().stop();
      const report = await fixture.done();
      await fixture.advance(1000);
      assert.equal(fixture.requests.length, 1);
      assert.equal(report.playlists.every((item) => item.status === 'stopped'), true);
      assert.equal(fixture.timers.size, 0);
    } finally { fixture.cleanup(); }
  });

  it('keeps an empty history capture open and discovers a later live playlist with its observation metadata', async () => {
    const fixture = setup([]);
    try {
      fixture.run();
      let isSettled = false;
      void fixture.api().done.then(() => { isSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fixture.api().version, 2);
      assert.equal(fixture.api().report().version, 2);
      assert.equal(fixture.api().report().isRunning, true);
      assert.equal(fixture.api().report().candidateCount, 0);
      assert.equal(fixture.api().report().discovery.historyEntryCount, 0);
      assert.equal(fixture.api().report().discovery.observerMode, 'performance-observer');
      assert.equal(isSettled, false);
      Object.defineProperty(fixture.window.navigator, 'mediaSession', { configurable: true, value: { metadata: { title: 'Следующая песня', artist: 'Новый исполнитель', album: 'Новый альбом' } } });
      fixture.feed([{ name: observedUrl, startTime: 456.75 }]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fixture.requests.length, 1);
      assert.equal(isSettled, false);
      const report = await fixture.done();
      assert.equal(report.playlists[0]!.observedVia, 'observer');
      assert.equal(report.playlists[0]!.metadataAtObservation.title, 'Следующая песня');
      assert.equal(report.playlists[0]!.observationStartTime, 456.75);
      assert.equal(report.playlists[0]!.currentPlaylistAssociation, 'unconfirmed');
      assert.equal(report.discovery.endedReason, 'capture-window-elapsed');
      assert.equal(fixture.observers[0]!.isDisconnected, true);
    } finally { fixture.cleanup(); }
  });

  it('deduplicates buffered history and its own observed fetch without starting a request loop', async () => {
    const fixture = setup([]);
    try {
      fixture.setReply(async (url) => {
        fixture.feed([{ name: url, startTime: 90 }]);
        return fixture.response('#EXTM3U\n#EXTINF:2,\nprivate.m4s');
      });
      fixture.run();
      fixture.feed([{ name: observedUrl, startTime: 89 }]);
      fixture.feed([{ name: observedUrl, startTime: 89 }]);
      const report = await fixture.done();
      assert.equal(report.candidateCount, 1);
      assert.equal(fixture.requests.length, 1);
      assert.equal(report.discovery.acceptedCount, 1);
      assert.equal(report.discovery.duplicateCount, 2);
      assert.equal(report.discovery.hlsObservationCount, 3);
      assert.equal(report.discovery.observationCount, 3);
    } finally { fixture.cleanup(); }
  });

  it('explains rejected observations with bounded enum counters without exposing URL components', async () => {
    const fixture = setup([
      { name: 'https://other.example.test/private-host.m3u8' },
      { name: 'https://cdn-hls-slicer.zvuk.com/private-query.m3u8?token=hidden-query' },
      { name: 'https://cdn-hls-slicer.zvuk.com/private-fragment.m3u8#hidden-fragment' },
      { name: 'https://hidden-user:hidden-password@cdn-hls-slicer.zvuk.com/private-credentials.m3u8' },
      { name: 'https://cdn-hls-slicer.zvuk.com:443/private-port.m3u8' },
      { name: 'http://cdn-hls-slicer.zvuk.com/private-protocol.m3u8' },
      { name: 'https://cdn-hls-slicer.zvuk.com/private-extension.mp4', contentType: 'application/vnd.apple.mpegurl' },
      { name: 'malformed-hidden-url' },
    ]);
    try {
      fixture.run();
      assert.equal(fixture.api().report().isRunning, true);
      const report = await fixture.done();
      assert.equal(report.candidateCount, 0);
      assert.equal(report.discovery.historyEntryCount, 8);
      assert.equal(report.discovery.observationCount, 8);
      assert.equal(report.discovery.hlsObservationCount, 7);
      assert.deepEqual(report.discovery.skipped, { host: 1, query: 1, fragment: 1, credentials: 1, port: 1, protocol: 1, extension: 1, malformed: 1, 'candidate-limit': 0 });
      assert.deepEqual(report.discovery.observedHlsHostnames.sort(), ['cdn-hls-slicer.zvuk.com', 'other.example.test']);
      assert.equal(fixture.requests.length, 0);
      const json = JSON.stringify(report);
      for (const secret of ['private-host', 'private-query', 'hidden-query', 'hidden-fragment', 'hidden-user', 'hidden-password', 'private-port', 'private-protocol', 'private-extension', 'malformed-hidden']) assert.equal(json.includes(secret), false, secret);
      assert.equal(json.includes('https://'), false);
    } finally { fixture.cleanup(); }
  });

  it('uses bounded history polling when resource observation is unavailable and removes the interval', async () => {
    const entries: Entry[] = [];
    const fixture = setup(entries);
    try {
      Object.defineProperty(fixture.window, 'PerformanceObserver', { configurable: true, value: undefined });
      fixture.run();
      assert.equal(fixture.api().report().discovery.observerMode, 'polling');
      assert.equal(fixture.intervals.size, 1);
      const interval = [...fixture.intervals.values()][0]!;
      assert.equal(interval.delay, 1000);
      entries.push({ name: observedUrl, startTime: 10 });
      interval.handler();
      const report = await fixture.done();
      assert.equal(report.playlists[0]!.observedVia, 'polling');
      assert.equal(report.candidateCount, 1);
      assert.equal(fixture.intervals.size, 0);
      entries.push({ name: 'https://cdn-hls-slicer.zvuk.com/later.m3u8' });
      interval.handler();
      assert.equal(fixture.requests.length, 1);
    } finally { fixture.cleanup(); }
  });

  it('closes discovery after fifteen seconds but drains queued requests before settling done', async () => {
    const fixture = setup([]);
    const resolvers: Array<(reply: Reply) => void> = [];
    try {
      fixture.setReply(async () => new Promise<Reply>((resolve) => { resolvers.push(resolve); }));
      fixture.run();
      fixture.feed(Array.from({ length: 3 }, (_, index) => ({ name: `https://cdn-hls-slicer.zvuk.com/private-${index}.m3u8` })));
      await fixture.advance(300);
      assert.equal(fixture.requests.length, 2);
      let isSettled = false;
      void fixture.api().done.then(() => { isSettled = true; });
      const lateCallback = fixture.observers[0]!.listener;
      fixture.finishDiscovery();
      assert.equal(fixture.api().report().status, 'draining');
      assert.equal(fixture.observers[0]!.isDisconnected, true);
      lateCallback({ getEntries: () => [{ name: 'https://cdn-hls-slicer.zvuk.com/after-window.m3u8' }] });
      assert.equal(fixture.api().report().candidateCount, 3);
      resolvers.shift()!(fixture.response('#EXTM3U\n#EXTINF:2,\nprivate.m4s'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await fixture.advance(300);
      assert.equal(fixture.requests.length, 3);
      assert.equal(isSettled, false);
      for (const resolve of resolvers) resolve(fixture.response('#EXTM3U\n#EXTINF:2,\nprivate.m4s'));
      const report = await fixture.done();
      assert.equal(report.status, 'completed');
      assert.equal(report.completionReason, 'drained');
      assert.equal(report.playlists.every((item) => item.status === 'inspected'), true);
      assert.equal(fixture.timers.size, 0);
    } finally { fixture.cleanup(); }
  });

  it('bounds discovery counters and hostnames and marks unknown browser buffer capacity honestly', async () => {
    const entries = Array.from({ length: 600 }, (_, index) => ({ name: `https://host${index}.example.test/private-${index}.m3u8` }));
    const fixture = setup(entries);
    try {
      fixture.run();
      assert.equal(fixture.api().report().discovery.historyEntryCount, 600);
      assert.equal(fixture.api().report().discovery.historyWasTruncated, true);
      assert.equal(fixture.api().report().discovery.historyAtBufferCapacity, null);
      for (let batch = 0; batch < 30; batch += 1) fixture.feed(entries);
      const report = await fixture.done();
      assert.equal(report.discovery.observationCount, 10_000);
      assert.equal(report.discovery.hlsObservationCount, 10_000);
      assert.equal(report.discovery.skipped.host, 10_000);
      assert.equal(report.discovery.observationLimitReached, true);
      assert.equal(report.discovery.observedHlsHostnames.length, 8);
      assert.equal(fixture.requests.length, 0);
    } finally { fixture.cleanup(); }
  });

  it('reports a numeric HTTP status for generic request failures without headers or response bodies', async () => {
    const fixture = setup();
    try {
      fixture.setReply(async () => ({ ...fixture.response('private-response-body'), ok: false, status: 403 }));
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.playlists[0]!.status, 'request-failed');
      assert.equal(report.playlists[0]!.httpStatus, 403);
      assert.equal(JSON.stringify(report).includes('private-response-body'), false);
      assert.equal(fixture.cancelledReaders(), 1);
    } finally { fixture.cleanup(); }
  });

  it('parses master variants as declared bandwidth and whitelisted codecs without following URIs', async () => {
    const fixture = setup(undefined, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="private-group",NAME="private-name",URI="https://private.test/audio.m3u8?token=secret"\n#EXT-X-STREAM-INF:BANDWIDTH=256000,AVERAGE-BANDWIDTH=224000,CODECS="mp4a.40.2,avc1.640029"\nhttps://private.test/child.m3u8?token=secret\n#EXT-X-STREAM-INF:BANDWIDTH=99999999999999,CODECS="fLaC,alac,opus,private-codec,mp4a.40.34"\nprivate-second.m3u8');
    try {
      fixture.run();
      const report = await fixture.done();
      const manifest = report.playlists[0]!.manifest!;
      assert.equal(manifest.kind, 'master');
      assert.equal(manifest.variantCount, 2);
      assert.deepEqual(manifest.variants[0], { declaredBandwidth: 256000, declaredAverageBandwidth: 224000, codecs: ['aac-lc', 'avc'] });
      assert.equal(manifest.variants[1]!.declaredBandwidth, null);
      assert.deepEqual(manifest.variants[1]!.codecs, ['flac', 'alac', 'opus', 'unknown']);
      assert.equal(manifest.mediaTagCount, 1);
      assert.deepEqual(manifest.mediaTypes, ['audio']);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.requests[0]!.url, observedUrl);
      const json = JSON.stringify(report);
      for (const hidden of ['private-group', 'private-name', 'private-codec', 'private.test', 'private-second', 'private-observed-path', 'token=secret']) assert.equal(json.includes(hidden), false, hidden);
    } finally { fixture.cleanup(); }
  });

  it('parses finite media structure without treating init MP4 or segments as a complete song', async () => {
    const fixture = setup(undefined, '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="private-init.mp4",BYTERANGE="500@0"\n#EXTINF:3.125,private-title\nprivate-1.m4s\n#EXT-X-BYTERANGE:1000@500\n#EXT-X-DISCONTINUITY\n#EXTINF:4.5,\nprivate-2.m4s\n#EXT-X-ENDLIST');
    try {
      fixture.run();
      const report = await fixture.done();
      const manifest = report.playlists[0]!.manifest!;
      assert.equal(manifest.kind, 'media');
      assert.equal(manifest.segmentCount, 2);
      assert.equal(manifest.declaredDurationSeconds, 7.625);
      assert.equal(manifest.hasEndList, true);
      assert.equal(manifest.declaredPlaylistType, 'vod');
      assert.equal(manifest.mapCount, 1);
      assert.equal(manifest.mapByteRangeCount, 1);
      assert.equal(manifest.byteRangeCount, 1);
      assert.equal(manifest.discontinuityCount, 1);
      assert.equal(manifest.encryption.assessment, 'unknown-no-key-tags-observed');
      assert.equal(fixture.requests.length, 1);
      assert.equal(JSON.stringify(report).includes('private-init'), false);
      assert.equal(JSON.stringify(report).includes('private-title'), false);
    } finally { fixture.cleanup(); }
  });

  it('reports only known encryption method/keyformat enums and never requests keys or licenses', async () => {
    const fixture = setup(undefined, '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://private-license"\n#EXT-X-KEY:METHOD=AES-128,URI="https://secret.test/private.key",IV=0xSECRET\n#EXTINF:2,\nprivate.m4s\n#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="private-widevine"\n#EXT-X-KEY:METHOD=SECRET-METHOD,KEYFORMAT="private-format",URI="private-unknown"\n#EXT-X-KEY:METHOD=NONE');
    try {
      fixture.run();
      const report = await fixture.done();
      const encryption = report.playlists[0]!.manifest!.encryption;
      assert.equal(encryption.sessionKeyCount, 1);
      assert.equal(encryption.keyCount, 4);
      assert.deepEqual(encryption.methods, ['AES-128', 'NONE', 'SAMPLE-AES', 'SAMPLE-AES-CTR', 'unknown']);
      assert.deepEqual(encryption.keyFormats, ['fairplay', 'identity', 'unknown', 'widevine']);
      assert.equal(encryption.assessment, 'drm-signaling-observed');
      assert.equal(fixture.requests.length, 1);
      const json = JSON.stringify(report);
      for (const hidden of ['skd:', 'private-license', 'secret.test', '0xSECRET', 'SECRET-METHOD', 'private-format', 'private-widevine']) assert.equal(json.includes(hidden), false, hidden);
    } finally { fixture.cleanup(); }
  });

  it('allows only observed unsigned exact-host HTTPS playlists and deduplicates at most eight candidates', async () => {
    const invalid = [
      'http://cdn-hls-slicer.zvuk.com/a.m3u8', 'https://cdn-hls-slicer.zvuk.com:443/a.m3u8',
      'https://cdn-hls-slicer.zvuk.com:8443/a.m3u8', 'https://user:secret@cdn-hls-slicer.zvuk.com/a.m3u8',
      'https://cdn-hls-slicer.zvuk.com.attacker.test/a.m3u8', 'https://other.zvuk.com/a.m3u8',
      'https://cdn-hls-slicer.zvuk.com/a.m3u8?token=secret', 'https://cdn-hls-slicer.zvuk.com/a.m3u8#secret',
      'https://cdn-hls-slicer.zvuk.com/a.m3u8?', 'https://cdn-hls-slicer.zvuk.com/key.bin',
      'https://cdn-hls-slicer.zvuk.com/segment.m4s', 'https://cdn-hls-slicer.zvuk.com/init.mp4',
    ];
    const valid = Array.from({ length: 12 }, (_, index) => `https://cdn-hls-slicer.zvuk.com/private/${index}.m3u8`);
    const fixture = setup([...invalid.map((name) => ({ name })), { name: valid[0]! }, ...valid.map((name) => ({ name }))]);
    try {
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.candidateCount, 8);
      assert.equal(fixture.requests.length, 8);
      assert.deepEqual(fixture.requests.map((request) => request.url), valid.slice(0, 8));
      for (const request of fixture.requests) {
        assert.equal(request.options.credentials, 'omit');
        assert.equal(request.options.redirect, 'error');
        assert.equal(request.options.referrerPolicy, 'no-referrer');
        assert.equal(request.options.mode, 'cors');
        assert.equal(request.options.method, 'GET');
        assert.equal('headers' in request.options, false);
      }
      assert.equal(fixture.timers.size, 0);
    } finally { fixture.cleanup(); }
  });

  it('never associates a historical playlist with the current song and detects metadata changes', async () => {
    const fixture = setup();
    try {
      fixture.setReply(async () => {
        Object.defineProperty(fixture.window.navigator, 'mediaSession', { configurable: true, value: { metadata: { title: 'Другой трек', artist: 'Другой исполнитель', album: 'Другой альбом' } } });
        return fixture.response('#EXTM3U\n#EXTINF:2,\nprivate.m4s');
      });
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.metadataStableDuringInspection, false);
      assert.equal(report.currentPlaylistAssociation, 'unconfirmed');
      assert.equal(report.playlists[0]!.currentPlaylistAssociation, 'unconfirmed');
      assert.equal(report.playlists[0]!.observationStartTime, 321.123);
    } finally { fixture.cleanup(); }
  });

  it('caps manifest reading at 128 KiB and cancels the reader without parsing oversized contents', async () => {
    const fixture = setup();
    try {
      fixture.setReply(async () => fixture.response('', [new Uint8Array(128 * 1024), new Uint8Array(1)]));
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.playlists[0]!.status, 'size-limit');
      assert.equal(report.playlists[0]!.manifest, null);
      assert.equal(fixture.cancelledReaders(), 1);
      assert.equal(fixture.releasedReaders(), 1);
    } finally { fixture.cleanup(); }
  });

  it('uses a unique nearby title/artist DOM identity only as a numeric-boundary path hint', async () => {
    const fixture = setup([
      { name: 'https://cdn-hls-slicer.zvuk.com/private/81400222/master.m3u8' },
      { name: 'https://cdn-hls-slicer.zvuk.com/private/1814002223/master.m3u8' },
    ]);
    try {
      fixture.window.document.body.innerHTML = '<a href="/track/999">Другой трек</a><footer><div><a href="/track/81400222"><p title="Очень-очень">Очень-очень</p></a><span>ARTIK &amp; ASTI</span></div></footer>';
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.hasUniqueTrackId, true);
      assert.equal(report.trackIdentityStableDuringInspection, true);
      assert.equal(report.playlists[0]!.matchesCurrentTrackIdInPath, true);
      assert.equal(report.playlists[1]!.matchesCurrentTrackIdInPath, false);
      assert.equal(report.playlists[0]!.currentPlaylistAssociation, 'unconfirmed');
      assert.equal(JSON.stringify(report).includes('81400222'), false);
    } finally { fixture.cleanup(); }
  });

  it('leaves DOM identity unknown when matching track links have different IDs', async () => {
    const fixture = setup();
    try {
      fixture.window.document.body.innerHTML = '<footer><div><a href="/track/81400222">Очень-очень</a><span>ARTIK &amp; ASTI</span></div><div><a href="/track/123456">Очень-очень</a><span>ARTIK &amp; ASTI</span></div></footer>';
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.hasUniqueTrackId, false);
      assert.equal(report.playlists[0]!.matchesCurrentTrackIdInPath, null);
      assert.equal(report.trackIdentityStableDuringInspection, null);
    } finally { fixture.cleanup(); }
  });

  it('matches comma-separated artists rendered as separate inline links and text nodes', async () => {
    const fixture = setup([{ name: 'https://cdn-hls-slicer.zvuk.com/private/81400222/master.m3u8' }]);
    try {
      Object.defineProperty(fixture.window.navigator, 'mediaSession', { configurable: true, value: { metadata: { title: 'Очень-очень', artist: 'Alice, Bob', album: 'Album' } } });
      fixture.window.document.body.innerHTML = '<footer><div><a href="/track/81400222">Очень-очень</a><div><a href="/artist/1">Alice</a><span>, </span><a href="/artist/2">Bob</a></div></div></footer>';
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.hasUniqueTrackId, true);
      assert.equal(report.trackIdentityStableDuringInspection, true);
      assert.equal(report.playlists[0]!.matchesCurrentTrackIdInPath, true);
      assert.equal(report.currentPlaylistAssociation, 'unconfirmed');
    } finally { fixture.cleanup(); }
  });

  it('uses generic failures and never emits request URL/error strings', async () => {
    const fixture = setup();
    try {
      fixture.setReply(async () => { throw new Error('https://signed.test/private?Authorization=secret'); });
      fixture.run();
      const report = await fixture.done();
      assert.equal(report.playlists[0]!.status, 'request-failed');
      assert.equal(JSON.stringify(report).includes('Authorization'), false);
      assert.equal(JSON.stringify(report).includes('signed.test'), false);
      for (const output of fixture.logs) {
        assert.doesNotThrow(() => JSON.parse(output));
        assert.equal(output.includes('private-observed-path'), false);
      }
    } finally { fixture.cleanup(); }
  });

  it('aborts active requests on timeout, pagehide, repeated launch and manual stop', async () => {
    const fixture = setup();
    try {
      fixture.setReply(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private abort details')), { once: true })));
      fixture.run();
      const timeout = [...fixture.timers.values()].find((timer) => timer.delay === 5000)!;
      timeout.handler();
      const timedOut = await fixture.done();
      assert.equal(timedOut.playlists[0]!.status, 'timeout');
      assert.equal(fixture.requests[0]!.options.signal.aborted, true);
      fixture.run();
      const oldApi = fixture.api();
      fixture.run();
      assert.equal((await oldApi.done).status, 'stopped');
      assert.equal(fixture.requests[1]!.options.signal.aborted, true);
      fixture.window.dispatchEvent(new fixture.window.Event('pagehide'));
      assert.equal((await fixture.done()).status, 'stopped');
      assert.equal(fixture.timers.size, 0);
      fixture.run();
      fixture.api().stop();
      assert.equal((await fixture.done()).status, 'stopped');
      assert.equal(fixture.requests.at(-1)!.options.signal.aborted, true);
    } finally { fixture.cleanup(); }
  });

  it('stops the whole inspection after 30 seconds and settles done without requesting more candidates', async () => {
    const fixture = setup(Array.from({ length: 8 }, (_, index) => ({ name: `https://cdn-hls-slicer.zvuk.com/${index}.m3u8` })));
    try {
      fixture.setReply(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
      fixture.run();
      await fixture.advance(300);
      assert.equal(fixture.requests.length, 2);
      [...fixture.timers.values()].find((timer) => timer.delay === 30000)!.handler();
      const report = await fixture.done();
      assert.equal(report.status, 'stopped');
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.requests.every((request) => request.options.signal.aborted), true);
      assert.equal(report.playlists.every((item) => item.status === 'stopped'), true);
      assert.equal(fixture.timers.size, 0);
    } finally { fixture.cleanup(); }
  });
});
