import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DOWNLOAD_ATTEMPT_PREFIX, isDownloadAttempt, type DownloadAttempt } from '../src/features/downloads/lib/download-attempt';
import { isExtensionMessage, isExtensionResponse } from '../src/shared/messaging/messages';

const attempt: DownloadAttempt = {
  tabId: 12, requestId: 'd9199b7a-2191-41c0-a7ed-88e7ad97fa22',
  track: { id: '81400222', title: 'Очень-очень', artist: 'ARTIK & ASTI', album: null, artwork: null, url: 'https://zvuk.com/track/81400222' },
  phase: 'preparing', progress: 30, reason: null, nativeError: null, downloadId: null, updatedAt: 100,
};

describe('persisted download attempts', () => {
  it('accepts every bounded phase and native failure codes', () => {
    assert.equal(DOWNLOAD_ATTEMPT_PREFIX, 'download.attempt.');
    for (const phase of ['checking', 'preparing', 'starting', 'started', 'complete', 'failed', 'cancelled']) {
      assert.equal(isDownloadAttempt({ ...attempt, phase }), true);
    }
    for (const reason of ['hls-request-failed', 'hls-cancelled', 'bridge-unavailable', 'native-start-failed', 'native-download-failed']) {
      assert.equal(isDownloadAttempt({ ...attempt, phase: 'failed', reason, nativeError: 'NETWORK_FAILED', downloadId: 0 }), true);
    }
  });

  it('rejects raw URLs, headers, secret-bearing errors and extra track fields', () => {
    for (const invalid of [
      { ...attempt, url: 'https://cdn-hls-slicer.zvuk.com/song?token=private' },
      { ...attempt, headers: { Authorization: 'private' } },
      { ...attempt, track: { ...attempt.track, audioUrl: 'https://zvuk.com/song.mp3' } },
      { ...attempt, reason: 'https://private.test/error?token=private' },
      { ...attempt, nativeError: 'Request failed for https://private.test/error?token=private' },
      { ...attempt, nativeError: 'A'.repeat(65) }, { ...attempt, nativeError: 'network_failed' },
    ]) assert.equal(isDownloadAttempt(invalid), false);
  });

  it('rejects invalid identity, state, progress and timestamps', () => {
    for (const invalid of [null, [], {}, { ...attempt, tabId: -1 }, { ...attempt, tabId: 1.5 },
      { ...attempt, requestId: 'invalid' }, { ...attempt, track: null }, { ...attempt, phase: 'unknown' },
      { ...attempt, progress: -1 }, { ...attempt, progress: 101 }, { ...attempt, progress: 0.5 },
      { ...attempt, downloadId: -1 }, { ...attempt, downloadId: 0.5 },
      { ...attempt, updatedAt: Infinity }, { ...attempt, updatedAt: -1 },
    ]) assert.equal(isDownloadAttempt(invalid), false);
  });

  it('validates status messages at the runtime boundary without accepting unbounded page data', () => {
    assert.equal(isExtensionMessage({ type: 'GET_DOWNLOAD_STATUS', tabId: 0 }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_STATUS', attempt: null }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_STATUS', attempt }), true);
    for (const request of [
      { type: 'GET_DOWNLOAD_STATUS' }, { type: 'GET_DOWNLOAD_STATUS', tabId: -1 },
      { type: 'GET_DOWNLOAD_STATUS', tabId: '12' }, { type: 'GET_DOWNLOAD_STATUS', tabId: 12, url: 'private' },
    ]) assert.equal(isExtensionMessage(request), false);
    for (const response of [
      { type: 'DOWNLOAD_STATUS' }, { type: 'DOWNLOAD_STATUS', attempt: null, token: 'private' },
      { type: 'DOWNLOAD_STATUS', attempt: { ...attempt, url: 'private' } },
    ]) assert.equal(isExtensionResponse(response), false);
  });

  it('preserves bounded request failures in new attempts while keeping older records compatible', () => {
    const request = { resource: 'key', kind: 'http', httpStatus: 403 } as const;
    const failed = { ...attempt, phase: 'failed', reason: 'hls-request-failed', request };
    assert.equal(isDownloadAttempt(attempt), true);
    assert.equal(isDownloadAttempt(failed), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_STATUS', attempt: failed }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-request-failed', request }), true);
    assert.deepEqual(JSON.parse(JSON.stringify(failed)).request, request);
    for (const invalid of [undefined, null, { ...request, url: 'https://private.test/key?token=secret' },
      { ...request, headers: { Authorization: 'secret' } }, { ...request, message: 'secret' },
      { ...request, resource: 'cookies' }, { ...request, kind: 'arbitrary' }, { ...request, httpStatus: 700 },
    ]) {
      assert.equal(isDownloadAttempt({ ...failed, request: invalid }), false);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_STATUS', attempt: { ...failed, request: invalid } }), false);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-request-failed', request: invalid }), false);
    }
  });
});
