import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectSource } from '../src/features/player/lib/select-source';
import type { PlayerSnapshot } from '../src/features/player/types';

function source(tabId: number, overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    tabId,
    track: { id: String(tabId), title: `Track ${tabId}`, artist: `Artist ${tabId}`, album: null, artwork: null, url: `https://zvuk.com/track/${tabId}` },
    playbackState: 'none', updatedAt: 100, connection: 'connected', error: null,
    ...overrides,
  };
}

describe('player source selection', () => {
  it('returns no source when no Zvuk tab exists', () => {
    assert.equal(selectSource([], null), null);
    assert.equal(selectSource([], 123), null);
  });

  it('prefers the active Zvuk tab even when another tab is playing', () => {
    const active = source(2, { playbackState: 'paused', updatedAt: 1 });
    const playing = source(1, { playbackState: 'playing', updatedAt: 1000 });
    assert.equal(selectSource([playing, active], 2), active);
  });

  it('keeps an empty active source instead of borrowing another tab metadata', () => {
    const active = source(2, { track: null, playbackState: 'none', connection: 'waiting', updatedAt: 0 });
    const playing = source(1, { playbackState: 'playing' });
    assert.equal(selectSource([playing, active], 2), active);
    assert.equal(selectSource([playing, active], 2)?.track, null);
  });

  it('prefers a playing source when the active tab is outside the known sources', () => {
    const playing = source(1, { playbackState: 'playing', updatedAt: 1 });
    const recentPaused = source(2, { playbackState: 'paused', updatedAt: 1000 });
    assert.equal(selectSource([recentPaused, playing], 99), playing);
    assert.equal(selectSource([recentPaused, playing], null), playing);
  });

  it('uses latest update only within the same playback priority', () => {
    const recent = source(2, { playbackState: 'playing', updatedAt: 200 });
    const old = source(1, { playbackState: 'playing', updatedAt: 100 });
    const newestPaused = source(3, { playbackState: 'paused', updatedAt: 300 });
    assert.equal(selectSource([old, newestPaused, recent], null), recent);
    assert.equal(selectSource([source(1), newestPaused], null), newestPaused);
  });

  it('breaks equal-priority timestamps by tab ID without mutating sources', () => {
    const first = source(9, { playbackState: 'playing' });
    const second = source(3, { playbackState: 'playing' });
    const sources = [first, second];
    assert.equal(selectSource(sources, null), second);
    assert.deepEqual(sources, [first, second]);
    assert.equal(selectSource([second, first], null), second);
  });
});
