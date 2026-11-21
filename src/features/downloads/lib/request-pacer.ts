export const HLS_REQUEST_INTERVAL_MS = 300;

interface PacerClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const browserClock: PacerClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** Spaces actual request starts; response bodies may still overlap. */
export class RequestPacer {
  private readonly queue: Array<{ launch(): void }> = [];
  private lastStarted: number | null = null;
  private cancelTimer: (() => void) | null = null;

  constructor(private readonly clock: PacerClock = browserClock) {}

  start<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const entry = {
        launch: () => {
          signal.removeEventListener('abort', cancel);
          this.lastStarted = this.clock.now();
          try { resolve(action()); } catch (error) { reject(error); }
        },
      };
      const cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener('abort', cancel);
        reject(new DOMException('Aborted', 'AbortError'));
        this.pump();
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (!this.queue.length) return;
    const remaining = this.lastStarted === null ? 0
      : Math.ceil(this.lastStarted + HLS_REQUEST_INTERVAL_MS - this.clock.now());
    if (remaining > 0) {
      // Recheck the monotonic clock when waking: timers can fire early.
      this.cancelTimer = this.clock.schedule(() => { this.cancelTimer = null; this.pump(); }, remaining);
      return;
    }
    this.queue.shift()!.launch();
    if (this.queue.length) this.pump();
  }
}

// Shared across downloads in this page so retrying does not reset the interval.
export const hlsRequestPacer = new RequestPacer();
