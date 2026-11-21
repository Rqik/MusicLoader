const mimeType = 'audio/webm;codecs=opus';
const maxDurationMs = 15 * 60_000;
const maxBytes = 64 * 1024 * 1024;

export type RecordingFailure = 'unsupported' | 'selection-denied' | 'wrong-surface' | 'no-audio' | 'empty' | 'too-large' | 'capture-failed';
type RecordingResult = { blob: Blob; hasReachedTimeLimit: boolean };

export class RecordingError extends Error {
  constructor(public readonly code: RecordingFailure) { super(code); }
}

export async function recordTabAudio(
  signal: AbortSignal,
  onStarted: (stop: () => void) => void,
): Promise<RecordingResult> {
  signal.throwIfAborted();
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mimeType)) {
    throw new RecordingError('unsupported');
  }

  // Chrome requires a video surface for the picker. Only its audio track goes into the recorder.
  const options = {
    audio: true,
    video: { displaySurface: 'browser' },
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'exclude',
    systemAudio: 'exclude',
    windowAudio: 'exclude',
    surfaceSwitching: 'exclude',
  };
  let capture: MediaStream;
  try {
    capture = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (error) {
    if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) {
      throw new RecordingError('selection-denied');
    }
    throw new RecordingError('capture-failed');
  }

  const tracks = capture.getTracks();
  const listeners = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    if (capture.getVideoTracks()[0]?.getSettings().displaySurface !== 'browser') {
      throw new RecordingError('wrong-surface');
    }
    const audio = capture.getAudioTracks().find((track) => track.readyState === 'live');
    if (!audio) throw new RecordingError('no-audio');

    const recorder = new MediaRecorder(new MediaStream([audio]), { mimeType, audioBitsPerSecond: 192_000 });
    const chunks: Blob[] = [];
    let size = 0;
    let hasReachedTimeLimit = false;
    function stop() {
      if (recorder.state !== 'inactive') recorder.stop();
    }
    return await new Promise<RecordingResult>((resolve, reject) => {
      const eventOptions = { signal: listeners.signal };
      signal.addEventListener('abort', () => reject(signal.reason), { ...eventOptions, once: true });
      for (const track of tracks) track.addEventListener('ended', stop, eventOptions);
      recorder.addEventListener('dataavailable', ({ data }) => {
        size += data.size;
        if (size > maxBytes) reject(new RecordingError('too-large'));
        else if (data.size) chunks.push(data);
      }, eventOptions);
      recorder.addEventListener('error', () => reject(new RecordingError('capture-failed')), eventOptions);
      recorder.addEventListener('stop', () => {
        if (!size) reject(new RecordingError('empty'));
        else resolve({ blob: new Blob(chunks, { type: mimeType }), hasReachedTimeLimit });
      }, { ...eventOptions, once: true });

      recorder.start(1000);
      timer = setTimeout(() => { hasReachedTimeLimit = true; stop(); }, maxDurationMs);
      onStarted(stop);
    });
  } finally {
    clearTimeout(timer);
    listeners.abort();
    for (const track of tracks) track.stop();
  }
}
