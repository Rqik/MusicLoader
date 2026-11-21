import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHlsSourceTracker } from '../src/features/downloads/lib/hls-sources';
import { isHlsDiscovery } from '../src/features/downloads/lib/hls-discovery';

function setup(history: string[] = []) {
  const descriptors = new Map(['performance', 'PerformanceObserver', 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let listener: ((entries: { getEntries: () => { name: string }[] }) => void) | undefined;
  let isDisconnected = false;
  let requests = 0;
  class Observer {
    constructor(callback: typeof listener) { listener = callback; }
    observe() {}
    disconnect() { isDisconnected = true; }
  }
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { getEntriesByType: () => history.map((name) => ({ name })) } });
  Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, value: Observer });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: () => { requests += 1; throw new Error('No requests permitted'); } });
  const tracker = createHlsSourceTracker();
  return {
    tracker, feed: (urls: string[]) => listener?.({ getEntries: () => urls.map((name) => ({ name })) }),
    requests: () => requests, isDisconnected: () => isDisconnected,
    cleanup() {
      tracker.dispose();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
describe('page-local HLS source observations', () => {
  it('retains a master at the beginning of a large history and observer batch', () => {
    const url = 'https://cdn-hls-slicer.zvuk.com/tracks/60001/master.m3u8';
    const assets = Array.from({ length: 1_000 }, (_, index) => `https://zvuk.com/assets/${index}.js`);
    const fixture = setup([url, ...assets]);
    try {
      assert.deepEqual(fixture.tracker.forTrack('60001'), [url]);
      const nextUrl = 'https://cdn-hls-slicer.zvuk.com/tracks/60002/master.m3u8';
      fixture.feed([nextUrl, ...assets]);
      assert.deepEqual(fixture.tracker.forTrack('60002'), [nextUrl]);
      assert.deepEqual(fixture.tracker.readDiscovery('60002'), {
        observerMode: 'observer', observations: 2_002, playlistObservations: 2, acceptedObservations: 2,
        storedPlaylists: 2, matchingPlaylists: 1, rejectedPrivate: 0, rejectedHost: 0, rejectedOther: 0,
      });
      assert.equal(fixture.requests(), 0);
    } finally { fixture.cleanup(); }
  });
  it('explains rejected playlists with bounded counters while retaining no private addresses', () => {
    const root = 'https://cdn-hls-slicer.zvuk.com/tracks/60001/';
    const fixture = setup([
      `${root}master.m3u8`, `${root}master.m3u8?token=DO_NOT_EXPOSE`, `${root}master.m3u8#DO_NOT_EXPOSE`,
      'https://user:DO_NOT_EXPOSE@cdn-hls-slicer.zvuk.com/tracks/60001/master.m3u8',
      'https://other.zvuk.com/tracks/60001/master.m3u8',
      'http://cdn-hls-slicer.zvuk.com/tracks/60001/master.m3u8',
      `${root}license/master.m3u8`, 'invalid-url/master.m3u8',
      'https://zvuk.com/image.jpg?filename=master.m3u8',
    ]);
    try {
      const summary = fixture.tracker.readDiscovery('60001');
      assert.deepEqual(summary, {
        observerMode: 'observer', observations: 9, playlistObservations: 8, acceptedObservations: 1,
        storedPlaylists: 1, matchingPlaylists: 1, rejectedPrivate: 3, rejectedHost: 1, rejectedOther: 3,
      });
      assert.equal(isHlsDiscovery(summary), true);
      assert.doesNotMatch(JSON.stringify(summary), /DO_NOT_EXPOSE|https:|master\.m3u8|other\.zvuk|tracks/);
      assert.deepEqual(fixture.tracker.forTrack('60001'), [`${root}master.m3u8`]);
      assert.equal(fixture.requests(), 0);
    } finally { fixture.cleanup(); }
  });
  it('caps discovery counters and matching sources without accumulating unbounded state', () => {
    const fixture = setup();
    try {
      const batch = Array.from({ length: 10_100 }, (_, index) => `https://cdn-hls-slicer.zvuk.com/tracks/60001/${index}.m3u8`);
      fixture.feed(batch);
      fixture.feed(batch);
      const summary = fixture.tracker.readDiscovery('60001');
      assert.equal(summary.observations, 10_000);
      assert.equal(summary.playlistObservations, 10_000);
      assert.equal(summary.acceptedObservations, 10_000);
      assert.equal(summary.storedPlaylists, 32);
      assert.equal(summary.matchingPlaylists, 8);
      assert.equal(isHlsDiscovery(summary), true);
      assert.equal(fixture.tracker.readDiscovery(null).matchingPlaylists, 0);
      assert.equal(fixture.tracker.readDiscovery('60001.*').matchingPlaylists, 0);
      fixture.tracker.dispose();
      const stopped = fixture.tracker.readDiscovery('60001');
      fixture.feed(['https://cdn-hls-slicer.zvuk.com/60001/new.m3u8']);
      assert.deepEqual(fixture.tracker.readDiscovery('60001'), stopped);
      assert.equal(stopped.storedPlaylists, 0);
      assert.equal(stopped.matchingPlaylists, 0);
    } finally { fixture.cleanup(); }
  });
  it('keeps only public CDN playlists and matches the confirmed numeric ID, without fetching', () => {
    const url = 'https://cdn-hls-slicer.zvuk.com/tracks/60001/master.m3u8';
    const fixture = setup([url, url, 'https://cdn-hls-slicer.zvuk.com/tracks/600010/master.m3u8', `${url}?token=private`, 'https://other.zvuk.com/60001/master.m3u8', 'https://cdn-hls-slicer.zvuk.com/60001/init.mp4']);
    try {
      assert.deepEqual(fixture.tracker.forTrack('60001'), [url]);
      assert.deepEqual(fixture.tracker.forTrack('60001.*'), []);
      assert.equal(fixture.requests(), 0);
    } finally { fixture.cleanup(); }
  });
  it('retains observed /drm/ playlists and binds their numeric track ID without treating the folder as an encryption method', () => {
    const url = 'https://cdn-hls-slicer.zvuk.com/drm/track/t60001-fixture/master.m3u8';
    const fixture = setup([url, 'https://cdn-hls-slicer.zvuk.com/drm/track/t600010-fixture/master.m3u8']);
    try {
      assert.deepEqual(fixture.tracker.forTrack('60001'), [url]);
      const discovery = fixture.tracker.readDiscovery('60001');
      assert.equal(discovery.acceptedObservations, 2);
      assert.equal(discovery.matchingPlaylists, 1);
      assert.equal(discovery.rejectedOther, 0);
      assert.equal(fixture.requests(), 0);
    } finally { fixture.cleanup(); }
  });
  it('retains fresh observer data when the browser history still contains only old buffered entries', () => {
    const old = Array.from({ length: 40 }, (_, index) => `https://cdn-hls-slicer.zvuk.com/tracks/${100 + index}/master.m3u8`);
    const fixture = setup(old);
    const current = 'https://cdn-hls-slicer.zvuk.com/tracks/60001/master.m3u8';
    try {
      fixture.feed([current]);
      assert.equal(fixture.tracker.hasObserved(), true);
      assert.deepEqual(fixture.tracker.forTrack('60001'), [current]);
      assert.deepEqual(fixture.tracker.forTrack('100'), []);
      fixture.feed([current]);
      assert.deepEqual(fixture.tracker.forTrack('60001'), [current]);
    } finally { fixture.cleanup(); }
  });
  it('bounds observations and ignores queued observer callbacks or reads after disposal', () => {
    const fixture = setup();
    try {
      fixture.feed(Array.from({ length: 40 }, (_, index) => `https://cdn-hls-slicer.zvuk.com/tracks/${index}/master.m3u8`));
      assert.deepEqual(fixture.tracker.forTrack('0'), []);
      assert.equal(fixture.tracker.forTrack('39').length, 1);
      fixture.tracker.dispose();
      fixture.feed(['https://cdn-hls-slicer.zvuk.com/tracks/60001/master.m3u8']);
      assert.equal(fixture.isDisconnected(), true);
      assert.equal(fixture.tracker.hasObserved(), false);
      assert.deepEqual(fixture.tracker.forTrack('60001'), []);
    } finally { fixture.cleanup(); }
  });
});
