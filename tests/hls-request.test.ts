import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHlsRequestFailure, type HlsRequestFailure } from '../src/features/downloads/lib/hls-request';

const request: HlsRequestFailure = { resource: 'key', kind: 'http', httpStatus: 403 };

describe('safe HLS request failure payload', () => {
  it('accepts only bounded resource, reason and optional visible HTTP status', () => {
    for (const resource of ['manifest', 'init', 'segment', 'key']) {
      for (const kind of ['http', 'network', 'timeout', 'empty-body', 'invalid-data']) {
        for (const httpStatus of [null, 100, 200, 401, 403, 429, 503, 599]) {
          assert.equal(isHlsRequestFailure({ resource, kind, httpStatus }), true);
        }
      }
    }
  });

  it('rejects extra fields, secrets, unknown values and invalid status codes', () => {
    for (const value of [null, [], {}, { ...request, resource: 'https://private.test/key' },
      { ...request, kind: 'Request failed: token=secret' }, { ...request, url: 'https://private.test/key?token=secret' },
      { ...request, headers: { Authorization: 'secret' } }, { ...request, [Symbol('secret')]: 'private' },
      ...[undefined, -1, 0, 99, 600, 200.5, NaN, Infinity, '403'].map((httpStatus) => ({ ...request, httpStatus })),
    ]) assert.equal(isHlsRequestFailure(value), false);
    const incomplete: Partial<HlsRequestFailure> = { ...request };
    delete incomplete.kind;
    assert.equal(isHlsRequestFailure(incomplete), false);
  });
});
