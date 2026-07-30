/**
 * The circular step display, following the Processing sketch's ring
 * (`Vista.pde:375-393`) but drawn as annular sectors rather than dots: the circle
 * is divided into one wedge per step, solid where the Euclidean pattern has a
 * pulse. Sectors make the pattern's *duty* legible -- each step visibly owns a
 * slice of the bar -- which dots cannot show.
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
/** Distance from the canvas edge to the outer rim, leaving room for fired bands. */
const RIM_MARGIN = 18;
/** Hub radius as a fraction of the outer radius -- the space the controls get. */
const HUB_RATIO = 0.8;

export class EuclidView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Function} getAudioTime
   * @param {Function} [onGeometry] called with {cx, cy, outerR, innerR} whenever
   *   the canvas is measured, so an HTML overlay can be fitted to the hub.
   */
  constructor(canvas, getAudioTime, onGeometry) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getAudioTime = getAudioTime;
    this.onGeometry = onGeometry;

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

  /** Ring geometry in CSS pixels. Single source of truth for canvas and overlay. */
  get geometry() {
    const outerR = Math.max(
      28,
      Math.min(this.cssWidth, this.cssHeight) / 2 - RIM_MARGIN,
    );
    return {
      cx: this.cssWidth / 2,
      cy: this.cssHeight / 2,
      outerR,
      innerR: outerR * HUB_RATIO,
    };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.onGeometry?.(this.geometry);
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

  /** Trace an annular sector between two radii and two angles. */
  #sectorPath(cx, cy, innerR, outerR, a0, a1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, a0, a1);
    ctx.arc(cx, cy, innerR, a1, a0, true);
    ctx.closePath();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    ctx.clearRect(0, 0, w, h);

    const steps = this.pattern.length;
    // A hub rather than a full pie: the Euclidean controls live inside it, so the
    // sectors form a band around the edge.
    const { cx, cy, outerR, innerR } = this.geometry;

    const sweep = (Math.PI * 2) / steps;
    // Constant pixel gap between sectors, capped as a fraction of the sweep so
    // that at 32 steps the wedges stay visible instead of collapsing into gaps.
    const gap = Math.min(sweep * 0.22, 5 / outerR);

    for (let i = 0; i < steps; i += 1) {
      // Step 0 begins at 12 o'clock and time runs clockwise.
      const start = -Math.PI / 2 + i * sweep;
      const a0 = start + gap / 2;
      const a1 = start + sweep - gap / 2;

      const isPulse = this.pattern[i] === 1;
      const isPlayhead = i === this.currentStep;
      const didFire = this.fired.get(i);

      // Solid = the Euclidean pattern has a pulse here; faint = it does not.
      this.#sectorPath(cx, cy, innerR, outerR, a0, a1);
      if (isPulse) {
        ctx.fillStyle = isPlayhead ? '#a8dcff' : '#4a90b8';
        ctx.fill();
      } else {
        ctx.fillStyle = isPlayhead
          ? 'rgba(143, 211, 255, 0.30)'
          : 'rgba(255, 255, 255, 0.055)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (isPlayhead) {
        this.#sectorPath(cx, cy, innerR, outerR, a0, a1);
        ctx.strokeStyle = '#cfeaff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // A green band outside the rim means the step actually triggered a note.
      // Where that disagrees with the sector fill, the logic operator or the
      // random stream changed the outcome -- which is exactly what you want to be
      // able to see at a glance.
      if (didFire) {
        this.#sectorPath(cx, cy, outerR + 3, outerR + 7, a0, a1);
        ctx.fillStyle = 'rgba(130, 230, 150, 0.9)';
        ctx.fill();
      }
    }

    // Hub disc, drawn over the inner edge of the sectors so the HTML controls
    // layered on top sit on a clean background. No text: the controls inside the
    // hub already name the step count, and the moving playhead shows run state.
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
    ctx.fillStyle = '#191d24';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
