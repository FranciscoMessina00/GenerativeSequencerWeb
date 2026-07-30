/**
 * The physical model of the string, as pure functions.
 *
 * This is the direct port of the paper's equations and of `~amp`/`~freq` in
 * `TriggerWithGlide.scd:164-198`. It is deliberately separated from the DSP: the
 * worklet is a dumb resonator bank that gets handed mode tables, so the physics
 * stays testable in Node and exists in exactly one place.
 *
 * The one substantive change from the original is *how* the modes are sounded.
 * The source sums a `SinOsc` per mode -- up to 200 of them in ModalSynth.scd --
 * which the paper itself flags: "it may increase CPU usage. To reduce the stress
 * of the CPU we can reduce the number of harmonics". Here each mode becomes a
 * two-pole resonator instead. Same frequencies, same amplitudes, but the modes
 * ring on their own rather than being driven, so the cost per mode is a handful
 * of multiply-adds and the sound gets per-mode decay for free.
 */

/** −60 dB in nepers: ln(1000). Converts a T60 to a pole radius. */
export const LOG_1000 = Math.log(1000);

/**
 * Modal frequency ratios f[n] / f0, for n = 1..count.
 *
 * Paper eq. (3): f_n = n·f1·[1 + β + β² + (n²π²/8)·β²], with β from eq. (4)
 * standing in for the string's stiffness. The source passes `stiffness = 11` and
 * divides by 1000 internally, giving β = 0.011 -- the value the paper reports as
 * sounding most realistic.
 *
 * Ratios rather than absolute frequencies, because they are independent of f0:
 * that is what lets a gliding voice rescale its whole mode bank with one
 * multiply instead of re-deriving the model every sub-block.
 */
export function modeRatios(count, stiffness, out = new Float32Array(count)) {
  const beta = stiffness / 1000;
  const detune = beta + beta * beta;
  const variablePart = (Math.PI * Math.PI * beta * beta) / 8;

  for (let i = 0; i < count; i += 1) {
    const n = i + 1;
    out[i] = n * (1 + detune + n * n * variablePart);
  }
  // The source forces the fundamental to be exactly f0 (`f[0] = fundFreq`), so
  // stiffness stretches the partials upward without dragging the pitch with it.
  out[0] = 1;
  return out;
}

/**
 * Modal amplitudes for a string plucked at position `m`, normalised to sum 0.5.
 *
 * Paper eq. (1): B_n = 2m² / (n²π²(m−1)) · sin(nπ/m), where m is the plucking
 * position as a fraction of the string length (the instrument's `modulation`
 * parameter, 2..20). m = 2 is a dead-centre pluck, which nulls every even mode;
 * larger m moves toward the bridge and brightens the spectrum.
 *
 * The 0.5 factor is the source's `normalizeSum * 0.5` -- 6 dB of headroom so a
 * full-velocity note cannot clip on its own.
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

  // normalizeSum divides by the sum of the raw values, which for this formula is
  // positive and well away from zero across the whole 2..20 range.
  const scale = sum !== 0 ? 0.5 / sum : 0;
  for (let i = 0; i < count; i += 1) {
    out[i] *= scale;
  }
  return out;
}

/**
 * Per-mode −60 dB decay times, in seconds.
 *
 * The source has no per-mode decay at all: every sine shares one
 * `Env.perc(0.01, 0.2 + vel, curve: -4)`, so all partials die together. A
 * resonator bank has to say how fast each mode rings, so this is the one place
 * the port must add rather than transcribe.
 *
 * `T60[n] = base · n^(−damping)` follows the physics -- higher modes lose energy
 * faster -- and produces the bright attack settling into a darker tail that a
 * real string has. `damping = 0` recovers the source's behaviour of every mode
 * decaying at the same rate. The base range 0.2..1.2 s is the source's
 * `0.2 + vel`, scaled by a user Decay control.
 */
export function modeDecays(count, velocity, damping, decayScale, out = new Float32Array(count)) {
  const base = (0.2 + velocity) * decayScale;
  for (let i = 0; i < count; i += 1) {
    out[i] = base * Math.pow(i + 1, -damping);
  }
  return out;
}

/**
 * Everything the worklet needs to start one note.
 *
 * Modes whose frequency would land above Nyquist are dropped: an aliased
 * resonator is not just inaudible but actively wrong, since a two-pole filter
 * tuned past Nyquist folds back into the audible band.
 */
export function buildNote({
  midinote,
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
  const nyquist = sampleRate * 0.5;
  // Leave a little margin below Nyquist; resonators very close to it are
  // numerically poorly behaved.
  const limit = nyquist * 0.98;

  let kept = 0;
  for (let i = 0; i < count; i += 1) {
    if (f0 * ratios[i] < limit) kept += 1;
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
