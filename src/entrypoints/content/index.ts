import { BRIDGE_VERSION, isBridgeUpdate } from '../../shared/messaging/bridge';
import { isExtensionMessage, isExtensionResponse, type ExtensionMessage, type ExtensionResponse } from '../../shared/messaging/messages';

let channel = crypto.randomUUID();
let pending: Extract<ExtensionMessage, { type: 'TRACK_UPDATE' }> | null = null;
let confirmed = '';
let hasSnapshot = false;
let isSending = false;
let isDiagnosticsEnabled = false;
let hasDiagnosticsConfiguration = false;
let timer: number | undefined;
let attempts = 0;
let downloadRequest: { requestId: string; timer: number; heartbeat: number; progress: number; respond: (response: ExtensionResponse) => void } | null = null;
function postDownloadCommand(type: 'CANCEL_DOWNLOAD' | 'RELEASE_DOWNLOAD', requestId: string) {
  window.postMessage({ source: 'musicloader:content', version: BRIDGE_VERSION, channel, type, requestId }, location.origin);
}
async function reportDownloadProgress() {
  const request = downloadRequest;
  if (!request) return;
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', documentKey: channel, requestId: request.requestId, progress: request.progress } satisfies ExtensionMessage);
    if (downloadRequest === request && isExtensionResponse(response) && response.type === 'DOWNLOAD_KEEPALIVE' && !response.isActive) {
      postDownloadCommand('CANCEL_DOWNLOAD', request.requestId);
      finishDownload({ status: 'unavailable', reason: 'hls-cancelled' });
    }
  } catch {
    if (downloadRequest === request) {
      postDownloadCommand('CANCEL_DOWNLOAD', request.requestId);
      finishDownload({ status: 'unavailable', reason: 'hls-cancelled' });
    }
  }
}
function finishDownload(resolution: Extract<ExtensionResponse, { type: 'DOWNLOAD_SOURCE' }>['resolution']) {
  if (!downloadRequest) return;
  const request = downloadRequest;
  downloadRequest = null;
  window.clearTimeout(request.timer);
  window.clearInterval(request.heartbeat);
  try { request.respond({ type: 'DOWNLOAD_SOURCE', requestId: request.requestId, documentKey: channel, resolution }); } catch { /* The original worker may have restarted. */ }
}

function post(type: 'CONNECT' | 'DIAGNOSTICS') {
  window.postMessage({ source: 'musicloader:content', version: BRIDGE_VERSION, channel, type, isEnabled: isDiagnosticsEnabled }, location.origin);
}
function setDiagnostics(isEnabled: boolean) {
  if (isDiagnosticsEnabled === isEnabled) return;
  isDiagnosticsEnabled = isEnabled;
  post('DIAGNOSTICS');
}
async function flush() {
  if (!pending || isSending || JSON.stringify(pending) === confirmed) return;
  isSending = true;
  const message = pending;
  const sentChannel = channel;
  try {
    const response: unknown = await chrome.runtime.sendMessage(message);
    if (sentChannel === channel && isExtensionResponse(response) && response.type === 'ACK') {
      confirmed = JSON.stringify(message);
      if (!hasDiagnosticsConfiguration) {
        setDiagnostics(response.isDiagnosticsEnabled);
        hasDiagnosticsConfiguration = true;
      }
    }
  } catch {
    if (!chrome.runtime?.id) stop();
  } finally { if (sentChannel === channel) isSending = false; }
}
function handlePageMessage(event: MessageEvent<unknown>) {
  if (event.source !== window || event.origin !== location.origin || !isBridgeUpdate(event.data, channel)) return;
  const message = event.data;
  if (message.type === 'TRACK') {
    hasSnapshot = true;
    pending = { type: 'TRACK_UPDATE', documentKey: channel, track: message.track, playbackState: message.playbackState, error: message.error };
    void flush();
  } else if (message.type === 'DOWNLOAD_RESULT') {
    if (message.requestId === downloadRequest?.requestId) finishDownload(message.resolution);
    else if (message.resolution.status === 'assembled') postDownloadCommand('RELEASE_DOWNLOAD', message.requestId);
  } else if (message.type === 'DOWNLOAD_PROGRESS') {
    if (downloadRequest?.requestId === message.requestId) {
      downloadRequest.progress = message.progress;
      void reportDownloadProgress();
    }
  } else if (isDiagnosticsEnabled) {
    void chrome.runtime.sendMessage({ type: 'DIAGNOSTICS_REPORT', documentKey: channel, report: message.report } satisfies ExtensionMessage).catch(() => {
      if (!chrome.runtime?.id) stop();
    });
  }
}
const handleRuntimeMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isExtensionMessage(message)) return false;
  if (message.type === 'GET_DOCUMENT_KEY') {
    sendResponse({ type: 'DOCUMENT_KEY', documentKey: channel } satisfies ExtensionResponse);
    return false;
  }
  if (message.type === 'REFRESH_PLAYER') {
    stop(); start();
    sendResponse({ type: 'ACK', isDiagnosticsEnabled } satisfies ExtensionResponse);
    return false;
  }
  if (message.type === 'RESOLVE_DOWNLOAD') {
    if (downloadRequest) {
      sendResponse({ type: 'DOWNLOAD_SOURCE', requestId: message.requestId, documentKey: channel, resolution: { status: 'unavailable', reason: 'bridge-unavailable' } } satisfies ExtensionResponse);
      return false;
    }
    downloadRequest = { requestId: message.requestId, respond: sendResponse, progress: 0,
      timer: window.setTimeout(() => { postDownloadCommand('CANCEL_DOWNLOAD', message.requestId); finishDownload({ status: 'unavailable', reason: 'hls-cancelled' }); }, 160000),
      heartbeat: window.setInterval(() => { void reportDownloadProgress(); }, 5000) };
    window.postMessage({ source: 'musicloader:content', version: BRIDGE_VERSION, channel, type: 'RESOLVE_DOWNLOAD', requestId: message.requestId, track: message.track }, location.origin);
    return true;
  }
  if (message.type === 'RELEASE_DOWNLOAD') {
    postDownloadCommand('RELEASE_DOWNLOAD', message.requestId);
    sendResponse({ type: 'ACK', isDiagnosticsEnabled } satisfies ExtensionResponse);
    return false;
  }
  if (message.type !== 'SET_BRIDGE_DIAGNOSTICS') return false;
  hasDiagnosticsConfiguration = true;
  setDiagnostics(message.isEnabled);
  sendResponse({ type: 'ACK', isDiagnosticsEnabled } satisfies ExtensionResponse);
  return false;
};
function start() {
  channel = crypto.randomUUID(); hasSnapshot = false; confirmed = ''; attempts = 0; pending = null; isDiagnosticsEnabled = false; hasDiagnosticsConfiguration = false; isSending = false;
  window.addEventListener('message', handlePageMessage);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  post('CONNECT');
  timer = window.setInterval(() => {
    if (!hasSnapshot) {
      post('CONNECT'); attempts += 1;
      if (attempts === 5) pending = { type: 'TRACK_UPDATE', documentKey: channel, track: null, playbackState: 'none', error: 'bridge-unavailable' };
    }
    void flush();
  }, 1000);
}
function stop() {
  if (downloadRequest) postDownloadCommand('CANCEL_DOWNLOAD', downloadRequest.requestId);
  finishDownload({ status: 'unavailable', reason: 'bridge-unavailable' });
  window.clearInterval(timer);
  window.removeEventListener('message', handlePageMessage);
  try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch { /* Контекст уже удалён при обновлении расширения. */ }
  isDiagnosticsEnabled = false; post('DIAGNOSTICS');
}
window.addEventListener('pagehide', stop);
window.addEventListener('pageshow', (event) => { if (event.persisted) start(); });
start();
