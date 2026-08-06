import { midiToHz } from '../modal/modalModel.js';

/**
 * The three percussion voices, as pure functions.
 *
 * Same split as modal/modalModel.js: this turns one step plus the user's settings into
 * the numbers a hit needs, and the worklet does only the things that need `sampleRate`
 * or per-sample state. So frequencies land here in Hz and decays in seconds, and the
 * worklet converts seconds to per-sample coefficients exactly as modal-processor does
 * for its pole radius.
 *
 * Percussion has far less to precompute than a string -- there are no mode tables --
 * but the mappings are where the off-by-ones live, and they are worth having under
 * test rather than buried in an audio thread that cannot be inspected.
 *
 * Everything here is clamped and guarded on the way out. A NaN reaching an audio
 * thread poisons the node for the lifetime of the graph, and unlike a wrong number it
 * gives no clue where it came from.
 */

/** A frequency below this is not a pitch, and above Nyquist it is not a frequency. */
const MIN_HZ = 10;
const MAX_HZ = 20000;

/** No hit is instantaneous; a zero decay would be a click with no body at all. */
const MIN_DECAY = 0.005;

function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** A pitch in Hz from a MIDI note, bounded so a wandering note stays audible. */
function hzFor(midinote) {
  const hz = midiToHz(Number(midinote));
  if (!Number.isFinite(hz)) return MIN_HZ;
  return Math.min(MAX_HZ, Math.max(MIN_HZ, hz));
}

/**
 * The tilt a `*NoiseColor` knob asks for, as the two gains the worklet crossfades
 * between its lowpassed and highpassed copies of the noise.
 *
 * Equal-power, matching the granulator's dry/wet crossfade, so sweeping the colour
 * changes the timbre without changing how loud the hit is. 0 is fully dark, 1 fully
 * bright, 0.5 an even blend of both.
 */
export function noiseTilt(color) {
  const angle = (clamp(color, 0, 1) * Math.PI) / 2;
  return { dark: Math.cos(angle), bright: Math.sin(angle) };
}

/**
 * A kick.
 *
 * The pitch starts `sweep` times above the note and falls to it, which is what makes
 * the attack read as a beater strike rather than as a note starting. Expressed as a
 * multiplier rather than an interval so the sweep depth stays the same whatever the
 * drum is tuned to.
 *
 * Velocity scales amplitude only, not decay -- a soft kick is a quieter kick, not a
 * shorter one, unlike a plucked string where a light touch genuinely rings less.
 */
export function kickHit({ note, velocity, decay, sweep, sweepTime, noise, noiseColor }) {
  const f0 = hzFor(note);
  const amount = clamp(sweep, 1, 8);
  return {
    // Both bounded, so a high note times a deep sweep cannot land above Nyquist.
    fStart: Math.min(MAX_HZ, f0 * amount),
    fEnd: f0,
    sweepTime: clamp(sweepTime, 0.001, 1),
    decay: clamp(decay, MIN_DECAY, 4),
    amp: clamp(velocity, 0, 1),
    noiseAmp: clamp(noise, 0, 1),
    // A burst, not a layer: it belongs to the attack, so it is over long before the
    // body is. Tied to the sweep, which is the part of the hit it punctuates.
    noiseDecay: Math.max(MIN_DECAY, clamp(sweepTime, 0.001, 1) * 0.8),
    tilt: noiseTilt(noiseColor),
  };
}

/**
 * A snare: a tuned shell under a wire rattle.
 *
 * Two resonators rather than one, at 1 and 1.7 -- a drum head's first two modes are
 * inharmonic, and a fifth (1.5) reads as a pitched tom underneath the rattle. 1.7 is
 * not a musical interval on purpose, closer to the shell-overtone pairing real snare
 * synthesis tends to land on. They are excited by an impulse, like the string's
 * modes, so the worklet can reuse modal-processor's resonator verbatim.
 *
 * The two layers have independent amounts rather than one crossfade, so either can be
 * soloed to hear what it is contributing.
 */
export function snareHit({
  note, velocity, decay, noise, noiseColor, tone, bodyDecay,
}) {
  const f0 = hzFor(note);
  const ratios = [1, 1.7];
  return {
    // Culled rather than allowed to alias, the same rule modeRatios' caller applies.
    bodyHz: ratios.map((r) => Math.min(MAX_HZ, f0 * r)),
    bodyDecay: clamp(bodyDecay, MIN_DECAY, 2),
    bodyAmp: clamp(tone, 0, 1),
    noiseAmp: clamp(noise, 0, 1),
    noiseDecay: clamp(decay, MIN_DECAY, 2),
    tilt: noiseTilt(noiseColor),
    amp: clamp(velocity, 0, 1),
  };
}

/**
 * The six ratios of the hi-hat's metallic oscillator cluster, relative to its own
 * base frequency. Deliberately inharmonic -- a harmonic series would ring like a
 * chord, and a cymbal's clang comes from partials that don't line up.
 */
export const HAT_OSC_RATIOS = [1, 1.25, 1.49, 1.7, 1.79, 2.55];

/**
 * A hi-hat: a small metallic oscillator cluster, blended with noise and both shaped by
 * the same colour filter.
 *
 * The note sets both the colour filter's hinge and the oscillator cluster's base, so
 * the Pitch panel tunes the cymbal rather than doing nothing on this track. The
 * cluster sits two octaves up (`* 4`, spanning roughly `* 4` to `* 10.2` across its
 * six ratios) -- low enough that it reads as a metallic pitch rather than pure sizzle.
 * The colour filter hinges one octave above that (`* 8`, inside the cluster's own
 * span, near its upper partials) rather than well above it: a hinge sitting above the
 * whole cluster would put every partial in the filter's stopband on both the bandpass
 * and the highpass side, crushing the cluster at every colour setting regardless of
 * where the knob sits, which defeats the reason it exists. Hinged inside the span
 * instead, dark (bandpass) keeps the cluster's own body present and contained, and
 * bright (highpass) opens onto its upper partials plus the noise layer's sizzle --
 * so the colour knob genuinely trades cluster presence for air, which is what it is
 * supposed to do.
 */
export function hatHit({ note, velocity, decay, noise, noiseColor }) {
  const base = hzFor(note);
  return {
    bandHz: Math.min(MAX_HZ, base * 8),
    oscHz: HAT_OSC_RATIOS.map((r) => Math.min(MAX_HZ, base * 4 * r)),
    decay: clamp(decay, MIN_DECAY, 2),
    // 0 is the oscillator cluster alone, 1 is noise alone. Not a gain -- level comes
    // from the envelope, velocity and trim; this only shapes character, which is why
    // it can keep the old `noise` param and default.
    mix: clamp(noise, 0, 1),
    tilt: noiseTilt(noiseColor),
    amp: clamp(velocity, 0, 1),
  };
}
