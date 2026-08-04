import { lfoValue } from '../modulation/lfo.js';
import { paletteFor } from './palette.js';

/**
 * The LFO's scope: a static picture of one cycle of the current shape.
 *
 * The curve is sampled through the same lfoValue() the audio path uses, so what is
 * drawn is the modulation rather than a picture of it -- fold flattening the peaks and
 * the morph between shapes both show up for free, with nothing to keep in sync.
 *
 * Deliberately no live phase marker: a dot that has to redraw every frame while the LFO
 * runs is throttled to the display's refresh rate, and near the top of the schema's
 * rate range that reads as flicker rather than motion, with no fix that doesn't either
 * cap the usable range or add real complexity for a small display. The shape, fold and
 * rate are all still fully visible here; only the moment-to-moment phase is not.
 *
 * Built on EuclidView's canvas idiom for sizing: CSS owns the size, the backing store is
 * scaled to the device pixel ratio. There is no animation loop -- draw() runs once per
 * actual change (a resize, or a new shape/fold), not on a timer.
 */

/** Vertical breathing room, so a peak at 1 does not sit on the frame. */
const MARGIN_Y = 5;

export class LfoView {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas sized by CSS; only its backing store is set here
   */
  constructor({ canvas }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.shape = 0;
    this.fold = 0;
    this.cssWidth = 0;
    this.cssHeight = 0;
    /** Page 0's colours until told otherwise -- see EuclidView for the reasoning. */
    this.palette = paletteFor(0);

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
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    // Before layout, and whenever the panel is hidden, the box measures zero. Bail
    // rather than drawing into that -- there is nothing to draw, and canvas.width/height
    // would end up a meaningless 1x1 backing store.
    if (!(rect.width > 0 && rect.height > 0)) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.draw();
  }

  /** The shape being drawn. Only these two ever change the curve. */
  setWave(shape, fold) {
    this.shape = Number(shape) || 0;
    this.fold = Number(fold) || 0;
    this.draw();
  }

  /** Draw in a different page's colours -- see ui/palette.js. */
  setPalette(palette) {
    if (!palette) return;
    this.palette = palette;
    this.draw();
  }

  /** Curve height at a phase, in CSS pixels from the top. */
  #yFor(phase) {
    const mid = this.cssHeight / 2;
    const amplitude = mid - MARGIN_Y;
    return mid - lfoValue(this.shape, this.fold, phase) * amplitude;
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    // Nothing to draw before the first real measurement -- see resize().
    if (!(w > 0 && h > 0)) return;
    ctx.clearRect(0, 0, w, h);

    // Zero line, so it reads as bipolar rather than as a level.
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.strokeStyle = this.palette.lfoZero;
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
    ctx.strokeStyle = this.palette.lfoCurve;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
