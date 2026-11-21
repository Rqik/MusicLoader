import { HlsDownloadError, resolveHlsKeyUrl, resolveHlsUrl } from '../lib/hls';
import type { HlsRequestFailure } from '../lib/hls-request';
import { hlsRequestPacer, type RequestPacer } from '../lib/request-pacer';

type Resource = HlsRequestFailure['resource'];

const resourceByteLimits: Record<Resource, number> = {
  manifest: 256 * 1024,
  init: 8 * 1024 * 1024,
  segment: 8 * 1024 * 1024,
  key: 16,
};
export const maxHlsDownloadBytes = 64 * 1024 * 1024;
const requestTimeoutMs = 15_000;
const nonceAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function createZvukKeyNonce(): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(random, (byte) => nonceAlphabet.charAt(byte % nonceAlphabet.length)).join('');
}

export interface HlsTransportOptions {
  fetchResource?: (url: string, init: RequestInit) => Promise<Response>;
  pacer?: Pick<RequestPacer, 'start'>;
}

/** One byte budget per download, with a browser pacer shared across attempts in the page. */
export function createHlsResourceReader(trackId: string, signal: AbortSignal, {
  fetchResource = (url, init) => fetch(url, init),
  pacer = hlsRequestPacer,
}: HlsTransportOptions = {}) {
  let totalBytes = 0;

  return async function readResource(rawUrl: string, resource: Resource) {
    if (signal.aborted) throw new HlsDownloadError('hls-cancelled');
    const isKey = resource === 'key';
    const url = isKey ? resolveHlsKeyUrl(rawUrl, undefined, trackId) : resolveHlsUrl(rawUrl);
    const isZvukKey = isKey && new URL(url).origin === 'https://zvuk.com';
    // This check runs after the route, public query and track ID have been validated.
    const credentials = isZvukKey ? 'same-origin' : 'omit';
    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let byteCount = 0;
    let httpStatus: number | null = null;
    let hasTimedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function requestFailure(kind: HlsRequestFailure['kind']) {
      return new HlsDownloadError('hls-request-failed', { resource, kind, httpStatus });
    }
    function abortRequest() {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
    function checkRequest() {
      if (signal.aborted) throw new HlsDownloadError('hls-cancelled');
      if (hasTimedOut) throw requestFailure('timeout');
    }
    signal.addEventListener('abort', abortRequest, { once: true });
    try {
      const response = await pacer.start(signal, () => {
        checkRequest();
        // Queue time counts toward the operation deadline. This timeout starts at the fetch.
        timer = setTimeout(() => { hasTimedOut = true; abortRequest(); }, requestTimeoutMs);
        return fetchResource(url, {
          method: 'GET', mode: 'cors', credentials, redirect: 'error',
          referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
          ...(isZvukKey ? { headers: { 'X-Encrypted-Key': createZvukKeyNonce() } } : {}),
        });
      });
      httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      checkRequest();
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw requestFailure(httpStatus === null ? 'network' : 'http');
      }
      if (!response.body) throw requestFailure('empty-body');
      if (isZvukKey) {
        // The player uses this nonce with its own configured response cipher.
        // A 16-byte response from this route is not evidence of a raw identity key.
        void response.body.cancel().catch(() => undefined);
        throw new HlsDownloadError('hls-wrapped-key', { resource, kind: 'invalid-data', httpStatus });
      }
      reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (!chunk.done && isKey && (signal.aborted || hasTimedOut)) chunk.value.fill(0);
        checkRequest();
        if (chunk.done) break;
        byteCount += chunk.value.byteLength;
        totalBytes += chunk.value.byteLength;
        if (byteCount > resourceByteLimits[resource] || totalBytes > maxHlsDownloadBytes) {
          if (isKey) chunk.value.fill(0);
          abortRequest();
          const code = totalBytes > maxHlsDownloadBytes || !isKey ? 'hls-too-large' : 'hls-invalid-data';
          throw new HlsDownloadError(code, { resource, kind: 'invalid-data', httpStatus });
        }
        chunks.push(chunk.value);
      }
      if (!byteCount) throw requestFailure('empty-body');
      const bytes = new Uint8Array(byteCount);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, httpStatus };
    } catch (error) {
      if (error instanceof HlsDownloadError) throw error;
      checkRequest();
      throw requestFailure('network');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abortRequest);
      reader?.releaseLock();
      if (isKey) for (const chunk of chunks) chunk.fill(0);
    }
  };
}
