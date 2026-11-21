import { isExtensionMessage, isExtensionResponse, isPlayerSnapshot, type ExtensionMessage, type ExtensionResponse } from '../../shared/messaging/messages';
import { isDiagnosticsRecord, type DiagnosticsRecord } from '../../features/diagnostics/validation';
import { PLAYER_KEY_PREFIX, DIAGNOSTICS_KEY_PREFIX, isZvukUrl, type PlayerSnapshot } from '../../features/player/types';
import { createDownloadFilename, type DownloadUnavailableReason } from '../../features/downloads/lib/direct-download';
import { DOWNLOAD_ATTEMPT_PREFIX, isDownloadAttempt, type DownloadAttempt } from '../../features/downloads/lib/download-attempt';
import type { Track } from '../../shared/types/track';
import type { HlsRequestFailure } from '../../features/downloads/lib/hls-request';

const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let writes: Promise<unknown> = ready;
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation);
  writes = result.catch(() => undefined);
  return result;
}
async function readDiagnostics(tabId: number): Promise<DiagnosticsRecord> {
  const value: unknown = (await chrome.storage.local.get(`${DIAGNOSTICS_KEY_PREFIX}${tabId}`))[`${DIAGNOSTICS_KEY_PREFIX}${tabId}`];
  return isDiagnosticsRecord(value) ? value : { tabId, isEnabled: false, report: null, updatedAt: Date.now() };
}
async function getPlayerState(): Promise<ExtensionResponse> {
  await ready; await writes;
  const [tabs, activeTabs, stored] = await Promise.all([
    chrome.tabs.query({ url: ['https://*.zvuk.com/*'] }),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }), chrome.storage.local.get(null),
  ]);
  const sources: PlayerSnapshot[] = [];
  const diagnostics: DiagnosticsRecord[] = [];
  const liveDocuments = await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined || tab.status === 'loading') return false;
    try {
      const current: unknown = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOCUMENT_KEY' } satisfies ExtensionMessage, { frameId: 0 });
      return isExtensionResponse(current) && current.type === 'DOCUMENT_KEY';
    } catch { return false; }
  }));
  for (const [index, tab] of tabs.entries()) {
    if (tab.id === undefined) continue;
    const source: unknown = stored[`${PLAYER_KEY_PREFIX}${tab.id}`];
    sources.push(liveDocuments[index] && isPlayerSnapshot(source) && source.tabId === tab.id ? source : {
      tabId: tab.id, track: null, playbackState: 'none', updatedAt: 0, connection: 'waiting', error: null,
    });
    const diagnostic: unknown = stored[`${DIAGNOSTICS_KEY_PREFIX}${tab.id}`];
    if (isDiagnosticsRecord(diagnostic) && diagnostic.tabId === tab.id) diagnostics.push(diagnostic);
  }
  return { type: 'PLAYER_STATE', sources, diagnostics, activeTabId: activeTabs[0]?.id ?? null };
}
function isPopupSender(sender: chrome.runtime.MessageSender) {
  return sender.url === chrome.runtime.getURL('popup.html');
}
interface DownloadJob { key: string; requestId: string; documentKey: string | null; track: Track; request?: Promise<ExtensionResponse> }
const downloadRequests = new Map<number, DownloadJob>();
const preparedDownloads = new Map<number, { tabId: number; requestId: string; isPrepared: boolean }>();
async function readAttempt(tabId: number): Promise<DownloadAttempt | null> {
  const key = `${DOWNLOAD_ATTEMPT_PREFIX}${tabId}`;
  const value: unknown = (await chrome.storage.local.get(key))[key];
  return isDownloadAttempt(value) && value.tabId === tabId ? value : null;
}
function updateAttempt(
  tabId: number,
  requestId: string,
  changes: Partial<Pick<DownloadAttempt, 'phase' | 'progress' | 'reason' | 'nativeError' | 'downloadId' | 'request'>>,
  phases?: readonly DownloadAttempt['phase'][],
): Promise<void> {
  return serialize(async () => {
    const previous = await readAttempt(tabId);
    if (!previous || previous.requestId !== requestId || phases && !phases.includes(previous.phase)) return;
    await chrome.storage.local.set({ [`${DOWNLOAD_ATTEMPT_PREFIX}${tabId}`]: { ...previous, ...changes, updatedAt: Date.now() } satisfies DownloadAttempt });
  });
}
function nativeStartError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/cancel(?:ed|led)/i.test(message)) return 'USER_CANCELED';
  if (/permission/i.test(message)) return 'MISSING_PERMISSION';
  return 'NATIVE_ERROR';
}
function nativeDownloadError(error: unknown): string {
  return typeof error === 'string' && /^[A-Z_]{1,64}$/.test(error) ? error : 'NATIVE_ERROR';
}
async function unavailable(tabId: number, requestId: string, reason: DownloadUnavailableReason, request?: HlsRequestFailure): Promise<ExtensionResponse> {
  const details = request ? { request } : {};
  await updateAttempt(tabId, requestId, { phase: reason === 'hls-cancelled' ? 'cancelled' : 'failed', reason, nativeError: null, ...details });
  return { type: 'DOWNLOAD_UNAVAILABLE', reason, ...details };
}
async function cancelOrphanAttempt(tabId: number, requestId: string) {
  const previous = await readAttempt(tabId);
  if (previous?.requestId === requestId && previous.downloadId === null) {
    await updateAttempt(tabId, requestId, { phase: 'cancelled', reason: 'hls-cancelled', nativeError: null }, ['checking', 'preparing', 'starting']);
  }
}
async function getDownloadStatus(tabId: number): Promise<ExtensionResponse> {
  await ready; await writes;
  const attempt = await readAttempt(tabId);
  if (attempt) {
    if (attempt.downloadId !== null && attempt.phase === 'started') {
      await checkDownloadCompletion(attempt.downloadId).catch(() => undefined);
    } else if (attempt.downloadId === null && downloadRequests.get(tabId)?.requestId !== attempt.requestId) {
      await cancelOrphanAttempt(tabId, attempt.requestId);
    }
  }
  await writes;
  return { type: 'DOWNLOAD_STATUS', attempt: await readAttempt(tabId) };
}
async function releasePrepared(tabId: number, requestId: string) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'RELEASE_DOWNLOAD', requestId } satisfies ExtensionMessage, { frameId: 0 }); } catch { /* A closed page releases its own object URL. */ }
}
async function checkDownloadCompletion(downloadId: number) {
  let prepared = preparedDownloads.get(downloadId);
  if (!prepared) {
    await ready; await writes;
    const stored = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith(DOWNLOAD_ATTEMPT_PREFIX) && isDownloadAttempt(value) && value.downloadId === downloadId) {
        prepared = { tabId: value.tabId, requestId: value.requestId, isPrepared: false };
        break;
      }
    }
  }
  if (!prepared) return;
  const [download] = await chrome.downloads.search({ id: downloadId });
  if (!download || download.state === 'complete' || download.state === 'interrupted') {
    if (download?.state === 'complete') {
      await updateAttempt(prepared.tabId, prepared.requestId, { phase: 'complete', progress: 100, reason: null, nativeError: null });
    } else {
      const nativeError = nativeDownloadError(download?.error);
      await updateAttempt(prepared.tabId, prepared.requestId, { phase: nativeError === 'USER_CANCELED' ? 'cancelled' : 'failed', reason: 'native-download-failed', nativeError });
    }
    preparedDownloads.delete(downloadId);
    if (prepared.isPrepared) await releasePrepared(prepared.tabId, prepared.requestId);
  }
}
function downloadTrack(message: Extract<ExtensionMessage, { type: 'DOWNLOAD_TRACK' }>): Promise<ExtensionResponse> {
  const existing = downloadRequests.get(message.tabId);
  const key = JSON.stringify([message.track.id, message.track.title, message.track.artist, message.track.album]);
  if (existing?.request) return existing.key === key ? existing.request : Promise.resolve({ type: 'DOWNLOAD_UNAVAILABLE', reason: 'track-changed' });
  const job: DownloadJob = { key, requestId: crypto.randomUUID(), documentKey: null, track: message.track };
  downloadRequests.set(message.tabId, job);
  job.request = startDownload(message, job).catch(async (): Promise<ExtensionResponse> => {
    await updateAttempt(message.tabId, job.requestId, { phase: 'failed', reason: 'bridge-unavailable', nativeError: null }).catch(() => undefined);
    return { type: 'DOWNLOAD_UNAVAILABLE', reason: 'bridge-unavailable' };
  });
  void job.request.then(() => { if (downloadRequests.get(message.tabId) === job) downloadRequests.delete(message.tabId); });
  return job.request;
}
async function startDownload(message: Extract<ExtensionMessage, { type: 'DOWNLOAD_TRACK' }>, job: DownloadJob): Promise<ExtensionResponse> {
  await serialize(async () => {
    if (downloadRequests.get(message.tabId) !== job) return;
    await chrome.storage.local.set({ [`${DOWNLOAD_ATTEMPT_PREFIX}${message.tabId}`]: {
      tabId: message.tabId, requestId: job.requestId, track: message.track, phase: 'checking', progress: 0,
      reason: null, nativeError: null, downloadId: null, updatedAt: Date.now(),
    } satisfies DownloadAttempt });
  });
  if (downloadRequests.get(message.tabId) !== job) return { type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-cancelled' };
  const tab = await chrome.tabs.get(message.tabId);
  if (!isZvukUrl(tab.url) || tab.status === 'loading') return unavailable(message.tabId, job.requestId, 'track-changed');
  const { requestId } = job;
  let document: unknown;
  try { document = await chrome.tabs.sendMessage(message.tabId, { type: 'GET_DOCUMENT_KEY' } satisfies ExtensionMessage, { frameId: 0 }); }
  catch { return unavailable(message.tabId, requestId, 'bridge-unavailable'); }
  if (!isExtensionResponse(document) || document.type !== 'DOCUMENT_KEY') return unavailable(message.tabId, requestId, 'bridge-unavailable');
  job.documentKey = document.documentKey;
  await updateAttempt(message.tabId, requestId, { phase: 'preparing' }, ['checking']);
  let response: unknown;
  try { response = await chrome.tabs.sendMessage(message.tabId, { type: 'RESOLVE_DOWNLOAD', requestId, track: message.track } satisfies ExtensionMessage, { frameId: 0 }); }
  catch { return unavailable(message.tabId, requestId, 'bridge-unavailable'); }
  if (!isExtensionResponse(response) || response.type !== 'DOWNLOAD_SOURCE' || response.requestId !== requestId) return unavailable(message.tabId, requestId, 'bridge-unavailable');
  if (downloadRequests.get(message.tabId) !== job) {
    if (response.resolution.status === 'assembled') await releasePrepared(message.tabId, requestId);
    return { type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-cancelled' };
  }
  if (response.resolution.status === 'unavailable') return unavailable(message.tabId, requestId, response.resolution.reason, response.resolution.request);
  let current: unknown;
  try {
    current = await chrome.tabs.sendMessage(message.tabId, { type: 'GET_DOCUMENT_KEY' } satisfies ExtensionMessage, { frameId: 0 });
  } catch {
    if (response.resolution.status === 'assembled') await releasePrepared(message.tabId, requestId);
    return unavailable(message.tabId, requestId, 'bridge-unavailable');
  }
  if (!isExtensionResponse(current) || current.type !== 'DOCUMENT_KEY' || current.documentKey !== response.documentKey || current.documentKey !== job.documentKey) {
    if (response.resolution.status === 'assembled') await releasePrepared(message.tabId, requestId);
    return unavailable(message.tabId, requestId, 'track-changed');
  }
  await updateAttempt(message.tabId, requestId, { phase: 'starting', progress: 100 });
  if (downloadRequests.get(message.tabId) !== job) {
    if (response.resolution.status === 'assembled') await releasePrepared(message.tabId, requestId);
    return { type: 'DOWNLOAD_UNAVAILABLE', reason: 'hls-cancelled' };
  }
  let downloadId: number;
  try {
    // Только явное действие Popup. URL готового файла используется однократно и не попадает в storage.
    downloadId = await chrome.downloads.download({ url: response.resolution.url, filename: createDownloadFilename(message.track, response.resolution.extension), saveAs: true, conflictAction: 'uniquify' });
    if (!Number.isInteger(downloadId) || downloadId < 0) throw new Error('Invalid native download id');
  } catch (error) {
    if (response.resolution.status === 'assembled') await releasePrepared(message.tabId, requestId);
    const nativeError = nativeStartError(error);
    await updateAttempt(message.tabId, requestId, { phase: nativeError === 'USER_CANCELED' ? 'cancelled' : 'failed', reason: 'native-start-failed', nativeError });
    return { type: 'ERROR', message: 'Chrome не начал скачивание. Подробности доступны в статусе последней попытки.' };
  }
  preparedDownloads.set(downloadId, { tabId: message.tabId, requestId, isPrepared: response.resolution.status === 'assembled' });
  await updateAttempt(message.tabId, requestId, { phase: 'started', downloadId, progress: 100, reason: null, nativeError: null });
  void checkDownloadCompletion(downloadId).catch(() => undefined);
  return { type: 'DOWNLOAD_STARTED', downloadId };
}
async function handleContent(message: Extract<ExtensionMessage, { type: 'TRACK_UPDATE' | 'DIAGNOSTICS_REPORT' }>, tabId: number): Promise<ExtensionResponse> {
  return serialize(async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!isZvukUrl(tab.url) || tab.status === 'loading') throw new Error('Document is not ready');
    const current: unknown = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_KEY' } satisfies ExtensionMessage, { frameId: 0 });
    if (!isExtensionResponse(current) || current.type !== 'DOCUMENT_KEY' || current.documentKey !== message.documentKey) throw new Error('Stale document');
    const diagnostic = await readDiagnostics(tabId);
    if (message.type === 'TRACK_UPDATE') {
      const key = `${PLAYER_KEY_PREFIX}${tabId}`;
      const previous: unknown = (await chrome.storage.local.get(key))[key];
      const snapshot: PlayerSnapshot = { tabId, track: message.track, playbackState: message.playbackState,
        updatedAt: Date.now(), connection: message.error ? 'error' : 'connected', error: message.error };
      if (!isPlayerSnapshot(previous) || JSON.stringify([previous.track, previous.playbackState, previous.error]) !== JSON.stringify([snapshot.track, snapshot.playbackState, snapshot.error])) {
        await chrome.storage.local.set({ [key]: snapshot });
      }
    } else if (message.type === 'DIAGNOSTICS_REPORT' && diagnostic.isEnabled) {
      if (JSON.stringify(diagnostic.report) !== JSON.stringify(message.report)) {
        await chrome.storage.local.set({ [`${DIAGNOSTICS_KEY_PREFIX}${tabId}`]: { ...diagnostic, report: message.report, updatedAt: Date.now() } });
      }
    }
    return { type: 'ACK', isDiagnosticsEnabled: diagnostic.isEnabled };
  });
}
async function setDiagnostics(tabId: number, isEnabled: boolean): Promise<ExtensionResponse> {
  await serialize(async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!isZvukUrl(tab.url)) throw new Error('Unsupported tab');
    await chrome.storage.local.set({ [`${DIAGNOSTICS_KEY_PREFIX}${tabId}`]: { tabId, isEnabled, report: null, updatedAt: Date.now() } satisfies DiagnosticsRecord });
  });
  try { await chrome.tabs.sendMessage(tabId, { type: 'SET_BRIDGE_DIAGNOSTICS', isEnabled } satisfies ExtensionMessage, { frameId: 0 }); } catch { /* Вкладку после установки нужно обновить. */ }
  return { type: 'ACK', isDiagnosticsEnabled: isEnabled };
}
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isExtensionMessage(message)) return false;
  if (message.type === 'PING') { sendResponse({ type: 'PONG' } satisfies ExtensionResponse); return false; }
  if (message.type === 'DOWNLOAD_PROGRESS' && sender.frameId === 0 && sender.tab?.id !== undefined && isZvukUrl(sender.url)) {
    const tabId = sender.tab.id;
    const job = downloadRequests.get(tabId);
    const isActive = job?.requestId === message.requestId && job.documentKey === message.documentKey;
    const persisted = isActive
      ? updateAttempt(tabId, message.requestId, { phase: 'preparing', progress: message.progress }, ['checking', 'preparing'])
      : !job ? cancelOrphanAttempt(tabId, message.requestId) : Promise.resolve();
    void persisted.catch(() => undefined).then(() => {
      sendResponse({ type: 'DOWNLOAD_KEEPALIVE', requestId: message.requestId, isActive } satisfies ExtensionResponse);
      if (isActive && job) void chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS_UPDATE', tabId, track: job.track, progress: message.progress } satisfies ExtensionMessage).catch(() => undefined);
    });
    return true;
  }
  let result: Promise<ExtensionResponse>;
  if (isPopupSender(sender) && message.type === 'GET_PLAYER_STATE') result = getPlayerState();
  else if (isPopupSender(sender) && message.type === 'GET_DOWNLOAD_STATUS') result = getDownloadStatus(message.tabId);
  else if (isPopupSender(sender) && message.type === 'SET_DIAGNOSTICS') result = setDiagnostics(message.tabId, message.isEnabled);
  else if (isPopupSender(sender) && message.type === 'DOWNLOAD_TRACK') result = downloadTrack(message);
  else if (sender.frameId === 0 && sender.tab?.id !== undefined && isZvukUrl(sender.url)
    && (message.type === 'TRACK_UPDATE' || message.type === 'DIAGNOSTICS_REPORT')) result = handleContent(message, sender.tab.id);
  else return false;
  void result.then(sendResponse).catch(() => sendResponse({ type: 'ERROR', message: 'Не удалось обновить сведения плеера. Обновите вкладку Звука.' } satisfies ExtensionResponse));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  downloadRequests.delete(tabId);
  for (const [id, prepared] of preparedDownloads) if (prepared.tabId === tabId) preparedDownloads.delete(id);
  void serialize(() => chrome.storage.local.remove([`${PLAYER_KEY_PREFIX}${tabId}`, `${DIAGNOSTICS_KEY_PREFIX}${tabId}`, `${DOWNLOAD_ATTEMPT_PREFIX}${tabId}`])).catch(() => undefined);
});
chrome.downloads.onChanged.addListener((change) => {
  if (change.state) void checkDownloadCompletion(change.id).catch(() => undefined);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' && !(change.url && !isZvukUrl(change.url))) return;
  void serialize(async () => {
    await chrome.storage.local.remove(`${PLAYER_KEY_PREFIX}${tabId}`);
    const diagnostic = await readDiagnostics(tabId);
    if (change.url && !isZvukUrl(change.url)) await chrome.storage.local.remove(`${DIAGNOSTICS_KEY_PREFIX}${tabId}`);
    else if (diagnostic.isEnabled) await chrome.storage.local.set({ [`${DIAGNOSTICS_KEY_PREFIX}${tabId}`]: { ...diagnostic, report: null, updatedAt: Date.now() } });
  }).catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  void serialize(async () => {
    const stored = await chrome.storage.local.get(null);
    // Chrome tab IDs are session-local; a new browser session cannot safely reuse these records.
    await chrome.storage.local.remove(Object.keys(stored).filter((key) => key.startsWith(PLAYER_KEY_PREFIX) || key.startsWith(DIAGNOSTICS_KEY_PREFIX) || key.startsWith(DOWNLOAD_ATTEMPT_PREFIX)));
  }).then(async () => {
    const tabs = await chrome.tabs.query({ url: ['https://*.zvuk.com/*'] });
    // Новый CONNECT отменяет также ACK прежнего сеанса: удалённый снимок будет отправлен снова.
    await Promise.allSettled(tabs.filter((tab) => tab.id !== undefined).map((tab) =>
      chrome.tabs.sendMessage(tab.id!, { type: 'REFRESH_PLAYER' } satisfies ExtensionMessage, { frameId: 0 })));
  }).catch(() => undefined);
});
