import {
  attackWasCut, envelopeDuration, envelopeLevel, holdWasClamped,
} from '../audio/envelope.js';

/**
 * The envelope display's geometry: where the curve goes, and where the step boundary
 * falls across it.
 *
 * Pure and DOM-free, like ui/scrollThumb.js and ui/playheadProgress.js -- the canvas
 * work is EnvelopeView.js's, and everything decidable without a rendering context is
 * decided here so it can be checked in Node.
 *
 * The curve is sampled through audio/envelope.js's own envelopeLevel(), not redrawn
 * from a picture of it, for the reason LfoView gives for sampling the real lfoValue():
 * the truncation rules, the curve shape and the tail all show up for free, with
 * nothing to keep in sync.
 */

/**
 * The band reserved along the top edge for the step marker and its "Step Length"
 * caption. The curve is drawn below it, so a full-level hold cannot rise into the
 * text -- at the default times it did exactly that, and the caption became
 * unreadable precisely when the envelope was most worth reading.
 *
 * Exported because EnvelopeView places the caption inside this band: the reserved
 * space and the thing it is reserved for are one fact.
 */
export const MARGIN_TOP = 16;

/**
 * Zero, deliberately: the envelope sits on the floor of its box.
 */
export const MARGIN_BOTTOM = 0;

/**
 * Never more than a quarter of the box, so a canvas smaller than the panel's own
 * (a check page, a future compact layout) still gets a curve rather than a sliver.
 */
const MAX_TOP_FRACTION = 0.25;

/**
 * How far a stage dot is kept from the left and right edges.
 *
 * A drawing concession, not a claim about where the stage is: a zero attack genuinely
 * ends at t = 0, and a dot centred there would be half outside the frame. Matching
 * EnvelopeView's own dot radius is what makes the whole circle visible.
 */
export const DOT_INSET = 3;

/**
 * Where the curve and the step marker sit inside a `width` x `height` box.
 *
 * The horizontal span drawn is the longer of the envelope and the step, which is what
 * makes the marker mean something at both extremes: a short envelope inside a long
 * step leaves the curve finishing well before the marker's end, and a long one pushes
 * the marker back to a fraction of the width with the tail bleeding past it. The issue
 * asks for exactly that reading -- whether the decay starts before the boundary,
 * on it, or after it -- and one shared span is what makes the two comparable.
 *
 * @param {object} opts
 * @param {ReturnType<import('../audio/envelope.js').ahdEnvelope>} opts.env
 * @param {number} opts.stepSeconds the step this envelope would be cut against, or 0
 *   when there is no transport to ask (the marker is then omitted entirely)
 * @param {number} opts.width  CSS pixels
 * @param {number} opts.height CSS pixels
 * @param {number} [opts.samples] polyline resolution; defaults to a point per pixel,
 *   which is what keeps the linear curve's corners sharp
 * @returns {{ points: Array<{x: number, y: number}>,
 *   attackEnd: {x: number, y: number}, decayStart: {x: number, y: number},
 *   stepMarkerX: number|null, span: number, truncated: boolean,
 *   holdClamped: boolean, bleeds: boolean }}
 */
export function envelopeShape({ env, stepSeconds, width, height, samples }) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const step = Number(stepSeconds) > 0 ? Number(stepSeconds) : 0;
  const total = envelopeDuration(env);
  const span = Math.max(total, step) || 1;

  const count = Math.max(2, Math.round(samples ?? w) || 2);
  const top = Math.min(MARGIN_TOP, h * MAX_TOP_FRACTION);
  const bottom = Math.max(top, h - MARGIN_BOTTOM);
  const usable = bottom - top;

  const points = new Array(count + 1);
  for (let i = 0; i <= count; i += 1) {
    const at = (i / count) * span;
    points[i] = {
      x: (i / count) * w,
      y: bottom - envelopeLevel(env, at) * usable,
    };
  }

  // The two stage boundaries, for the dots that mark them. Both sit at `peak` -- the
  // attack ends there and the decay leaves from there -- so they are the same point
  // whenever there is no hold between them, which is exactly the reading wanted: no
  // hold, one dot. Nothing special-cases it.
  // Never more than half the box, so a canvas too narrow to hold the inset still
  // places both dots inside itself rather than folding them past each other.
  const inset = Math.min(DOT_INSET, w / 2);
  const atPeak = (seconds) => ({
    x: Math.min(w - inset, Math.max(inset, (seconds / span) * w)),
    y: bottom - env.peak * usable,
  });

  return {
    points,
    attackEnd: atPeak(env.attack),
    decayStart: atPeak(env.attack + env.hold),
    // Clamped to the box: with span taken as the longer of the two, the boundary is
    // inside it by construction, but a zero-length span would otherwise divide badly.
    stepMarkerX: step > 0 ? Math.min(w, (step / span) * w) : null,
    span,
    // The attack ran past the step and was cut mid-ramp -- the marker then ends
    // exactly where the ramp breaks into the decay, which is the case the issue
    // singles out.
    truncated: attackWasCut(env),
    // The attack fitted but the hold did not, so it ends at the boundary instead of
    // where it was set to. Never true at the same time as `truncated` -- see the two
    // predicates -- which is what stops both warnings landing on the one point the
    // dots coincide at when there is no hold.
    holdClamped: holdWasClamped(env),
    // The tail outlives the step it started on and carries into the next.
    bleeds: total > step,
  };
}
