/**
 * A periodic callback that keeps firing when the tab is in the background.
 *
 * Browsers throttle main-thread `setInterval` to once a second or slower in hidden
 * tabs, which would starve the lookahead scheduler and stall the sequence. Worker
 * timers are not throttled the same way, so the interval lives in a Worker built
 * from a Blob URL -- no extra file to serve, no build step.
 *
 * The Worker only says "now" and holds no musical state; all scheduling decisions
 * stay on the main thread with the generators.
 */

const WORKER_SOURCE = `
let timer = null;
self.onmessage = (e) => {
  if (e.data.command === 'start') {
    clearInterval(timer);
    timer = setInterval(() => self.postMessage('tick'), e.data.interval);
  } else if (e.data.command === 'stop') {
    clearInterval(timer);
    timer = null;
  }
};
`;

export class Ticker {
  constructor(intervalMs = 25) {
    this.intervalMs = intervalMs;
    this.onTick = null;
    this.worker = null;
    this.fallbackTimer = null;

    try {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      // The worker keeps running once constructed, so the URL can go immediately.
      URL.revokeObjectURL(url);
      this.worker.onmessage = () => this.onTick?.();
    } catch (err) {
      // Workers may be unavailable (strict CSP, exotic environment). A
      // main-thread interval still works; it just drifts in background tabs.
      console.warn('Ticker: Worker unavailable, falling back to setInterval', err);
      this.worker = null;
    }
  }

  start(onTick) {
    this.onTick = onTick;
    if (this.worker) {
      this.worker.postMessage({ command: 'start', interval: this.intervalMs });
    } else {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = setInterval(() => this.onTick?.(), this.intervalMs);
    }
  }

  stop() {
    if (this.worker) {
      this.worker.postMessage({ command: 'stop' });
    } else {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }
}
