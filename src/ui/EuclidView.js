/**
 * The circular step display, ported from the Processing sketch's ring
 * (`Vista.pde:375-393`): one dot per step around a circle, bright where the
 * Euclidean pattern has a pulse.
 *
 * Two additions the original did not have, both for verification: the playhead
 * shows where the sequence actually is, and each step is marked with whether it
 * *fired* -- which for this instrument is not the same thing as whether the
 * Euclidean pattern had a pulse there, since the logic operator and the random
 * stream get a say. Being able to see those three layers at once is the fastest
 * way to confirm the operators are wired correctly.
 *
 * Crucially the playhead is driven by the audio clock, not by the scheduler. The
 * scheduler decides steps ~100 ms early; drawing on that would show the ring
 * running ahead of what you hear.
 */
export class EuclidView {
  constructor(canvas, getAudioTime) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getAudioTime = getAudioTime;

    this.pattern = [1];
    /** Steps decided but not yet audible: {stepIndex, audioTime, triggered}. */
    this.queue = [];
    this.currentStep = -1;
    /** stepIndex -> did it fire last time round. */
    this.fired = new Map();
    this.running = false;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame(() => this.frame());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
  }

  setPattern(pattern) {
    this.pattern = pattern.length ? pattern : [0];
  }

  /** Called when the scheduler decides a step, well before it sounds. */
  enqueue(step) {
    this.queue.push({
      stepIndex: step.stepIndex,
      audioTime: step.audioTime,
      triggered: step.triggered,
    });
  }

  setRunning(running) {
    this.running = running;
    if (!running) {
      this.queue.length = 0;
      this.currentStep = -1;
    }
  }

  frame() {
    const now = this.getAudioTime();
    // Promote every step whose time has arrived; the last one wins, so a stalled
    // animation frame catches up rather than replaying history.
    while (this.queue.length && this.queue[0].audioTime <= now) {
      const step = this.queue.shift();
      this.currentStep = step.stepIndex;
      this.fired.set(step.stepIndex, step.triggered);
    }
    this.draw();
    requestAnimationFrame(() => this.frame());
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    ctx.clearRect(0, 0, w, h);

    const steps = this.pattern.length;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.max(20, Math.min(w, h) / 2 - 26);
    // Shrink the dots when the ring gets crowded at 32 steps.
    const dotRadius = Math.max(3, Math.min(11, (radius * 1.7) / steps));

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    for (let i = 0; i < steps; i += 1) {
      // Step 0 at the top, advancing clockwise -- as the Processing sketch drew it.
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / steps;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);

      const isPulse = this.pattern[i] === 1;
      const isPlayhead = i === this.currentStep;
      const didFire = this.fired.get(i);

      if (isPlayhead) {
        ctx.beginPath();
        ctx.arc(x, y, dotRadius + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 200, 255, 0.22)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      // Filled = the Euclidean pattern has a pulse here; hollow = it does not.
      if (isPulse) {
        ctx.fillStyle = isPlayhead ? '#8fd3ff' : '#4a90b8';
        ctx.fill();
      } else {
        ctx.strokeStyle = isPlayhead ? '#8fd3ff' : 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // A green ring means the step actually triggered a note. Where that
      // disagrees with the fill, the logic operator or the random stream changed
      // the outcome -- which is exactly what you want to be able to see.
      if (didFire) {
        ctx.beginPath();
        ctx.arc(x, y, dotRadius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(130, 230, 150, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${steps} steps`, cx, cy - 4);
    ctx.fillText(this.running ? 'running' : 'stopped', cx, cy + 12);
  }
}
