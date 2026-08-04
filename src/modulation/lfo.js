/**
 * The LFO's maths: what shape it is, how hard it is folded, and how long one cycle
 * lasts. Pure functions with no state and no DOM, so the whole modulation
 * character sits in one testable place -- the same reasoning as
 * sequencer/generators/distributions.js holding every tuned constant of the
 * generative layer.
 */

/**
 * The four anchor shapes, bipolar and peaking at 1.
 *
 * All four are written to leave phase 0 at zero and rising, sharing sine's phase.
 * That is what makes the morph below a pure change of *shape*: sliding from sine to
 * square must not also shift the cycle sideways, or the visualiser's dot would jump
 * and a synced LFO would drift off the beat it is locked to.
 *
 * Saw and square are discontinuous by nature; their jump sits at phase 0.5, which
 * is where sine crosses zero going down, so the four stay aligned throughout.
 */
const ANCHORS = [
  // Sine.
  (p) => Math.sin(2 * Math.PI * p),
  // Triangle: shifted a quarter cycle, so it starts at zero rather than at -1.
  (p) => 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5),
  // Saw: rises 0 -> 1 over the first half, drops to -1, rises -1 -> 0 over the second.
  (p) => 2 * ((p + 0.5) % 1) - 1,
  // Square.
  (p) => (p < 0.5 ? 1 : -1),
];

/** Names in morph order, for the shape control's readout. */
export const SHAPE_NAMES = ['Sine', 'Triangle', 'Saw', 'Square'];

/** How many crossfades the morph passes through: one fewer than the anchors. */
const SEGMENTS = ANCHORS.length - 1;

/**
 * Into 0..1, coercing first and treating anything non-numeric as 0.
 *
 * The coercion is the point, not politeness: a bare comparison leaves NaN and
 * non-numeric input untouched (`NaN < 0` and `NaN > 1` are both false), and a NaN
 * here would travel all the way into an AudioParam, which poisons it for the life of
 * the audio graph.
 */
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Phase folded into [0, 1), for negatives too -- `%` alone keeps the sign. */
function wrapPhase(phase) {
  const n = Number(phase);
  if (!Number.isFinite(n)) return 0;
  const p = n % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * Triangle morphing into saw: a peak that slides from phase 0.25 to phase 0.5,
 * rather than the plain crossfade every other segment uses.
 *
 * Both anchors already fit one shared description: rise linearly 0 -> 1 over the
 * first `r` of the cycle, fall linearly 1 -> -1 over the next `1 - 2r`, then rise
 * linearly -1 -> 0 over the last `r`. Triangle is `r = 0.25` (a symmetric rise,
 * fall, rise); saw is `r = 0.5` (the fall shrinks to width 0, an instant jump,
 * leaving two equal rises either side of it). Sliding `r` between those two values
 * is therefore an exact deformation of one real anchor into the other, and because
 * every segment always spans the same 0 -> 1 -> -1 -> 0 landmarks, the peak stays
 * pinned at exactly 1 throughout -- nothing fades, only the peak's phase moves.
 *
 * A plain crossfade of the two anchors' y-values does not have this property:
 * triangle's peak (phase 0.25) and saw's peak (phase ~0.5) blend into two
 * competing partial peaks rather than one peak in motion, and the blend's own
 * peak magnitude actually sags to 2/3 in the middle of the range.
 */
function triSawShape(blend, p) {
  const r = 0.25 + 0.25 * blend; // 0.25 (triangle) -> 0.5 (saw)
  const fallWidth = 1 - 2 * r; // 0.5 -> 0
  if (p < r) return p / r;
  if (fallWidth > 0 && p < r + fallWidth) return 1 - (2 * (p - r)) / fallWidth;
  return -1 + (p - r - fallWidth) / r;
}

/**
 * The morphed shape at `phase`.
 *
 * `shape` is 0..1 across the whole set, so each adjacent pair gets a third of the
 * travel and the anchors land exactly on 0, 1/3, 2/3 and 1. Between them it is a
 * plain linear crossfade of the two neighbours: cheap, and it means the visualiser
 * can draw the same function the audio path samples rather than an approximation
 * -- except triangle -> saw, which uses triSawShape() above instead, for the
 * reason described there.
 */
export function shapeValue(shape, phase) {
  const p = wrapPhase(phase);
  const position = clamp01(shape) * SEGMENTS;
  // The last anchor has no successor to blend into, so it is its own segment start.
  const index = Math.min(SEGMENTS - 1, Math.floor(position));
  const blend = position - index;
  if (index === 1) return triSawShape(blend, p);
  const from = ANCHORS[index](p);
  const to = ANCHORS[index + 1](p);
  return from + (to - from) * blend;
}

/** The nearest anchor's name -- the shape control shows this, the scope shows the rest. */
export function shapeName(shape) {
  return SHAPE_NAMES[Math.round(clamp01(shape) * SEGMENTS)];
}

/**
 * Fold the peaks back down.
 *
 * The fold threshold descends from 1 (nothing to fold) to 0.5 as `fold` goes 0 -> 1,
 * and anything past it reflects back down by as much as it overshot. Sign is kept,
 * so both halves fold symmetrically and the result stays centred on zero.
 *
 * A general wavefolder has to reflect repeatedly, because one reflection can
 * overshoot the other rail. This one provably cannot: the input never exceeds 1 and
 * the threshold never drops below 0.5, so the worst case is `2 * 0.5 - 1 = 0` --
 * exactly the centre, never past it. Hence a single pass, no loop.
 */
export function foldValue(x, fold) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  const threshold = 1 - 0.5 * clamp01(fold);
  // Capped at 1, which is what makes the single pass above safe: the shapes never
  // exceed 1, but this is exported, and an input of 1.000001 would otherwise reflect
  // to a hair below zero and flip the sign of the result.
  const magnitude = Math.min(1, Math.abs(n));
  const folded = magnitude > threshold ? 2 * threshold - magnitude : magnitude;
  return n < 0 ? -folded : folded;
}

/** How finely to sample one cycle when looking for its post-fold peak. Cheap either
 * way -- this runs at most a few times a second, nowhere near audio-rate -- so this
 * favours accuracy over shaving cycles. */
const FOLD_PEAK_SAMPLES = 256;

/**
 * Floor for the renormalization gain below. Every shape's own pre-fold peak is
 * exactly 1 (see triSawShape() and the segment-0/2 anchors), but a flat-topped
 * shape close to square never dips back down to the fold threshold, so its
 * peak-after-fold can approach 0 as fold approaches 1 -- and dividing by a peak
 * that low would demand near-infinite gain, which is a click, not a fix. Capping
 * the gain here instead means that one truly-degenerate corner (shape at square,
 * fold at 1, where the peak really is 0) fades smoothly to silence, and nothing
 * else pays for it: everywhere the actual peak is at or above this floor, dividing
 * by it still restores exactly 1.
 */
const MIN_FOLD_PEAK = 0.05;

/** The largest |foldValue(shapeValue(shape, p), fold)| reaches over one full cycle. */
function foldedPeak(shape, fold) {
  let peak = 0;
  for (let i = 0; i < FOLD_PEAK_SAMPLES; i += 1) {
    const v = Math.abs(foldValue(shapeValue(shape, i / FOLD_PEAK_SAMPLES), fold));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * The LFO's output: the morphed shape, folded, renormalized back to a full swing.
 *
 * Folding pulls the peak in towards the threshold, so without this, raising Fold
 * would quietly reduce how far the LFO actually sweeps -- a job Amount already
 * owns. Renormalizing by the *actual* peak of this exact (shape, fold) pair --
 * found by sampling, rather than a hand-derived formula that would need
 * re-deriving by hand if a shape's formula ever changes again -- restores a full
 * swing everywhere except the one shape/fold corner where there is no swing left
 * to restore (see MIN_FOLD_PEAK). Always finite, always within [-1, 1].
 */
export function lfoValue(shape, fold, phase) {
  const raw = foldValue(shapeValue(shape, phase), fold);
  if (!(clamp01(fold) > 0)) return raw; // nothing folded, nothing to renormalize
  const gain = 1 / Math.max(foldedPeak(shape, fold), MIN_FOLD_PEAK);
  return Math.max(-1, Math.min(1, raw * gain));
}

/**
 * Seconds per cycle.
 *
 * Synced, this is deliberately the same expression as Track.stepDuration -- one
 * cycle spans exactly what one sequencer step would at that division, so the
 * division numbers mean the same thing in both places. Free, it is just the period
 * of the rate in Hz.
 *
 * `modFactor` is passed in rather than the modifier id, to keep this file free of
 * imports; callers hand it stepModFactor(id) from sequencer/stepDivision.js.
 */
export function lfoPeriod({ sync, rate, division, modFactor = 1, barSeconds }) {
  if (sync) {
    const divisions = Math.max(1, Number(division) || 1);
    const bar = Number(barSeconds);
    // A non-finite bar length would make the period NaN, and a NaN phase increment
    // would poison every value the LFO produces from then on.
    if (!Number.isFinite(bar) || bar <= 0) return 1;
    return (bar / divisions) * (Number(modFactor) || 1);
  }
  const hz = Number(rate);
  if (!Number.isFinite(hz) || hz <= 0) return 1;
  return 1 / hz;
}
