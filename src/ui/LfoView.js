import { lfoValue } from '../modulation/lfo.js';

/**
 * The LFO's scope: one cycle of the actual shape, with a dot riding it at the phase
 * currently being heard.
 *
 * The curve is sampled through the same lfoValue() the audio path uses, so what is
 * drawn is the modulation rather than a picture of it -- fold flattening the peaks and
 * the morph between shapes both show up for free, with nothing to keep in sync.
 *
 * Built on EuclidView's canvas idiom: CSS owns the size, the backing store is scaled
 * to the device pixel ratio, and a dirty flag keeps a stopped scope free.
 */

/** Vertical breathing room, so a peak at 1 does not sit on the frame. */
const MARGIN_Y = 5;
/** The phase dot's radius in CSS pixels. */
const DOT_R = 3.5;

export class LfoView {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas sized by CSS; only its backing store is set here
   * @param {() => number} opts.getPhase phase being heard, 0..1
   */
  constructor({ canvas, getPhase }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getPhase = getPhase;

    this.shape = 0;
    this.fold = 0;
    this.phase = 0;
    this.running = false;
    this.cssWidth = 0;
    this.cssHeight = 0;
    /** Repaint only when something changed; see frame(). */
    this.dirty = true;

    // A ResizeObserver rather than only a window listener, because this canvas is
    // built inside its panel and cannot be measured until the panel is in the
    // document -- a first measurement here would be all zeros. The observer fires
    // once that layout happens, which is the moment there is anything to measure,
    // and again whenever the panel's grid column reflows without the window
    // changing size at all.
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    // Kept alongside it: moving the window to a display with a different pixel ratio
    // changes what the backing store should be without changing the CSS box, so the
    // observer alone would never hear about it.
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame(() => this.frame());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    // Before layout, and whenever the panel is hidden, the box measures zero. Bail
    // rather than storing that: a scope that was drawing correctly should not be
    // blanked by one bad measurement, and draw() has nothing to do at zero size.
    if (!(rect.width > 0 && rect.height > 0)) {
      this.dirty = true;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    // Assigning canvas.width/height blanks the surface.
    this.dirty = true;
  }

  /** The shape being drawn. Only these two change the curve. */
  setWave(shape, fold) {
    this.shape = Number(shape) || 0;
    this.fold = Number(fold) || 0;
    this.dirty = true;
  }

  setRunning(running) {
    this.running = Boolean(running);
    this.dirty = true;
  }

  frame() {
    // Unlike EuclidView, this asks for a repaint on every frame while running: the dot
    // moves continuously rather than in discrete jumps, so there is no cheaper signal
    // to gate on. Stopped, the flag does its usual job and the scope costs nothing.
    if (this.running) {
      this.phase = Number(this.getPhase()) || 0;
      this.dirty = true;
    }
    if (this.dirty) {
      this.draw();
      this.dirty = false;
    }
    requestAnimationFrame(() => this.frame());
  }

  /** Curve height at a phase, in CSS pixels from the top. */
  #yFor(phase) {
    const mid = this.cssHeight / 2;
    const amplitude = mid - MARGIN_Y;
    return mid - lfoValue(this.shape, this.fold, phase) * amplitude;
  }

  /**
   * Where the phase marker sits, in CSS pixels. Public so the geometry can be checked
   * without reading pixels back off the canvas, which the browser checks avoid.
   */
  markerPoint() {
    return { x: this.phase * this.cssWidth, y: this.#yFor(this.phase) };
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    // Nothing to draw before the first real measurement. Without this the curve loop
    // below would run exactly once at w = 0, emitting a lone moveTo and stroking
    // nothing -- which is silent, looks like a working scope, and is impossible to
    // spot from the outside.
    if (!(w > 0 && h > 0)) return;
    ctx.clearRect(0, 0, w, h);

    // Zero line, so it reads as bipolar rather than as a level.
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // One cycle, a sample per pixel. Saw and square are discontinuous, and stepping by
    // whole pixels is what keeps their edge a clean vertical rather than a diagonal
    // smeared across one sample's worth of phase.
    ctx.beginPath();
    for (let x = 0; x <= w; x += 1) {
      const y = this.#yFor(x / w);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4a90b8';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // The marker is drawn whether or not the transport is running: parked and dim
    // while stopped, so it is visible before anything is ever started rather than the
    // panel looking like it has no position readout at all. It only *moves* while
    // running, because that is the only time the LFO is advancing -- a marker gliding
    // along while nothing is being modulated would be claiming something untrue.
    const { x, y } = this.markerPoint();

    // A full-height rule as well as the dot: at this size the dot alone is easy to
    // miss, and the line is what makes the position readable at a glance.
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.strokeStyle = this.running ? 'rgba(207, 234, 255, 0.45)' : 'rgba(207, 234, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = this.running ? '#cfeaff' : 'rgba(207, 234, 255, 0.35)';
    ctx.fill();
  }
}
