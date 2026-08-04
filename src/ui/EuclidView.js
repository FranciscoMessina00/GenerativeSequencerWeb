import { paletteFor } from './palette.js';

/**
 * The circular step display: one annular sector per step, solid where the pattern
 * has a pulse. Sectors rather than dots so each step visibly owns a slice of the
 * bar, making the pattern's duty legible.
 *
 * Four layers at once -- pattern, playhead, whether each step actually *fired*
 * (which is not the same thing since the logic operator and random stream get a
 * say), and, while the rhythm loop is active, a snapshot of which positions
 * currently carry a registered "1" in that loop's captured random-bit buffer.
 * That snapshot updates once per revolution, all positions together -- see
 * setLoopSnapshot() -- rather than trailing the playhead one step at a time.
 *
 * The random-bit layer shares the main band with the Euclid pulse (split into
 * two equal radial halves, since both inputs matter equally to the outcome)
 * rather than living outside the ring -- only the fired outcome itself stays
 * out there, as a small band of its own.
 *
 * The playhead follows the audio clock, not the scheduler: the scheduler decides
 * steps ~100 ms early, so drawing on that would run ahead of what you hear.
 */
/** Distance from the canvas edge to the outer rim, leaving room for the fired band. */
const RIM_MARGIN = 18;
/** Hub radius as a fraction of the outer radius -- the space the controls get. */
const HUB_RATIO = 0.8;

export class EuclidView {
  /**
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
    /** stepIndex -> last-seen randomBit, only recorded while the loop is active. */
    this.loopBits = new Map();
    this.loopActive = false;
    this.running = false;
    /**
     * Which page's colours to draw in. Page 0 by default rather than nothing, so a
     * view that is never told (the browser check pages) still draws.
     */
    this.palette = paletteFor(0);
    /** Repaint only when something actually changed; see frame(). */
    this.dirty = true;

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
    // Assigning canvas.width/height blanks the surface.
    this.dirty = true;
  }

  setPattern(pattern) {
    const next = pattern.length ? pattern : [0];
    // A change in step count invalidates the fired and loop-buffer indices.
    // Rotation and pulse changes keep the length, so their marks stay meaningful
    // and are left alone rather than flickering off on every drag.
    if (next.length !== this.pattern.length) {
      this.fired.clear();
      this.loopBits.clear();
    }
    this.pattern = next;
    this.dirty = true;
  }

  /**
   * Called when the scheduler decides a step, well before it sounds.
   * `loopSnapshot`, when given, is a full projection of the rhythm loop's next
   * `steps` random bits (see Track.getTrigLoopWindow) -- attached only to the
   * one step per revolution that starts a new lap (see main.js), and applied
   * at the same audio-clock-gated moment as the rest of this step, in frame(),
   * rather than immediately.
   */
  enqueue(step, loopSnapshot) {
    this.queue.push({
      stepIndex: step.stepIndex,
      audioTime: step.audioTime,
      triggered: step.triggered,
      loopSnapshot,
    });
  }

  /**
   * Whether the rhythm loop is currently capturing/replaying a frozen window of
   * the random-bit register (see TriggerGenerator/HistoryBuffer). Turning it on
   * clears any earlier reading; the caller (main.js) immediately follows with a
   * fresh setLoopSnapshot() call, and again every time the playhead completes a
   * revolution.
   */
  setLoopActive(active) {
    this.loopActive = Boolean(active);
    this.loopBits.clear();
    this.dirty = true;
  }

  /**
   * Replace the loop-buffer overlay wholesale with a freshly projected window,
   * one value per ring position, all updating together rather than one
   * position at a time as the playhead happens to pass it. A loop shorter than
   * the ring's step count repeats circularly to fill it -- see HistoryBuffer's
   * loopWindow, which already does that math; this just paints the result.
   */
  setLoopSnapshot(values) {
    this.loopBits.clear();
    for (let i = 0; i < values.length; i += 1) this.loopBits.set(i, values[i]);
    this.dirty = true;
  }

  setRunning(running) {
    this.running = running;
    // Otherwise the fired/loop-buffer bands stay lit on a stopped ring.
    if (!running) this.clearPlayhead();
    this.dirty = true;
  }

  /**
   * Forget everything about where the playhead is and what has fired, without
   * touching run state.
   *
   * Used when the ring is re-pointed at a different track (see main.js's
   * selectTrack): the marks it is holding describe the track it was showing a
   * moment ago, and a stopped-looking ring on a running sequence is less wrong
   * than a ring confidently displaying another track's history. It refills over
   * one revolution.
   */
  clearPlayhead() {
    this.queue.length = 0;
    this.currentStep = -1;
    this.fired.clear();
    this.loopBits.clear();
    this.dirty = true;
  }

  /**
   * Draw in a different page's colours -- see ui/palette.js. Handed the derived
   * object rather than a page index, and rather than reading custom properties off
   * the element: getComputedStyle in a draw path forces layout every frame.
   */
  setPalette(palette) {
    if (!palette) return;
    this.palette = palette;
    this.dirty = true;
  }

  frame() {
    const now = this.getAudioTime();
    // Promote every step whose time has arrived; the last one wins, so a stalled
    // animation frame catches up rather than replaying history.
    while (this.queue.length && this.queue[0].audioTime <= now) {
      const step = this.queue.shift();
      this.currentStep = step.stepIndex;
      this.fired.set(step.stepIndex, step.triggered);
      // Only while active: a snapshot queued before the loop was turned off
      // should not silently repopulate the overlay after the fact.
      if (step.loopSnapshot && this.loopActive) this.setLoopSnapshot(step.loopSnapshot);
      this.dirty = true;
    }
    // While running a step promotes every few frames, so this is effectively
    // always true; stopped, the ring settles and stops costing anything.
    if (this.dirty) {
      this.draw();
      this.dirty = false;
    }
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
    const c = this.palette;
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

    // While the loop is active, the main band splits radially into two equal
    // halves -- Euclid pulse and random pulse read as equally important inputs
    // to the outcome, so neither one gets to be the whole ring while the other
    // is a thin afterthought outside it. A small seam (left unfilled, like the
    // angular gaps between sectors) separates them. Inactive, there is no
    // random bit worth showing, so Euclid pulse keeps the whole band, exactly
    // as before.
    const seam = 2;
    const mid = (innerR + outerR) / 2;
    const euclidInner = this.loopActive ? mid + seam / 2 : innerR;
    const randomOuter = mid - seam / 2;

    for (let i = 0; i < steps; i += 1) {
      // Step 0 begins at 12 o'clock and time runs clockwise.
      const start = -Math.PI / 2 + i * sweep;
      const a0 = start + gap / 2;
      const a1 = start + sweep - gap / 2;

      const isPulse = this.pattern[i] === 1;
      const isPlayhead = i === this.currentStep;
      const didFire = this.fired.get(i);
      const isRandomOn = this.loopBits.get(i) === 1;

      // Euclid pulse: the outer half while split, the whole band otherwise.
      // Solid = the pattern has a pulse here; faint = it does not.
      this.#sectorPath(cx, cy, euclidInner, outerR, a0, a1);
      if (isPulse) {
        ctx.fillStyle = isPlayhead ? c.ringPulseHead : c.ringPulse;
        ctx.fill();
      } else {
        ctx.fillStyle = isPlayhead ? c.ringRestHead : c.ringRest;
        ctx.fill();
        ctx.strokeStyle = c.ringRestLine;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Random pulse: the inner half, only while the loop is active. Same
      // solid/faint treatment as Euclid pulse, warm-toned rather than blue so
      // the two halves read as related but distinct.
      if (this.loopActive) {
        this.#sectorPath(cx, cy, innerR, randomOuter, a0, a1);
        if (isRandomOn) {
          ctx.fillStyle = isPlayhead ? c.ringRandomHead : c.ringRandom;
          ctx.fill();
        } else {
          ctx.fillStyle = isPlayhead ? c.ringRandomOff : c.ringRandomRest;
          ctx.fill();
          ctx.strokeStyle = c.ringRestLine;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // The playhead outline frames the whole step -- both halves together,
      // when split -- since it names which step is current, not which half.
      if (isPlayhead) {
        this.#sectorPath(cx, cy, innerR, outerR, a0, a1);
        ctx.strokeStyle = c.ringPlayhead;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // A small green band outside the rim means the step actually triggered
      // a note. Where that disagrees with the sector fill, the logic operator
      // or the random stream changed the outcome.
      if (didFire) {
        this.#sectorPath(cx, cy, outerR + 3, outerR + 7, a0, a1);
        // The one colour that does not follow the page -- see ui/palette.js.
        ctx.fillStyle = c.ringFired;
        ctx.fill();
      }
    }

    // Hub disc, drawn over the inner edge of the sectors so the HTML controls
    // layered on top sit on a clean background. No text: the controls inside the
    // hub already name the step count, and the moving playhead shows run state.
    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
    ctx.fillStyle = c.hubDisc;
    ctx.fill();
    ctx.strokeStyle = c.hubDiscEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
