import { ahdEnvelope } from '../audio/envelope.js';
import { DOT_INSET, MARGIN_TOP, envelopeShape } from './envelopeShape.js';
import { paletteFor } from './palette.js';

/**
 * The envelope display: one note's amplitude shape, with the step boundary drawn
 * across the top of it.
 *
 * Built on LfoView's canvas idiom, for the same reasons and with the same trade-offs:
 * CSS owns the size, the backing store is scaled to the device pixel ratio, a
 * ResizeObserver is what discovers the first real measurement, and there is no
 * animation loop -- draw() runs once per actual change.
 *
 * Fixed height and a width that does not track tempo, per the issue: the canvas is a
 * stable frame and what moves inside it is the marker. A box that grew with the
 * envelope would make every reading relative to a ruler that had also moved.
 *
 * The geometry is all envelopeShape.js's, which samples audio/envelope.js's own
 * envelopeLevel() -- so the truncation rules show up here without this file knowing
 * they exist.
 */

/** Where the "Step Length" caption sits relative to the marker line. */
const LABEL_INSET = 4;
const LABEL_FONT = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
/**
 * Cap height of that font, near enough. Used only to centre the caption in the band
 * envelopeShape reserves for it -- measuring it properly would mean a TextMetrics
 * call per draw for a number that cannot change.
 */
const LABEL_HEIGHT = 9;

/**
 * Radius of the stage dots. envelopeShape keeps them this far from the frame's edges
 * (DOT_INSET), so the two numbers are one fact and are imported rather than repeated.
 */
const DOT_RADIUS = DOT_INSET;

export class EnvelopeView {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas sized by CSS; only its backing store is set here
   * @param {(shape: ReturnType<typeof envelopeShape>) => void} [opts.onDraw] called
   *   with the geometry every time it is recomputed -- for anything positioned against
   *   the canvas that is not painted into it. See EnvelopePanel's warning badge.
   */
  constructor({ canvas, onDraw }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onDraw = onDraw ?? null;

    /** The envelope being drawn, in the shape ahdEnvelope() returns. */
    this.env = ahdEnvelope({
      attackMs: 0, holdMs: 0, decayMs: 1, stepSeconds: 0, exponential: false,
    });
    this.stepSeconds = 0;
    this.cssWidth = 0;
    this.cssHeight = 0;
    /** Page 0's colours until told otherwise -- see EuclidView for the reasoning. */
    this.palette = paletteFor(0);

    // A ResizeObserver rather than only a window listener: this canvas is built inside
    // its panel and cannot be measured until the panel is in the document, so a first
    // measurement here would be all zeros. See LfoView, which explains it at length.
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    // Before layout, and whenever the panel is hidden, the box measures zero. Bail
    // rather than drawing into a meaningless 1x1 backing store.
    if (!(rect.width > 0 && rect.height > 0)) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.draw();
  }

  /**
   * The envelope to draw, and the step it is cut against.
   *
   * Takes the finished envelope rather than the three millisecond values, so the
   * picture is of exactly what a note-on would carry -- truncation included.
   */
  setEnvelope(env, stepSeconds) {
    this.env = env;
    this.stepSeconds = Number(stepSeconds) > 0 ? Number(stepSeconds) : 0;
    this.draw();
  }

  /** Draw in a different page's colours -- see ui/palette.js. */
  setPalette(palette) {
    if (!palette) return;
    this.palette = palette;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    // Nothing to draw before the first real measurement -- see resize().
    if (!(w > 0 && h > 0)) return;
    ctx.clearRect(0, 0, w, h);

    const shape = envelopeShape({
      env: this.env,
      stepSeconds: this.stepSeconds,
      width: w,
      height: h,
    });

    // The floor, so an envelope that has already fallen silent still reads as sitting
    // on zero rather than as an empty panel.
    const floor = shape.points[0] ? Math.max(...shape.points.map((p) => p.y)) : h;
    ctx.beginPath();
    // Half a pixel up when the floor is the bottom edge itself, which it now is: a
    // 1px stroke centred on `h` would have half of itself outside the canvas.
    const baseline = Math.min(floor, h - 0.5);
    ctx.moveTo(0, baseline);
    ctx.lineTo(w, baseline);
    ctx.strokeStyle = this.palette.envBaseline;
    ctx.lineWidth = 1;
    ctx.stroke();

    // The curve, filled down to the floor. Filled first so the stroke sits on top of
    // its own edge rather than being half-covered by it.
    ctx.beginPath();
    ctx.moveTo(shape.points[0].x, floor);
    for (const point of shape.points) ctx.lineTo(point.x, point.y);
    ctx.lineTo(shape.points.at(-1).x, floor);
    ctx.closePath();
    ctx.fillStyle = this.palette.envFill;
    ctx.fill();

    ctx.beginPath();
    shape.points.forEach((point, i) => {
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = this.palette.envCurve;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    this.#drawStageDots(shape);
    this.#drawStepMarker(shape);

    // Last, and with the geometry it was drawn from: whatever is positioned against
    // this canvas rather than painted into it moves when the canvas does.
    this.onDraw?.(shape);
  }

  /**
   * The two stage boundaries: where the attack finishes, and where the decay leaves.
   *
   * Drawn after the curve so they sit on top of the line rather than under it. Both are
   * at the same height, so hold is the gap between them -- and when there is no hold
   * they land on each other and read as the single boundary they are.
   */
  #drawStageDots(shape) {
    const ctx = this.ctx;
    ctx.fillStyle = this.palette.envDot;
    for (const dot of [shape.attackEnd, shape.decayStart]) {
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * The step boundary: a rule along the top edge, ending where the step does, with a
   * tick dropped at that point so the alignment against the curve is readable.
   *
   * Along the top rather than through the curve because it must stay legible whatever
   * the envelope is doing underneath it -- and because what is being compared is
   * lengths, which a ruler above the shape shows better than a line through it.
   *
   * Both the rule and its caption live inside envelopeShape's MARGIN_TOP band, which
   * the curve is kept out of. Without that reservation a held note at full level rose
   * straight through the caption.
   */
  #drawStepMarker(shape) {
    if (shape.stepMarkerX === null) return;
    const ctx = this.ctx;
    const y = 0.5;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(shape.stepMarkerX, y);
    // The tick, dropped a little way into the panel: the marker's own end is what
    // says where the step finishes, and a bare line end is easy to lose.
    ctx.moveTo(shape.stepMarkerX - 0.5, y);
    ctx.lineTo(shape.stepMarkerX - 0.5, Math.min(this.cssHeight, MARGIN_TOP * 0.4));
    ctx.strokeStyle = this.palette.envStep;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'top';
    ctx.fillStyle = this.palette.envStep;
    const label = 'Step Length';
    // Dropped when the marker is too short to hold it, rather than letting it spill
    // past its own line and read as belonging to whatever is under it instead.
    if (ctx.measureText(label).width + LABEL_INSET * 2 <= shape.stepMarkerX) {
      // Centred in the reserved band, under the rule it belongs to.
      ctx.fillText(label, LABEL_INSET, y + (MARGIN_TOP - LABEL_HEIGHT) / 2);
    }
  }
}
