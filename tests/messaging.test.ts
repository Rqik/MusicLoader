import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDocumentKey, isDownloadProgress, isExtensionMessage, isExtensionResponse, isPlayerSnapshot, type ExtensionMessage, type ExtensionResponse } from '../src/shared/messaging/messages';
import { BRIDGE_VERSION, isBridgeUpdate, type BridgeUpdate, type DownloadProgressUpdate } from '../src/shared/messaging/bridge';
import { isAudioDiagnostics, isDiagnosticsRecord } from '../src/features/diagnostics/validation';
import type { AudioDiagnostics } from '../src/features/diagnostics/types';
import type { PlayerSnapshot } from '../src/features/player/types';
import type { Track } from '../src/shared/types/track';
import type { DownloadResolution } from '../src/features/downloads/lib/direct-download';
import { hlsFailureReasons } from '../src/features/downloads/lib/hls';
import type { HlsDiscovery } from '../src/features/downloads/lib/hls-discovery';

const channel = '15133214-546e-4146-9caf-d5cb57a17326';
const documentKey = channel;
const requestId = 'd9199b7a-2191-41c0-a7ed-88e7ad97fa22';
const resolution: DownloadResolution = { status: 'ready', url: 'https://zvuk.com/public/song.mp3', extension: 'mp3' };
const assembledResolution: DownloadResolution = { status: 'assembled', url: `blob:https://zvuk.com/${requestId}`, extension: 'm4a' };
const track: Track = { id: '81400222', title: 'Очень-очень', artist: 'ARTIK & ASTI', album: '#РайОдинНаДвоих', artwork: null, url: 'https://zvuk.com/track/81400222' };
const report: AudioDiagnostics = { formats: ['mp3'], delivery: ['file'], hasMediaKeys: false, hasEncryptedEvent: false, mimeTypes: ['audio/mpeg'], resourceCount: 1, quality: null };
const snapshot: PlayerSnapshot = { tabId: 12, track, playbackState: 'playing', updatedAt: 100, connection: 'connected', error: null };
const update: ExtensionMessage = { type: 'TRACK_UPDATE', documentKey, track, playbackState: 'playing', error: null };

describe('typed extension requests', () => {
  it('accepts every supported request, including missing metadata and a bridge error', () => {
    const messages: ExtensionMessage[] = [
      { type: 'PING' }, { type: 'GET_PLAYER_STATE' }, { type: 'GET_DOCUMENT_KEY' }, { type: 'REFRESH_PLAYER' }, update,
      { type: 'TRACK_UPDATE', documentKey, track: null, playbackState: 'none', error: 'bridge-unavailable' },
      { type: 'DIAGNOSTICS_REPORT', documentKey, report },
      { type: 'SET_DIAGNOSTICS', tabId: 12, isEnabled: true },
      { type: 'SET_BRIDGE_DIAGNOSTICS', isEnabled: false },
      { type: 'DOWNLOAD_TRACK', tabId: 12, track },
      { type: 'RESOLVE_DOWNLOAD', requestId, track },
      { type: 'RELEASE_DOWNLOAD', requestId },
      { type: 'DOWNLOAD_PROGRESS', requestId, documentKey, progress: 0 },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: 12, track, progress: 100 },
    ];
    for (const message of messages) assert.equal(isExtensionMessage(message), true, JSON.stringify(message));
  });

  it('rejects unknown requests and malformed track updates', () => {
    for (const message of [
      null, undefined, [], true, 42, 'PING', {}, { type: 'GET_ACTIVE_PAGE' }, { type: 'UNKNOWN' },
      { ...update, track: {} }, { ...update, track: { ...track, title: 42 } },
      { ...update, track: { ...track, id: 'invalid' } }, { ...update, track: { ...track, artist: undefined } },
      { type: 'TRACK_UPDATE', documentKey, track, playbackState: 'playing' },
      { type: 'TRACK_UPDATE', documentKey, playbackState: 'playing', error: null },
      { type: 'TRACK_UPDATE', track, playbackState: 'playing', error: null },
      { ...update, documentKey: 'invalid-document-key' },
      { ...update, playbackState: 'buffering' }, { ...update, playbackState: true },
      { ...update, error: 'arbitrary error text with potentially sensitive information' },
      { type: 'SET_DIAGNOSTICS', tabId: -1, isEnabled: true },
      { type: 'SET_DIAGNOSTICS', tabId: 1.5, isEnabled: true },
      { type: 'SET_DIAGNOSTICS', tabId: '12', isEnabled: true },
      { type: 'SET_BRIDGE_DIAGNOSTICS', isEnabled: 'true' },
    ]) assert.equal(isExtensionMessage(message), false, JSON.stringify(message));
  });

  it('rejects extra fields instead of forwarding page secrets', () => {
    for (const message of [
      { type: 'PING', token: 'secret' }, { type: 'GET_PLAYER_STATE', cookie: 'secret' },
      { ...update, authorization: 'secret' }, { ...update, track: { ...track, authorization: 'secret' } },
      { type: 'DIAGNOSTICS_REPORT', documentKey, report, url: 'https://cdn.example.test/audio?token=secret' },
      { type: 'SET_DIAGNOSTICS', tabId: 12, isEnabled: true, extra: 'value' },
      { type: 'SET_BRIDGE_DIAGNOSTICS', isEnabled: true, extra: 'value' },
    ]) assert.equal(isExtensionMessage(message), false, JSON.stringify(message));
  });
});

describe('extension response payloads', () => {
  it('accepts player state and minimal control responses', () => {
    const responses: ExtensionResponse[] = [
      { type: 'PONG' }, { type: 'ACK', isDiagnosticsEnabled: false }, { type: 'DOCUMENT_KEY', documentKey }, { type: 'ERROR', message: 'Please refresh the tab' },
      { type: 'PLAYER_STATE', sources: [], diagnostics: [], activeTabId: null },
      { type: 'PLAYER_STATE', sources: [snapshot], diagnostics: [{ tabId: 12, isEnabled: true, report, updatedAt: 100 }], activeTabId: 12 },
      { type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution },
      { type: 'DOWNLOAD_STARTED', downloadId: 7 },
      { type: 'DOWNLOAD_KEEPALIVE', requestId, isActive: true },
      { type: 'DOWNLOAD_KEEPALIVE', requestId, isActive: false },
      { type: 'DOWNLOAD_UNAVAILABLE', reason: 'protected-media' },
    ];
    for (const response of responses) assert.equal(isExtensionResponse(response), true, JSON.stringify(response));
    assert.equal(isPlayerSnapshot({ ...snapshot, track: null, playbackState: 'none', connection: 'waiting' }), true);
  });

  it('rejects malformed snapshots, reports and responses', () => {
    for (const value of [
      { ...snapshot, tabId: -1 }, { ...snapshot, tabId: '12' }, { ...snapshot, updatedAt: Number.NaN },
      { ...snapshot, playbackState: 'loading' }, { ...snapshot, connection: 'unknown' },
      { ...snapshot, track: { ...track, id: null } }, { ...snapshot, error: 'secret text' },
    ]) assert.equal(isPlayerSnapshot(value), false);
    for (const response of [
      null, undefined, [], {}, { type: 'UNKNOWN' }, { type: 'ACK' }, { type: 'ACK', isDiagnosticsEnabled: 1 },
      { type: 'ERROR', message: 42 }, { type: 'PLAYER_STATE', sources: [], diagnostics: [] },
      { type: 'PLAYER_STATE', sources: [null], diagnostics: [], activeTabId: null },
      { type: 'PLAYER_STATE', sources: [], diagnostics: [null], activeTabId: null },
      { type: 'PLAYER_STATE', sources: [], diagnostics: [], activeTabId: -1 },
    ]) assert.equal(isExtensionResponse(response), false, JSON.stringify(response));
  });

  it('rejects extra response, snapshot and persisted record fields', () => {
    const extraSnapshot = { ...snapshot, cookies: 'secret' };
    const extraRecord = { tabId: 12, report, isEnabled: true, updatedAt: 100, url: 'https://cdn.example.test/audio?token=secret' };
    assert.equal(isPlayerSnapshot(extraSnapshot), false);
    assert.equal(isDiagnosticsRecord(extraRecord), false);
    for (const response of [
      { type: 'PONG', token: 'secret' }, { type: 'ACK', isDiagnosticsEnabled: false, token: 'secret' },
      { type: 'DOCUMENT_KEY', documentKey, token: 'secret' }, { type: 'ERROR', message: 'Error', url: 'https://cdn.test/private' },
      { type: 'PLAYER_STATE', sources: [], diagnostics: [], activeTabId: null, token: 'secret' },
      { type: 'PLAYER_STATE', sources: [extraSnapshot], diagnostics: [], activeTabId: null },
      { type: 'PLAYER_STATE', sources: [], diagnostics: [extraRecord], activeTabId: null },
    ]) assert.equal(isExtensionResponse(response), false, JSON.stringify(response));
  });

  it('requires well-formed document keys for both incoming updates and confirmation responses', () => {
    assert.equal(isDocumentKey(documentKey), true);
    for (const value of [null, undefined, '', 42, 'a'.repeat(36), '15133214-546e-4146-9caf-d5cb57a1732x']) {
      assert.equal(isDocumentKey(value), false);
      assert.equal(isExtensionMessage({ ...update, documentKey: value }), false);
      assert.equal(isExtensionMessage({ type: 'DIAGNOSTICS_REPORT', documentKey: value, report }), false);
      assert.equal(isExtensionResponse({ type: 'DOCUMENT_KEY', documentKey: value }), false);
    }
    assert.equal(isExtensionMessage({ type: 'DIAGNOSTICS_REPORT', report }), false);
  });

  it('accepts a bounded metadata read failure without arbitrary page error text', () => {
    assert.equal(isExtensionMessage({ ...update, track: null, error: 'metadata-read-failed' }), true);
    assert.equal(isPlayerSnapshot({ ...snapshot, track: null, connection: 'error', error: 'metadata-read-failed' }), true);
    assert.equal(isBridgeUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'TRACK', track: null, playbackState: 'none', error: 'metadata-read-failed' }, channel), true);
  });
});

describe('user initiated download protocol', () => {
  it('passes only bounded request metadata through MAIN bridge, content response and popup failure', () => {
    const request = { resource: 'init', kind: 'http', httpStatus: 503 } as const;
    const unavailable: DownloadResolution = { status: 'unavailable', reason: 'hls-request-failed', request };
    const bridge = { source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_RESULT', requestId, resolution: unavailable };
    assert.equal(isBridgeUpdate(bridge, channel), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution: unavailable }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-request-failed', request }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-request-failed' }), true);
    for (const invalid of [undefined, null, { ...request, url: 'https://private.test/init?token=secret' },
      { ...request, reason: 'secret request error' }, { ...request, httpStatus: 99 }, { ...request, httpStatus: 600 },
      { ...request, httpStatus: '503' }, { ...request, resource: 'https://private.test' },
    ]) {
      const invalidResolution: Record<string, unknown> = { ...unavailable, request: invalid };
      assert.equal(isBridgeUpdate({ ...bridge, resolution: invalidResolution }, channel), false);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution: invalidResolution }), false);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-request-failed', request: invalid }), false);
    }
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-request-failed', request, rawError: 'secret' }), false);
  });

  it('accepts metadata-only download requests and bounded source/start responses', () => {
    assert.equal(isExtensionMessage({ type: 'DOWNLOAD_TRACK', tabId: 12, track }), true);
    assert.equal(isExtensionMessage({ type: 'RESOLVE_DOWNLOAD', requestId, track }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution: assembledResolution }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution: { status: 'unavailable', reason: 'track-changed' } }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_STARTED', downloadId: 0 }), true);
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'bridge-unavailable' }), true);
  });

  it('cannot submit a resource URL or arbitrary fields directly in DOWNLOAD_TRACK', () => {
    for (const message of [
      { type: 'DOWNLOAD_TRACK', tabId: 12, track, url: resolution.url },
      { type: 'DOWNLOAD_TRACK', tabId: 12, track, resolution },
      { type: 'DOWNLOAD_TRACK', tabId: 12, url: resolution.url },
      { type: 'DOWNLOAD_TRACK', tabId: 12, track: { ...track, url: resolution.url } },
      { type: 'DOWNLOAD_TRACK', tabId: 12, track: { ...track, audioUrl: resolution.url } },
      { type: 'DOWNLOAD_TRACK', tabId: -1, track },
      { type: 'DOWNLOAD_TRACK', tabId: 1.5, track },
      { type: 'DOWNLOAD_TRACK', tabId: '12', track },
      { type: 'DOWNLOAD_TRACK', tabId: 12, track: null },
      { type: 'RESOLVE_DOWNLOAD', requestId, track, url: resolution.url },
      { type: 'RESOLVE_DOWNLOAD', requestId, track: null },
    ]) assert.equal(isExtensionMessage(message), false, JSON.stringify(message));
  });

  it('rejects malformed request IDs at every source resolution boundary', () => {
    const invalidIds = [null, undefined, 42, '', 'a'.repeat(36), 'd9199b7a-2191-41c0-a7ed-88e7ad97fa2x'];
    for (const invalidId of invalidIds) {
      assert.equal(isExtensionMessage({ type: 'RESOLVE_DOWNLOAD', requestId: invalidId, track }), false);
      assert.equal(isExtensionMessage({ type: 'RELEASE_DOWNLOAD', requestId: invalidId }), false);
      assert.equal(isExtensionMessage({ type: 'DOWNLOAD_PROGRESS', requestId: invalidId, documentKey, progress: 50 }), false);
      assert.equal(isExtensionMessage({ type: 'DOWNLOAD_PROGRESS', requestId, documentKey: invalidId, progress: 50 }), false);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId: invalidId, documentKey, resolution }), false);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey: invalidId, resolution }), false);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_KEEPALIVE', requestId: invalidId, isActive: true }), false);
      assert.equal(isBridgeUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_RESULT', requestId: invalidId, resolution }, channel), false);
      assert.equal(isBridgeUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_PROGRESS', requestId: invalidId, progress: 50 }, channel), false);
    }
  });

  it('rejects foreign or signed URLs and extra fields inside download source responses', () => {
    const invalidResolutions = [
      { ...resolution, url: 'https://cdn.example.test/song.mp3' },
      { ...resolution, url: 'https://zvuk.com.attacker.test/song.mp3' },
      { ...resolution, url: 'https://zvuk.com/song.mp3?token=secret' },
      { ...resolution, url: 'https://zvuk.com/song.mp3#secret' },
      { ...resolution, url: 'https://user:password@zvuk.com/song.mp3' },
      { ...resolution, url: 'blob:https://zvuk.com/opaque' },
      { ...resolution, extension: 'flac' },
      { ...resolution, authorization: 'secret' },
      { ...assembledResolution, url: `blob:https://other.test/${requestId}` },
      { ...assembledResolution, url: `blob:https://zvuk.com.attacker.test/${requestId}` },
      { ...assembledResolution, url: `blob:https://zvuk.com/${requestId}?token=secret` },
      { ...assembledResolution, url: `blob:https://zvuk.com/${requestId}#secret` },
      { ...assembledResolution, url: 'blob:https://zvuk.com/invalid-uuid' },
      { ...assembledResolution, url: 'data:audio/mp4;base64,AAAA' },
      { ...assembledResolution, extension: 'mp3' },
      { ...assembledResolution, authorization: 'secret' },
      { status: 'unavailable', reason: 'no-source', url: 'https://zvuk.com/private?token=secret' },
    ];
    for (const invalid of invalidResolutions) {
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution: invalid }), false, JSON.stringify(invalid));
      assert.equal(isBridgeUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_RESULT', requestId, resolution: invalid }, channel), false);
    }
    for (const response of [
      { type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution, token: 'secret' },
      { type: 'DOWNLOAD_STARTED', downloadId: -1 }, { type: 'DOWNLOAD_STARTED', downloadId: 0.5 },
      { type: 'DOWNLOAD_STARTED', downloadId: '7' }, { type: 'DOWNLOAD_STARTED', downloadId: 7, url: resolution.url },
      { type: 'DOWNLOAD_UNAVAILABLE', reason: 'unknown' },
      { type: 'DOWNLOAD_UNAVAILABLE', reason: 'private-url', url: 'https://zvuk.com/private?token=secret' },
    ]) assert.equal(isExtensionResponse(response), false, JSON.stringify(response));
  });

  it('accepts exact DOWNLOAD_RESULT envelopes but rejects wrong channel/version/source or extra fields', () => {
    const result: BridgeUpdate = { source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_RESULT', requestId, resolution };
    assert.equal(isBridgeUpdate(result, channel), true);
    assert.equal(isBridgeUpdate({ ...result, resolution: assembledResolution }, channel), true);
    assert.equal(isBridgeUpdate({ ...result, resolution: { status: 'unavailable', reason: 'no-track' } }, channel), true);
    for (const invalid of [
      { ...result, source: 'musicloader:content' }, { ...result, version: 2 },
      { ...result, channel: 'another-channel' }, { ...result, token: 'secret' },
      { ...result, type: 'RESOLVE_DOWNLOAD' },
    ]) assert.equal(isBridgeUpdate(invalid, channel), false, JSON.stringify(invalid));
  });

  it('accepts only known HLS failure reasons across runtime and bridge responses', () => {
    assert.ok(hlsFailureReasons.length > 0);
    for (const reason of hlsFailureReasons) {
      const unavailable = { status: 'unavailable', reason };
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason }), true, reason);
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_SOURCE', requestId, documentKey, resolution: unavailable }), true, reason);
      assert.equal(isBridgeUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_RESULT', requestId, resolution: unavailable }, channel), true, reason);
    }
    assert.equal(isExtensionResponse({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-arbitrary-private-server-error' }), false);
  });
});

describe('download progress and lifetime protocol', () => {
  const progressUpdate: DownloadProgressUpdate = {
    source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_PROGRESS', requestId, progress: 50,
  };

  it('accepts integer progress including 0 and 100 at each boundary', () => {
    for (const progress of [0, 1, 50, 99, 100]) {
      assert.equal(isDownloadProgress(progress), true);
      assert.equal(isExtensionMessage({ type: 'DOWNLOAD_PROGRESS', requestId, documentKey, progress }), true);
      assert.equal(isExtensionMessage({ type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: 0, track, progress }), true);
      assert.equal(isBridgeUpdate({ ...progressUpdate, progress }, channel), true);
    }
  });

  it('rejects out-of-range, fractional and nonnumeric progress at every boundary', () => {
    for (const progress of [null, undefined, '50', false, -1, 101, 0.5, 99.9, Number.NaN, Infinity, -Infinity]) {
      assert.equal(isDownloadProgress(progress), false);
      assert.equal(isExtensionMessage({ type: 'DOWNLOAD_PROGRESS', requestId, documentKey, progress }), false);
      assert.equal(isExtensionMessage({ type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: 12, track, progress }), false);
      assert.equal(isBridgeUpdate({ ...progressUpdate, progress }, channel), false);
    }
  });

  it('requires document binding and exact request fields without forwarding page data', () => {
    for (const message of [
      { type: 'RELEASE_DOWNLOAD' }, { type: 'RELEASE_DOWNLOAD', requestId, token: 'secret' },
      { type: 'DOWNLOAD_PROGRESS', requestId, progress: 50 },
      { type: 'DOWNLOAD_PROGRESS', documentKey, progress: 50 },
      { type: 'DOWNLOAD_PROGRESS', requestId, documentKey },
      { type: 'DOWNLOAD_PROGRESS', requestId, documentKey, progress: 50, url: resolution.url },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: -1, track, progress: 50 },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: 0.5, track, progress: 50 },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: '12', track, progress: 50 },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: 12, track: null, progress: 50 },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: 12, track: { ...track, token: 'secret' }, progress: 50 },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', tabId: 12, track, progress: 50, requestId },
      { type: 'DOWNLOAD_PROGRESS_UPDATE', track, progress: 50 },
    ]) assert.equal(isExtensionMessage(message), false, JSON.stringify(message));
  });

  it('accepts only exact six-key bridge progress from its bound source and channel', () => {
    assert.equal(Object.keys(progressUpdate).length, 6);
    assert.equal(isBridgeUpdate(progressUpdate, channel), true);
    for (const value of [
      { ...progressUpdate, source: 'musicloader:content' },
      { ...progressUpdate, channel: requestId },
      { ...progressUpdate, version: BRIDGE_VERSION + 1 },
      { ...progressUpdate, version: String(BRIDGE_VERSION) },
      { ...progressUpdate, requestId: undefined },
      { ...progressUpdate, documentKey },
      { ...progressUpdate, token: 'secret' },
      { source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DOWNLOAD_PROGRESS', progress: 50 },
    ]) assert.equal(isBridgeUpdate(value, channel), false, JSON.stringify(value));
  });

  it('requires a boolean active flag and exact keepalive response schema', () => {
    for (const isActive of [true, false]) {
      assert.equal(isExtensionResponse({ type: 'DOWNLOAD_KEEPALIVE', requestId, isActive }), true);
    }
    for (const value of [
      { type: 'DOWNLOAD_KEEPALIVE', requestId },
      { type: 'DOWNLOAD_KEEPALIVE', requestId, isActive: 1 },
      { type: 'DOWNLOAD_KEEPALIVE', requestId, isActive: 'true' },
      { type: 'DOWNLOAD_KEEPALIVE', isActive: true },
      { type: 'DOWNLOAD_KEEPALIVE', requestId, isActive: true, url: assembledResolution.url },
      { type: 'DOWNLOAD_KEEPALIVE', requestId, isActive: true, documentKey },
    ]) assert.equal(isExtensionResponse(value), false, JSON.stringify(value));
  });
});

describe('MAIN world bridge validation', () => {
  const bridgeTrack: BridgeUpdate = { source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'TRACK', track, playbackState: 'playing', error: null };
  const bridgeDiagnostics: BridgeUpdate = { source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DIAGNOSTICS', report };

  it('accepts the exact valid track and diagnostics envelopes', () => {
    assert.equal(isBridgeUpdate(bridgeTrack, channel), true);
    assert.equal(isBridgeUpdate({ ...bridgeTrack, track: null, playbackState: 'none', error: 'media-session-unavailable' }, channel), true);
    assert.equal(isBridgeUpdate(bridgeDiagnostics, channel), true);
  });

  it('rejects other channels, senders, protocol versions and payload types', () => {
    for (const message of [
      null, [], {}, { ...bridgeTrack, channel: 'another-channel' },
      { ...bridgeTrack, source: 'musicloader:content' }, { ...bridgeTrack, source: 'untrusted' },
      { ...bridgeTrack, version: 2 }, { ...bridgeTrack, version: '1' },
      { ...bridgeTrack, type: 'UNKNOWN' }, { ...bridgeTrack, track: { ...track, title: '' } },
      { ...bridgeTrack, playbackState: 'started' }, { ...bridgeTrack, error: 'unknown' },
      { ...bridgeTrack, password: 'secret' }, { ...bridgeDiagnostics, cookies: 'secret' },
      { ...bridgeDiagnostics, report: { ...report, url: 'https://cdn.example.test/audio?token=secret' } },
    ]) assert.equal(isBridgeUpdate(message, channel), false, JSON.stringify(message));
  });
});

describe('safe audio diagnostics payloads', () => {
  const hlsDiscovery: HlsDiscovery = {
    observerMode: 'observer', observations: 50, playlistObservations: 3, acceptedObservations: 1,
    storedPlaylists: 1, matchingPlaylists: 1, rejectedPrivate: 1, rejectedHost: 1, rejectedOther: 0,
  };

  it('accepts only bounded observations and explicitly unknown quality', () => {
    assert.equal(isAudioDiagnostics(report), true);
    assert.equal(isAudioDiagnostics({ ...report, mimeTypes: ['audio/aacp', 'application/ogg', 'audio/wave'] }), true);
    assert.equal(isAudioDiagnostics({ formats: [], delivery: [], mimeTypes: [], resourceCount: 0, hasMediaKeys: false, hasEncryptedEvent: false, quality: null }), true);
    assert.equal(isDiagnosticsRecord({ tabId: 12, report, isEnabled: true, updatedAt: 100 }), true);
  });

  it('rejects raw resource URLs, headers, unknown format claims and invalid counts', () => {
    for (const invalid of [
      { ...report, url: 'https://cdn.example.test/audio?token=secret' },
      { ...report, urls: ['https://cdn.example.test/audio?token=secret'] },
      { ...report, headers: { Authorization: 'secret' } }, { ...report, cookies: 'secret' },
      { ...report, formats: ['https://cdn.example.test/file.mp3?token=secret'] },
      { ...report, formats: ['mp3', 'mp3'] }, { ...report, formats: ['alac'] },
      { ...report, mimeTypes: ['audio/mpeg; token=secret'] },
      { ...report, delivery: ['unconfirmed-delivery'] },
      { ...report, quality: '24-bit 192kHz lossless' }, { ...report, resourceCount: -1 },
      { ...report, resourceCount: 10001 }, { ...report, resourceCount: 0.5 },
      { ...report, hasMediaKeys: 'yes' },
    ]) {
      assert.equal(isAudioDiagnostics(invalid), false, JSON.stringify(invalid));
      assert.equal(isExtensionMessage({ type: 'DIAGNOSTICS_REPORT', documentKey, report: invalid }), false);
    }
  });

  it('accepts optional bounded HLS discovery across bridge, runtime and persisted reports', () => {
    for (const observation of [report, { ...report, hlsDiscovery }, { ...report, hlsDiscovery: { ...hlsDiscovery, observerMode: 'history' } }]) {
      assert.equal(isAudioDiagnostics(observation), true);
      assert.equal(isExtensionMessage({ type: 'DIAGNOSTICS_REPORT', documentKey, report: observation }), true);
      assert.equal(isBridgeUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DIAGNOSTICS', report: observation }, channel), true);
      assert.equal(isDiagnosticsRecord({ tabId: 12, report: observation, isEnabled: true, updatedAt: 100 }), true);
      assert.equal(isExtensionResponse({ type: 'PLAYER_STATE', sources: [], diagnostics: [{ tabId: 12, report: observation, isEnabled: true, updatedAt: 100 }], activeTabId: 12 }), true);
    }
  });

  it('rejects unsafe, unbounded and explicitly missing discovery values at every boundary', () => {
    const invalidDiscovery = [
      undefined, null, [], {},
      { ...hlsDiscovery, url: 'https://cdn.example.test/private.m3u8?token=secret' },
      { ...hlsDiscovery, headers: { Authorization: 'secret' } },
      { ...hlsDiscovery, observerMode: 'https://private.test/' },
      { ...hlsDiscovery, observations: 10001 }, { ...hlsDiscovery, observations: -1 },
      { ...hlsDiscovery, playlistObservations: 0.5 }, { ...hlsDiscovery, acceptedObservations: '1' },
      { ...hlsDiscovery, rejectedPrivate: Infinity }, { ...hlsDiscovery, rejectedHost: -1 },
      { ...hlsDiscovery, rejectedOther: Number.NaN }, { ...hlsDiscovery, storedPlaylists: 33 },
      { ...hlsDiscovery, matchingPlaylists: 9 },
      { ...hlsDiscovery, [Symbol('token')]: 'secret' },
    ];
    for (const value of invalidDiscovery) {
      const invalid = { ...report, hlsDiscovery: value };
      assert.equal(isAudioDiagnostics(invalid), false);
      assert.equal(isExtensionMessage({ type: 'DIAGNOSTICS_REPORT', documentKey, report: invalid }), false);
      assert.equal(isBridgeUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DIAGNOSTICS', report: invalid }, channel), false);
      assert.equal(isDiagnosticsRecord({ tabId: 12, report: invalid, isEnabled: true, updatedAt: 100 }), false);
      assert.equal(isExtensionResponse({ type: 'PLAYER_STATE', sources: [], diagnostics: [{ tabId: 12, report: invalid, isEnabled: true, updatedAt: 100 }], activeTabId: 12 }), false);
    }
    assert.equal(isAudioDiagnostics({ ...report, hlsDiscovery, token: 'secret' }), false);
    assert.equal(isAudioDiagnostics({ ...report, hlsDiscovery, [Symbol('token')]: 'secret' }), false);
  });
});
