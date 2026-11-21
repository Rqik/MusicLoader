import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHlsDiscovery, type HlsDiscovery } from '../src/features/downloads/lib/hls-discovery';

const discovery: HlsDiscovery = {
  observerMode: 'observer', observations: 100, playlistObservations: 5, acceptedObservations: 2,
  storedPlaylists: 2, matchingPlaylists: 1, rejectedPrivate: 1, rejectedHost: 1, rejectedOther: 1,
};

describe('safe HLS discovery payload', () => {
  it('accepts only bounded counters and the two supported observation modes', () => {
    assert.equal(isHlsDiscovery(discovery), true);
    assert.equal(isHlsDiscovery({ ...discovery, observerMode: 'history' }), true);
    for (const field of ['observations', 'playlistObservations', 'acceptedObservations', 'rejectedPrivate', 'rejectedHost', 'rejectedOther']) {
      assert.equal(isHlsDiscovery({ ...discovery, [field]: 0 }), true);
      assert.equal(isHlsDiscovery({ ...discovery, [field]: 10_000 }), true);
      for (const value of [-1, 10_001, 1.5, Infinity, NaN, '1', null]) assert.equal(isHlsDiscovery({ ...discovery, [field]: value }), false);
    }
    assert.equal(isHlsDiscovery({ ...discovery, storedPlaylists: 32, matchingPlaylists: 8 }), true);
    assert.equal(isHlsDiscovery({ ...discovery, storedPlaylists: 33 }), false);
    assert.equal(isHlsDiscovery({ ...discovery, matchingPlaylists: 9 }), false);
  });
  it('rejects missing/extra fields, addresses, arbitrary text and symbol keys', () => {
    const incomplete = { ...discovery } as Partial<HlsDiscovery>;
    delete incomplete.rejectedPrivate;
    for (const invalid of [null, [], {}, incomplete,
      { ...discovery, observerMode: 'https://private.test/?token=secret' },
      { ...discovery, url: 'https://private.test/?token=secret' },
      { ...discovery, cookies: 'secret' }, { ...discovery, [Symbol('token')]: 'secret' },
    ]) assert.equal(isHlsDiscovery(invalid), false);
  });
});
