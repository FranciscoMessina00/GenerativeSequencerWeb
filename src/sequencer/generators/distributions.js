import { nearestInScale, scaleById } from '../scales.js';

/**
 * The three value distributions. Every tuned constant in the generative layer is
 * here, so the whole stochastic character sits in one place.
 *
 * All three share a shape: below a spread threshold, a Gaussian around the bias;
 * above it, a coin-flipped *pair* of Gaussians pinned near the range ends whose own
 * spread shrinks as the user's grows. That inversion is what makes one knob sweep
 * from narrow, through roughly uniform, to extremes-only.
 */

const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Reflect back and forth between bounds instead of clamping. Used for the
 * plucking position, so overshoot bounces rather than sticking at the rail.
 */
export function fold(x, lo, hi) {
  const range = hi - lo;
  if (range <= 0) return lo;
  let v = x - lo;
  v = Math.abs(v % (2 * range));
  return lo + (v > range ? 2 * range - v : v);
}

/**
 * Notes. Bias is a MIDI note (1..127), spread 0..40.
 * The narrow regime takes `.abs` rather than clipping, so a low bias with
 * moderate spread reflects off zero -- audible as an upward pull near the bottom.
 */
export const NOTE_DISTRIBUTION = {
  name: 'note',
  threshold: 20,
  narrow: (rng, bias, spread) => Math.abs(rng.gauss(bias, spread)),
  wide: (rng, _bias, spread) =>
    rng.coin(0.5)
      ? clip(rng.gauss(41 - spread, 40.1 - spread), 1, 60)
      : clip(rng.gauss(87 + spread, 40.1 - spread), 60, 127),
  /**
   * Quantisation happens on read, after looping, so a loop can be re-scaled live.
   * Rooted at the bias, so the scale follows wherever the bias slider is set rather
   * than always being anchored at C -- see nearestInScale.
   */
  post: (value, params) => nearestInScale(value, scaleById(params.scale).degrees, params.bias),
  initial: (rng) => rng.randRange(60, 72),
};

/**
 * Velocity. Bias and spread both 0.1..1. Drives amplitude and decay length.
 *
 * Deliberately lopsided in the wide regime, unlike note and mod, whose branches
 * share a standard deviation and tighten onto both ends together. Here the quiet
 * branch tightens while the loud one stays eight times broader at maximum spread,
 * so quiet hits pin reliably to 0.1 while loud hits pile up at 1.0 and smear back
 * down. That is the point: soft hits you can count on, loud hits you cannot.
 */
export const VELOCITY_DISTRIBUTION = {
  name: 'velocity',
  threshold: 0.5,
  narrow: (rng, bias, spread) => clip(rng.gauss(bias, spread), 0.1, 1),
  wide: (rng, _bias, spread) =>
    rng.coin(0.5)
      ? clip(rng.gauss(0.2 - spread / 10, 0.2 - spread / 10), 0.1, 1)
      : clip(rng.gauss(0.9 + spread / 10, 0.9 - spread / 10), 0.1, 1),
  post: (value) => value,
  initial: (rng) => rng.randRange(0.5, 0.9),
};

/**
 * Modulation -- the plucking position `m` fed to the modal amplitude formula.
 * Bias 2..20, spread 0.1..20. m=2 is a dead-centre pluck (odd modes only);
 * higher m plucks nearer the bridge and brightens the spectrum.
 */
export const MOD_DISTRIBUTION = {
  name: 'mod',
  threshold: 10,
  narrow: (rng, bias, spread) => clip(rng.gauss(bias, spread), 2, 20),
  wide: (rng, _bias, spread) =>
    rng.coin(0.5)
      ? clip(rng.gauss(12 - spread / 2, 10.1 - spread / 2), 2, 20)
      : clip(rng.gauss(10 + spread / 2, 10.1 - spread / 2), 2, 20),
  post: (value) => fold(value, 2, 20),
  initial: (rng) => rng.randRange(2, 20),
};

/** Draw one raw value, picking the regime from the spread. */
export function sampleDistribution(dist, rng, bias, spread) {
  return spread < dist.threshold
    ? dist.narrow(rng, bias, spread)
    : dist.wide(rng, bias, spread);
}
