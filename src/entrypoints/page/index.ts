import { isTrack, normalizeMetadata, resolveTrackIdentity } from '../../features/player/lib/metadata';
import { createAudioDiagnostics } from '../../features/diagnostics/observe-audio';
import { BRIDGE_VERSION, type PageUpdate } from '../../shared/messaging/bridge';
import type { PlaybackState, PlayerError } from '../../features/player/types';
import type { Track } from '../../shared/types/track';
import { inspectDownloadSource, type DownloadResolution } from '../../features/downloads/lib/direct-download';
import { isDocumentKey } from '../../shared/messaging/messages';
import { createHlsSourceTracker } from '../../features/downloads/lib/hls-sources';
import { downloadHlsTrack } from '../../features/downloads/services/hls-download';
import { HlsDownloadError } from '../../features/downloads/lib/hls';

let channel: string | null = null;
let lastTrack = '';
let lastReport = '';
let diagnostics: ReturnType<typeof createAudioDiagnostics> | null = null;
let timer: number | undefined;
const encryptedElements = new WeakSet<HTMLMediaElement>();
let sources: ReturnType<typeof createHlsSourceTracker> | null = null;
let activeDownload: { requestId: string; controller: AbortController; timer: number } | null = null;
let preparedFile: { requestId: string; url: string; timer: number } | null = null;
function handleEncrypted(event: Event) {
  if (event.target instanceof HTMLMediaElement) encryptedElements.add(event.target);
}

function sendUpdate(update: PageUpdate) { window.postMessage(update, location.origin); }
function releaseFile(requestId?: string) {
  if (!preparedFile || requestId !== undefined && preparedFile.requestId !== requestId) return;
  window.clearTimeout(preparedFile.timer);
  URL.revokeObjectURL(preparedFile.url);
  preparedFile = null;
}
function cancelDownload(requestId?: string) {
  if (activeDownload && (requestId === undefined || activeDownload.requestId === requestId)) activeDownload.controller.abort();
}
async function resolveDownload(requestId: string, expected: Track, requestChannel: string) {
  if (activeDownload) {
    sendUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel: requestChannel, type: 'DOWNLOAD_RESULT', requestId, resolution: { status: 'unavailable', reason: 'bridge-unavailable' } });
    return;
  }
  const controller = new AbortController();
  const job = { requestId, controller, timer: window.setTimeout(() => controller.abort(), 150000) };
  activeDownload = job;
  let lastProgress = -1;
  let resolution: DownloadResolution;
  try {
    const metadata = normalizeMetadata(navigator.mediaSession?.metadata);
    const current = metadata ? resolveTrackIdentity(metadata, document) : null;
    if (!current) resolution = { status: 'unavailable', reason: 'no-track' };
    else if (current.title !== expected.title || current.artist !== expected.artist || current.album !== expected.album || current.id !== expected.id) {
      resolution = { status: 'unavailable', reason: 'track-changed' };
    } else {
      resolution = inspectDownloadSource(document, (element) => encryptedElements.has(element));
      const hasHls = sources?.hasObserved() ?? false;
      const discovery = sources?.readDiscovery(current.id);
      const candidates = current.id ? sources?.forTrack(current.id) ?? [] : [];
      const needsHls = resolution.status === 'unavailable' && ['no-source', 'stream-source'].includes(resolution.reason)
        || resolution.status === 'ready' && resolution.extension === 'mp4' && candidates.length > 0;
      if (needsHls && (hasHls || discovery && discovery.playlistObservations > 0)) {
        if (!current.id) throw new HlsDownloadError('hls-ambiguous');
        if (!candidates.length && discovery?.acceptedObservations === 0 && discovery.rejectedPrivate > 0) throw new HlsDownloadError('hls-private-url');
        if (!candidates.length) throw new HlsDownloadError('hls-no-source');
        const blob = await downloadHlsTrack(candidates, current.id, controller.signal, (progress) => {
          const value = Math.max(0, Math.min(99, Math.round(progress)));
          if (value === lastProgress) return;
          lastProgress = value;
          if (channel === requestChannel) sendUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel: requestChannel, type: 'DOWNLOAD_PROGRESS', requestId, progress: value });
        });
        if (controller.signal.aborted || channel !== requestChannel) throw new HlsDownloadError('hls-cancelled');
        releaseFile();
        const url = URL.createObjectURL(blob);
        preparedFile = { requestId, url, timer: window.setTimeout(() => releaseFile(requestId), 300000) };
        resolution = { status: 'assembled', url, extension: 'm4a' };
      }
    }
  } catch (error) {
    resolution = { status: 'unavailable', reason: error instanceof HlsDownloadError ? error.code : controller.signal.aborted ? 'hls-cancelled' : 'hls-request-failed',
      ...(error instanceof HlsDownloadError && error.request ? { request: error.request } : {}) };
  } finally {
    window.clearTimeout(job.timer);
    if (activeDownload === job) activeDownload = null;
  }
  if (channel === requestChannel) sendUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel: requestChannel, type: 'DOWNLOAD_RESULT', requestId, resolution });
  else releaseFile(requestId);
}
function sample(isForced = false) {
  if (!channel) return;
  let track: Track | null = null;
  let playbackState: PlaybackState = 'none';
  let error: PlayerError = null;
  try {
    const session = navigator.mediaSession;
    const normalized = normalizeMetadata(session?.metadata);
    track = normalized ? resolveTrackIdentity(normalized, document) : null;
    playbackState = session?.playbackState ?? 'none';
    if (!session) error = 'media-session-unavailable';
  } catch { error = 'metadata-read-failed'; }
  const fingerprint = JSON.stringify([track, playbackState, error]);
  if (isForced || fingerprint !== lastTrack) {
    lastTrack = fingerprint;
    sendUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'TRACK', track, playbackState, error });
  }
  if (diagnostics) {
    try {
      const report = { ...diagnostics.read(), ...(sources ? { hlsDiscovery: sources.readDiscovery(track?.id ?? null) } : {}) };
      const fingerprint = JSON.stringify(report);
      if (fingerprint !== lastReport) {
        lastReport = fingerprint;
        sendUpdate({ source: 'musicloader:page', version: BRIDGE_VERSION, channel, type: 'DIAGNOSTICS', report });
      }
    } catch { /* Закрытый или недоступный media-элемент не останавливает чтение metadata. */ }
  }
}
function handleMessage(event: MessageEvent<unknown>) {
  if (event.source !== window || event.origin !== location.origin || typeof event.data !== 'object' || event.data === null) return;
  const message = event.data as Record<string, unknown>;
  if (message.source !== 'musicloader:content' || message.version !== BRIDGE_VERSION
    || typeof message.channel !== 'string' || !/^[a-f0-9-]{36}$/.test(message.channel)) return;
  if (message.type === 'CONNECT') {
    if (channel !== message.channel) { cancelDownload(); releaseFile(); }
    channel = message.channel;
    sample(true);
  } else if (message.channel === channel && message.type === 'RESOLVE_DOWNLOAD' && isDocumentKey(message.requestId) && isTrack(message.track)) {
    void resolveDownload(message.requestId, message.track, message.channel);
  } else if (message.channel === channel && isDocumentKey(message.requestId) && message.type === 'CANCEL_DOWNLOAD') {
    cancelDownload(message.requestId);
    releaseFile(message.requestId);
  } else if (message.channel === channel && isDocumentKey(message.requestId) && message.type === 'RELEASE_DOWNLOAD') {
    releaseFile(message.requestId);
  } else if (message.channel === channel && message.type === 'DIAGNOSTICS' && typeof message.isEnabled === 'boolean') {
    if (message.isEnabled && !diagnostics) diagnostics = createAudioDiagnostics();
    if (!message.isEnabled) { diagnostics?.dispose(); diagnostics = null; }
    lastReport = '';
    sample();
  }
}
function start() {
  window.clearInterval(timer);
  window.addEventListener('message', handleMessage);
  window.addEventListener('encrypted', handleEncrypted, true);
  sources?.dispose(); sources = createHlsSourceTracker();
  timer = window.setInterval(sample, 1000);
}
function stop() {
  window.clearInterval(timer);
  window.removeEventListener('message', handleMessage);
  window.removeEventListener('encrypted', handleEncrypted, true);
  cancelDownload(); releaseFile(); sources?.dispose(); sources = null;
  diagnostics?.dispose(); diagnostics = null; channel = null; lastTrack = ''; lastReport = '';
}
window.addEventListener('pagehide', stop);
window.addEventListener('pageshow', (event) => { if (event.persisted) start(); });
start();
