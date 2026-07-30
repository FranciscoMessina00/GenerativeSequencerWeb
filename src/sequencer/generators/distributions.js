import { nearestInScale, scaleById } from '../scales.js';

/**
 * The three value distributions, transcribed from
 * `TriggerWithGlide.scd:355-465`. Every ported magic number in the generative
 * layer lives in this file so it can be diffed against the `.scd` in one place.
 *
 * All three share one shape: below a spread threshold they are a Gaussian
 * around the user's bias; above it they switch to a coin-flipped *pair* of
 * Gaussians pinned near the range ends, whose own spread shrinks as the user's
 * spread grows. That inversion is what produces the sweep the paper describes --
 * "a narrow Gaussian ... to a uniform distribution, and eventually to a
 * distribution that generates only extreme values" -- because at maximum spread
 * the two modes collapse onto the range's floor and ceiling.
 */

const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * SC's `fold`: reflect back and forth between bounds instead of clamping.
 * Used for the plucking position so overshoot bounces rather than sticking.
 */
export function fold(x, lo, hi) {
  const range = hi - lo;
  if (range <= 0) return lo;
  let v = x - lo;
  v = Math.abs(v % (2 * range));
  return lo + (v > range ? 2 * range - v : v);
}

/**
 * Notes. Bias is a MIDI note (1..127), spread 0.1..40.
 * Narrow regime takes `.abs` rather than clipping, so a low bias with moderate
 * spread reflects off zero -- audible as an upward bias near the bottom.
 */
export const NOTE_DISTRIBUTION = {
  name: 'note',
  threshold: 20,
  narrow: (rng, bias, spread) => Math.abs(rng.gauss(bias, spread)),
  wide: (rng, _bias, spread) =>
    rng.coin(0.5)
      ? clip(rng.gauss(41 - spread, 40.1 - spread), 1, 60)
      : clip(rng.gauss(87 + spread, 40.1 - spread), 60, 127),
  /** Quantisation happens on read, after looping, exactly as in the source. */
  post: (value, params) => nearestInScale(value, scaleById(params.scale).degrees),
  initial: (rng) => rng.randRange(60, 72),
};

/**
 * Velocity. Bias and spread both 0.1..1. Drives amplitude and decay length.
 *
 * NOTE -- asymmetric by accident, kept on purpose. The note and mod
 * distributions give both wide-regime branches the *same* standard deviation
 * (`40.1 - spread` and `10.1 - spread/2` respectively), so their two modes
 * tighten together onto the range ends. Velocity does not: its quiet branch
 * uses `0.2 - spread/10` for both mean and sd, but its loud branch pairs mean
 * `0.9 + spread/10` with sd `0.9 - spread/10` -- eight times wider at maximum
 * spread (`TriggerWithGlide.scd:365-366`).
 *
 * The practical effect is that at high spread the quiet mode pins hard to 0.1
 * while the loud mode piles up on 1.0 but smears all the way back down. So
 * "extreme" velocity is lopsided: reliably-soft hits against loud hits of
 * unpredictable strength.
 *
 * This looks like a transcription slip in the original (the mean expression
 * mirrored where the shared sd was meant), but it is audible and it is what the
 * instrument does, so it is reproduced rather than "corrected".
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
