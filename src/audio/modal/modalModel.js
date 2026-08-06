/**
 * The physical model of the string, as pure functions. Deliberately separate from
 * the DSP -- the worklet gets handed finished mode tables -- so the physics stays
 * testable in Node and exists in exactly one place.
 *
 * Each mode is sounded by a two-pole resonator rather than a summed sine. Same
 * frequencies and amplitudes, but a resonator rings on its own instead of being
 * driven, so modes cost a few multiply-adds each and get per-mode decay for free.
 */

/** −60 dB in nepers: ln(1000). Converts a T60 to a pole radius. */
export const LOG_1000 = Math.log(1000);

/**
 * Modal frequency ratios f[n] / f0, for n = 1..count.
 *
 *   f_n = n · f1 · (1 + β + β² + n²π²β²/8),  β = stiffness / 1000
 *
 * Stiffness stretches the upper partials progressively sharp, which is what
 * separates a struck string from a plain harmonic series.
 *
 * Ratios rather than absolute frequencies, so a gliding voice rescales its whole
 * mode bank with one multiply instead of re-deriving the model every sub-block.
 */
export function modeRatios(count, stiffness, out = new Float32Array(count)) {
  const beta = stiffness / 1000;
  const detune = beta + beta * beta;
  const variablePart = (Math.PI * Math.PI * beta * beta) / 8;

  for (let i = 0; i < count; i += 1) {
    const n = i + 1;
    out[i] = n * (1 + detune + n * n * variablePart);
  }
  // The fundamental is pinned to exactly f0, so stiffness stretches the partials
  // upward without dragging the perceived pitch with them.
  out[0] = 1;
  return out;
}

/**
 * Modal amplitudes for a string plucked at position `m`, normalised to sum 0.5.
 *
 *   B_n = 2m² / (n²π²(m−1)) · sin(nπ/m)
 *
 * `m` is the pluck position as a fraction of string length (2..20): m = 2 is
 * dead-centre and nulls every even mode, larger m moves toward the bridge and
 * brightens. Normalising to 0.5 leaves 6 dB of headroom against clipping.
 */
export function modeGains(count, pluckPosition, out = new Float32Array(count)) {
  // m = 1 would divide by zero, and m < 1 is not physical.
  const m = Math.max(1.0001, pluckPosition);
  const pi2 = Math.PI * Math.PI;
  const numerator = 2 * m * m;
  const denomScale = pi2 * (m - 1);

  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const n = i + 1;
    const value = (numerator / (n * n * denomScale)) * Math.sin((n * Math.PI) / m);
    out[i] = value;
    sum += value;
  }

  // The raw sum is positive and well away from zero across the whole 2..20 range,
  // so this normalisation stays well conditioned.
  const scale = sum !== 0 ? 0.5 / sum : 0;
  for (let i = 0; i < count; i += 1) {
    out[i] *= scale;
  }
  return out;
}

/**
 * Per-mode −60 dB decay times, in seconds.
 *
 *   T60[n] = base · n^(−damping),  base = (0.2 + velocity) · decayScale
 *
 * Higher modes losing energy faster is what gives a string its bright attack
 * settling into a darker tail; `damping = 0` decays them together and sounds
 * notably more synthetic.
 */
export function modeDecays(count, velocity, damping, decayScale, out = new Float32Array(count)) {
  const base = (0.2 + velocity) * decayScale;
  for (let i = 0; i < count; i += 1) {
    out[i] = base * Math.pow(i + 1, -damping);
  }
  return out;
}

/**
 * Everything the worklet needs to start one note. Modes above Nyquist are dropped:
 * a two-pole filter tuned past it folds back into the audible band, so an aliased
 * resonator is not merely inaudible but actively wrong.
 *
 * `glideFromMidinote` is the note a glide starts from, when there is one. The cull
 * has to be safe for every pitch the fundamental will actually pass through, not just
 * where it lands: a downward glide sounds its modes at `glideFromMidinote`'s pitch
 * first, and a mode kept only because the *target* note is low enough would have its
 * coefficients folded back (by the worklet's own `w >= MAX_OMEGA` guard) at that
 * higher starting pitch -- which zeroes its ring state outright, not just its
 * amplitude, so it never recovers once the glide brings it back into range. Sizing
 * the cull by whichever endpoint is higher keeps every kept mode valid for the whole
 * glide, since both interpolation curves move the fundamental monotonically between
 * the two endpoints with no overshoot.
 */
export function buildNote({
  midinote,
  glideFromMidinote,
  velocity,
  pluckPosition,
  modes,
  stiffness,
  damping,
  decayScale,
  sampleRate,
}) {
  const count = Math.max(1, Math.floor(modes));
  const ratios = modeRatios(count, stiffness);
  const gains = modeGains(count, pluckPosition);
  const decays = modeDecays(count, velocity, damping, decayScale);

  const f0 = midiToHz(midinote);
  const f0Safety = glideFromMidinote == null ? f0 : Math.max(f0, midiToHz(glideFromMidinote));
  const nyquist = sampleRate * 0.5;
  // Leave a little margin below Nyquist; resonators very close to it are
  // numerically poorly behaved.
  const limit = nyquist * 0.98;

  let kept = 0;
  for (let i = 0; i < count; i += 1) {
    if (f0Safety * ratios[i] < limit) kept += 1;
    else break; // ratios ascend, so the first failure ends the useful range
  }
  kept = Math.max(1, kept);

  return {
    count: kept,
    ratios: ratios.subarray(0, kept),
    gains: gains.subarray(0, kept),
    decays: decays.subarray(0, kept),
  };
}

export function midiToHz(midinote) {
  return 440 * Math.pow(2, (midinote - 69) / 12);
}
