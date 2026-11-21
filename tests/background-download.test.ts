import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { DOWNLOAD_ATTEMPT_PREFIX, type DownloadAttempt } from '../src/features/downloads/lib/download-attempt';
import type { ExtensionMessage, ExtensionResponse } from '../src/shared/messaging/messages';
import type { Track } from '../src/shared/types/track';

const track: Track = { id: '81400222', title: 'Очень-очень', artist: 'ARTIK & ASTI', album: null, artwork: null, url: 'https://zvuk.com/track/81400222' };
const documentKey = '15133214-546e-4146-9caf-d5cb57a17326';
const requestId = 'd9199b7a-2191-41c0-a7ed-88e7ad97fa22';
const tabId = 12;
const attemptKey = `${DOWNLOAD_ATTEMPT_PREFIX}${tabId}`;
let fixtureId = 0;

async function background(context: TestContext) {
  const stored: Record<string, unknown> = {};
  const downloadCalls: chrome.downloads.DownloadOptions[] = [];
  const releases: string[] = [];
  const downloads = new Map<number, Partial<chrome.downloads.DownloadItem>>();
  const messageListeners: Parameters<typeof chrome.runtime.onMessage.addListener>[0][] = [];
  const removedListeners: Parameters<typeof chrome.tabs.onRemoved.addListener>[0][] = [];
  const changedListeners: Parameters<typeof chrome.downloads.onChanged.addListener>[0][] = [];
  let hasReceiver = true;
  let nativeError: string | null = null;
  let resolveDownload: ((request: Extract<ExtensionMessage, { type: 'RESOLVE_DOWNLOAD' }>) => Promise<unknown>) | null = null;
  const popupSender: chrome.runtime.MessageSender = { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' };
  const fakeChrome = {
    storage: { local: {
      setAccessLevel: async () => undefined,
      get: async (keys: string | string[] | null) => keys === null ? { ...stored }
        : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map((key) => [key, stored[key]])),
      set: async (values: Record<string, unknown>) => { Object.assign(stored, structuredClone(values)); },
      remove: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete stored[key]; },
    } },
    tabs: {
      query: async () => [{ id: tabId, url: 'https://zvuk.com/', status: 'complete' }],
      get: async () => ({ id: tabId, url: 'https://zvuk.com/', status: 'complete' }),
      sendMessage: async (_tabId: number, request: ExtensionMessage) => {
        if (!hasReceiver) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (request.type === 'GET_DOCUMENT_KEY') return { type: 'DOCUMENT_KEY', documentKey };
        if (request.type === 'RELEASE_DOWNLOAD') { releases.push(request.requestId); return undefined; }
        if (request.type === 'RESOLVE_DOWNLOAD') return resolveDownload ? resolveDownload(request) : {
          type: 'DOWNLOAD_SOURCE', requestId: request.requestId, documentKey,
          resolution: { status: 'assembled', url: `blob:https://zvuk.com/${requestId}`, extension: 'm4a' },
        };
        return undefined;
      },
      onRemoved: { addListener: (listener: typeof removedListeners[number]) => removedListeners.push(listener) },
      onUpdated: { addListener: () => undefined },
    },
    downloads: {
      download: async (options: chrome.downloads.DownloadOptions) => {
        downloadCalls.push(options);
        if (nativeError) throw new Error(nativeError);
        const id = downloadCalls.length;
        downloads.set(id, { id, state: 'in_progress' });
        return id;
      },
      search: async ({ id }: { id: number }) => downloads.has(id) ? [downloads.get(id)] : [],
      onChanged: { addListener: (listener: typeof changedListeners[number]) => changedListeners.push(listener) },
    },
    runtime: {
      id: popupSender.id, getURL: (pathname: string) => `chrome-extension://extension-test/${pathname}`,
      onMessage: { addListener: (listener: typeof messageListeners[number]) => messageListeners.push(listener) },
      onStartup: { addListener: () => undefined }, sendMessage: async () => undefined,
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { value: fakeChrome, configurable: true });
  context.after(() => { if (original) Object.defineProperty(globalThis, 'chrome', original); else Reflect.deleteProperty(globalThis, 'chrome'); });
  await import(`../src/entrypoints/background/index.ts?fixture=${fixtureId++}`);
  assert.equal(messageListeners.length, 1);
  function send(message: ExtensionMessage): Promise<ExtensionResponse> {
    return new Promise((resolve) => { assert.equal(messageListeners[0]!(message, popupSender, resolve), true); });
  }
  return { stored, downloads, downloadCalls, releases, send,
    setReceiver: (value: boolean) => { hasReceiver = value; },
    setNativeError: (value: string | null) => { nativeError = value; },
    setResolveDownload: (value: typeof resolveDownload) => { resolveDownload = value; },
    removeTab: () => { removedListeners[0]!(tabId, { windowId: 1, isWindowClosing: false }); },
    changeDownload: (id: number, state: chrome.downloads.DownloadItem['state']) => { changedListeners[0]!({ id, state: { current: state } }); },
  };
}

describe('background download status and recovery', () => {
  it('persists bounded failed request metadata and clears it when the user starts a new attempt', async (context) => {
    const app = await background(context);
    const request = { resource: 'key', kind: 'http', httpStatus: 403 } as const;
    app.setResolveDownload(async (command) => ({ type: 'DOWNLOAD_SOURCE', requestId: command.requestId, documentKey,
      resolution: { status: 'unavailable', reason: 'hls-request-failed', request } }));
    assert.deepEqual(await app.send({ type: 'DOWNLOAD_TRACK', tabId, track }), { type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-request-failed', request });
    const failed = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (failed.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing failure status');
    assert.equal(failed.attempt?.phase, 'failed');
    assert.deepEqual(failed.attempt?.request, request);
    assert.deepEqual((app.stored[attemptKey] as DownloadAttempt).request, request);
    assert.equal(app.downloadCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(app.stored), /https:\/\/private|Authorization|token=|keyserver/);
    app.setResolveDownload(null);
    assert.equal((await app.send({ type: 'DOWNLOAD_TRACK', tabId, track })).type, 'DOWNLOAD_STARTED');
    const retry = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (retry.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing retry status');
    assert.notEqual(retry.attempt?.requestId, failed.attempt?.requestId);
    assert.equal(retry.attempt?.phase, 'started');
    assert.equal(Object.hasOwn(retry.attempt!, 'request'), false);
  });

  it('rejects secret-bearing failure metadata from content without persisting it', async (context) => {
    const app = await background(context);
    app.setResolveDownload(async (command) => ({ type: 'DOWNLOAD_SOURCE', requestId: command.requestId, documentKey,
      resolution: { status: 'unavailable', reason: 'hls-request-failed', request: {
        resource: 'key', kind: 'http', httpStatus: 403, url: 'https://private.test/key?token=DO_NOT_STORE_SECRET',
      } } }));
    assert.deepEqual(await app.send({ type: 'DOWNLOAD_TRACK', tabId, track }), { type: 'DOWNLOAD_UNAVAILABLE', reason: 'bridge-unavailable' });
    const result = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (result.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing status');
    assert.equal(result.attempt?.request, undefined);
    assert.equal(app.downloadCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(app.stored), /DO_NOT_STORE_SECRET|private\.test/);
  });

  it('clears stale connected metadata when the current page has no receiver and persists a precise failure', async (context) => {
    const app = await background(context);
    app.stored[`player.tab.${tabId}`] = { tabId, track, playbackState: 'playing', updatedAt: 100, connection: 'connected', error: null };
    app.setReceiver(false);
    const player = await app.send({ type: 'GET_PLAYER_STATE' });
    assert.equal(player.type, 'PLAYER_STATE');
    if (player.type !== 'PLAYER_STATE') return;
    assert.equal(player.sources[0]?.track, null);
    assert.equal(player.sources[0]?.connection, 'waiting');
    assert.deepEqual(await app.send({ type: 'DOWNLOAD_TRACK', tabId, track }), { type: 'DOWNLOAD_UNAVAILABLE', reason: 'bridge-unavailable' });
    const result = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    assert.equal(result.type, 'DOWNLOAD_STATUS');
    if (result.type !== 'DOWNLOAD_STATUS') return;
    assert.equal(result.attempt?.phase, 'failed');
    assert.equal(result.attempt?.reason, 'bridge-unavailable');
    assert.equal(app.downloadCalls.length, 0);
  });

  it('preserves native failures after the request finishes without persisting arbitrary error messages or blob URLs', async (context) => {
    const app = await background(context);
    app.setNativeError('Network request failed for https://private.test/audio?token=secret');
    const response = await app.send({ type: 'DOWNLOAD_TRACK', tabId, track });
    assert.equal(response.type, 'ERROR');
    const result = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (result.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing status');
    assert.equal(result.attempt?.phase, 'failed');
    assert.equal(result.attempt?.reason, 'native-start-failed');
    assert.equal(result.attempt?.nativeError, 'NATIVE_ERROR');
    assert.equal(JSON.stringify(app.stored).includes('private.test'), false);
    assert.equal(JSON.stringify(app.stored).includes('blob:'), false);
    assert.equal(app.releases.length, 1);
    app.setNativeError('Download canceled by user');
    await app.send({ type: 'DOWNLOAD_TRACK', tabId, track });
    const retry = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (retry.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing retry status');
    assert.notEqual(retry.attempt?.requestId, result.attempt?.requestId);
    assert.equal(retry.attempt?.phase, 'cancelled');
    assert.equal(retry.attempt?.nativeError, 'USER_CANCELED');
  });

  it('reconciles a worker-orphaned preparation and an already finished native download from persisted state', async (context) => {
    const app = await background(context);
    const attempt: DownloadAttempt = { tabId, requestId, track, phase: 'preparing', progress: 40, reason: null, nativeError: null, downloadId: null, updatedAt: 10 };
    app.stored[attemptKey] = attempt;
    const cancelled = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (cancelled.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing status');
    assert.equal(cancelled.attempt?.phase, 'cancelled');
    assert.equal(cancelled.attempt?.reason, 'hls-cancelled');
    app.stored[attemptKey] = { ...attempt, phase: 'started', downloadId: 78 };
    app.downloads.set(78, { id: 78, state: 'complete' });
    const complete = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (complete.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing status');
    assert.equal(complete.attempt?.phase, 'complete');
    assert.equal(complete.attempt?.progress, 100);
  });

  it('does not let an older native completion replace the latest attempt for the same tab', async (context) => {
    const app = await background(context);
    const first = await app.send({ type: 'DOWNLOAD_TRACK', tabId, track });
    if (first.type !== 'DOWNLOAD_STARTED') return assert.fail('First download was not started');
    await app.send({ type: 'DOWNLOAD_TRACK', tabId, track: { ...track, title: 'Следующий трек' } });
    const latest = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    app.downloads.set(first.downloadId, { id: first.downloadId, state: 'complete' });
    app.changeDownload(first.downloadId, 'complete');
    const final = await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    if (latest.type !== 'DOWNLOAD_STATUS' || final.type !== 'DOWNLOAD_STATUS') return assert.fail('Missing status');
    assert.equal(final.attempt?.requestId, latest.attempt?.requestId);
    assert.equal(final.attempt?.track.title, 'Следующий трек');
    assert.equal(final.attempt?.phase, 'started');
  });

  it('does not start a file or recreate storage after the originating tab is closed during preparation', async (context) => {
    const app = await background(context);
    let finish: ((value: unknown) => void) | undefined;
    let signalResolve: (() => void) | undefined;
    const resolving = new Promise<void>((resolve) => { signalResolve = resolve; });
    app.setResolveDownload(async () => { signalResolve!(); return new Promise((resolve) => { finish = resolve; }); });
    const pending = app.send({ type: 'DOWNLOAD_TRACK', tabId, track });
    await resolving;
    const attempt = app.stored[attemptKey] as DownloadAttempt;
    app.removeTab();
    finish!({ type: 'DOWNLOAD_SOURCE', requestId: attempt.requestId, documentKey,
      resolution: { status: 'assembled', url: `blob:https://zvuk.com/${requestId}`, extension: 'm4a' } });
    assert.deepEqual(await pending, { type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-cancelled' });
    await app.send({ type: 'GET_DOWNLOAD_STATUS', tabId });
    assert.equal(app.stored[attemptKey], undefined);
    assert.equal(app.downloadCalls.length, 0);
    assert.deepEqual(app.releases, [attempt.requestId]);
  });
});
