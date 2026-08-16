/**
 * The three percussion voices: kick, snare, hi-hat.
 *
 * One file registering three processors, because all three are built from the same
 * handful of primitives -- a noise source, a resonant colour filter and the shared AHD
 * amplitude envelope -- and the project already keeps a test (test/masterClip.test.js)
 * whose entire job is policing one piece of DSP duplicated between two worklets. Three
 * files would be three copies of the same helpers. Three classes rather than one with a
 * `kind` flag, so each instrument still reads as itself.
 *
 * None of the three carries a decay of its own any more. How long a hit lasts is the
 * envelope's, one shape for every instrument in the app -- so what is left in each
 * class below is only what makes that instrument sound like itself.
 *
 * Snare and hi-hat share a resonant bandpass/highpass colour filter (`setColorFilter`,
 * `colorFilteredSample`); the kick keeps the older, cheaper one-pole tilt
 * (`setTilt`, `tiltedNoise`) for its noise burst, where a narrow resonant band would
 * be the wrong tool for a short attack transient. The hi-hat additionally carries a
 * small inharmonic oscillator cluster, blended against noise before the colour
 * filter.
 *
 * Noise here is the signal, which is a deliberate departure from modal-processor's
 * argument against noise excitation. That argument is specific: exciting computed
 * per-mode amplitudes with a random spectrum throws away the amplitudes. A cymbal has
 * no modes worth computing -- it *is* broadband noise -- so the objection does not
 * apply, and an impulse would be the wrong exciter here.
 *
 * `Math.random()` matches the granulator's grain onsets, the only other randomness on
 * the audio thread. src/core/rng.js cannot be imported into a worklet, so percussion
 * noise joins the asymmetry that file's header already documents: a patch repeats its
 * notes exactly, but not its noise.
 *
 * Parameters arrive per hit over the message port rather than as AudioParams: every
 * one of them is latched when the hit starts, so there is nothing for a k-rate param
 * to smooth. Numbers are pre-clamped by percussion/percussionModel.js on the main
 * thread; the only conversions left here are the ones that need `sampleRate`.
 *
 * Self-contained: AudioWorkletGlobalScope has no module loader.
 */

/**
 * Four voices each. Percussion tails are short, so this is not the polyphony budget a
 * string needs -- it is enough for a flam and for a hit landing on the tail of the one
 * before it.
 */
const MAX_VOICES = 4;

/** Two resonators for the snare's shell. */
const MAX_MODES = 2;

/** −60 dB in nepers: ln(1000). Converts a T60 to a per-sample decay factor. */
const LOG_1000 = Math.log(1000);
const TWO_PI = Math.PI * 2;

/** Above this normalised frequency a two-pole resonator folds back into the band. */
const MAX_OMEGA = Math.PI * 0.98;

/** Ramp resolution, matching modal-processor: control rate outside, DSP inside. */
const SUB_BLOCK = 32;

/**
 * Where the tilt filter hinges, as a fraction of the voice's own reference frequency.
 * Below the hinge is "dark", above it "bright".
 */
const TILT_HINGE = 1;

/**
 * Everything below this is removed from a cymbal before it is coloured, whatever the
 * hat is tuned to. Without it a low tuning turns the dark end of the colour sweep into
 * a thump; fixed rather than tracking the note, because "not rumble" is not a musical
 * interval.
 */
const HAT_FLOOR_HZ = 300;

/**
 * Output trim per instrument, so a hit at full velocity with every layer up still
 * leaves headroom.
 *
 * These layers add: a kick is a full-scale sine plus a noise burst, a snare is a
 * resonator plus noise, and either sum can pass 1 on its own. The granulator downstream
 * would soft-clip it -- but its limiter exists for the granular layer's coherent gain,
 * not to rescue a source that was built too loud, and a voice that only sounds right
 * because something else is clipping it is a voice with no headroom left for three
 * other tracks. Chosen so a default hit lands near the string's own peak.
 */
const KICK_TRIM = 0.7;
const SNARE_TRIM = 0.55;
/**
 * Lowered from 0.8 when the shared envelope replaced the hi-hat's own 80 ms decay.
 * The cymbal now holds its level for as long as the envelope says instead of falling
 * away immediately, which gives the resonant colour filter time to ring up: measured
 * at note 48, a pure oscillator cluster at full velocity and the brightest colour
 * peaked at 0.80 before and 1.08 after, on the same trim. 0.72 puts that case back
 * inside full scale, and costs the default hit about a decibel.
 */
const HAT_TRIM = 0.72;

/**
 * How resonant the snare/hi-hat colour filter is. Fixed, because there is no spare
 * user-facing knob to drive it with: high enough that the colour sweep reads as a
 * filtered, snappy band rather than a one-pole tilt; low enough that it colours noise
 * instead of ringing like a synth filter.
 */
const COLOR_RESONANCE = 0.6;
/** The damping term a zero-delay-feedback SVF uses in place of a bare 1/Q, so it
    stays well-behaved at any cutoff. */
const COLOR_DAMPING = 2 * (1 - COLOR_RESONANCE);

/**
 * Six ±1 squares can sum to ±6 for an instant if their phases ever align; dividing by
 * 6 is the bound that guarantees the cluster alone never exceeds unity, not the
 * typical level (most of the time the six phases are decorrelated and the sum is well
 * under that peak).
 */
const HAT_OSC_GAIN = 1 / 6;

/** White noise in −1..1. */
function noise() {
  return Math.random() * 2 - 1;
}

/**
 * Per-sample multiplier that falls 60 dB in `t60` seconds -- the same relation
 * modal-processor uses for its pole radius, for the same reason: a decay time is what
 * a musician means, and a per-sample factor is what the loop can afford.
 */
function decayFactor(t60) {
  return Math.exp(-LOG_1000 / (Math.max(0.005, t60) * sampleRate));
}

/** One-pole coefficient for a cutoff in Hz, bounded so it cannot ring or freeze. */
function onePoleCoef(hz) {
  const bounded = Math.min(sampleRate * 0.45, Math.max(10, hz));
  return Math.min(1, Math.max(0.0001, 1 - Math.exp((-TWO_PI * bounded) / sampleRate)));
}

/**
 * The same Hz-to-semitone relation modal/modalModel.js's midiToHz uses, duplicated
 * because this file is import-free by convention. The kick's pitch sweep interpolates
 * in this space rather than in Hz, so it moves fastest right at the attack and settles
 * gently onto the note -- a kick's "punch" -- instead of falling at a constant rate.
 */
function hzToSemi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}
function semiToHz(semi) {
  return 440 * (2 ** ((semi - 69) / 12));
}

// ---------------------------------------------------------------------------
// The shared AHD amplitude envelope
//
// Duplicated verbatim in modal-processor.js and percussion-processors.js, and
// deliberately so: AudioWorkletGlobalScope has no module loader, so this cannot be
// imported from audio/envelope.js the way the main thread imports it. Same situation
// test/masterClip.test.js already polices for the clip curve, handled the same way --
// test/workletEnvelope.test.js reads both files and fails if the two copies differ by
// a character.
//
// This is the recursion form of audio/envelope.js's attackCurve/decayCurve: an add or
// a multiply per sample instead of a Math.exp, the idiom this project already uses for
// a decay. test/envelope.test.js runs this exact state machine against the closed form,
// which is what holds the shape that is heard to the shape that is drawn.
// ---------------------------------------------------------------------------

/** −60 dB in nepers, and the span an offset −60 dB curve actually covers. */
const ENV_LOG_1000 = Math.log(1000);
const ENV_FLOOR = Math.exp(-ENV_LOG_1000);
const ENV_SPAN = 1 - ENV_FLOOR;

/** The stages, in the order one note passes through them. */
const ENV_ATTACK = 0;
const ENV_HOLD = 1;
const ENV_DECAY = 2;
const ENV_DONE = 3;

/** Envelope state, preallocated on every voice like the rest of its fields. */
function makeEnvelope() {
  return {
    /** False for a hit that carried no envelope -- see startEnvelope. */
    active: false,
    stage: ENV_DONE,
    level: 1,
    peak: 1,
    remaining: 0,
    exponential: false,
    /** The un-normalised one-pole state, for the exponential curves. */
    state: 1,
    attackStep: 0,
    attackFactor: 0,
    holdFrames: 0,
    decayFrames: 1,
    decayStep: 0,
    decayFactor: 0,
    /** Attack + hold + decay, for sizing how long the voice can be heard. */
    totalFrames: 0,
  };
}

/**
 * Latch one hit's envelope. `spec` is what audio/envelope.js's ahdEnvelope() returned,
 * with its times in seconds and its step-boundary truncation already applied.
 *
 * A message with no envelope leaves this inactive, which renders as a constant 1 --
 * so a note-on assembled by hand (the check pages under test/browser) still sounds
 * rather than falling silent on a field it never knew to send.
 */
function startEnvelope(e, spec) {
  if (!spec) {
    e.active = false;
    e.stage = ENV_DONE;
    e.level = 1;
    e.totalFrames = 0;
    return;
  }

  const attackFrames = Math.round(spec.attack * sampleRate);
  // The *requested* attack, not the truncated one: the curve is a function of what was
  // asked for, which is what leaves a cut-short attack at spec.peak rather than at 1.
  const fullFrames = Math.round(spec.attackFull * sampleRate);

  e.active = true;
  e.exponential = Boolean(spec.exponential);
  e.peak = spec.peak;
  e.state = 1;
  e.holdFrames = Math.round(spec.hold * sampleRate);
  e.decayFrames = Math.max(1, Math.round(spec.decay * sampleRate));
  e.attackStep = attackFrames > 0 ? spec.peak / attackFrames : 0;
  e.attackFactor = fullFrames > 0 ? Math.exp(-ENV_LOG_1000 / fullFrames) : 0;
  e.decayStep = spec.peak / e.decayFrames;
  e.decayFactor = Math.exp(-ENV_LOG_1000 / e.decayFrames);
  e.totalFrames = attackFrames + e.holdFrames + e.decayFrames;

  if (attackFrames > 0) {
    e.stage = ENV_ATTACK;
    e.level = 0;
    e.remaining = attackFrames;
  } else {
    // A zero attack is at full level on its very first sample.
    e.stage = ENV_HOLD;
    e.level = spec.peak;
    e.remaining = e.holdFrames;
  }
}

/**
 * One sample: the gain to multiply this frame by, with the state advanced past it.
 * The level returned is the one from *before* the advance, which is what makes a zero
 * attack audible on the frame the note starts rather than one frame later.
 */
function envelopeSample(e) {
  if (!e.active) return 1;
  const level = e.level;

  if (e.stage === ENV_ATTACK) {
    if (e.exponential) {
      e.state *= e.attackFactor;
      e.level = (1 - e.state) / ENV_SPAN;
    } else {
      e.level += e.attackStep;
    }
    e.remaining -= 1;
    if (e.remaining <= 0) {
      e.level = e.peak;
      e.stage = ENV_HOLD;
      e.remaining = e.holdFrames;
      e.state = 1;
    }
  } else if (e.stage === ENV_HOLD) {
    e.level = e.peak;
    e.remaining -= 1;
    if (e.remaining <= 0) {
      e.stage = ENV_DECAY;
      e.remaining = e.decayFrames;
    }
  } else if (e.stage === ENV_DECAY) {
    if (e.exponential) {
      e.state *= e.decayFactor;
      e.level = (e.peak * (e.state - ENV_FLOOR)) / ENV_SPAN;
    } else {
      e.level -= e.decayStep;
    }
    e.remaining -= 1;
    if (e.remaining <= 0 || e.level <= 0) {
      e.level = 0;
      e.stage = ENV_DONE;
    }
  } else {
    e.level = 0;
  }

  return level;
}

// ---------------------------------------------------------------------------

/**
 * A voice, preallocated at its widest. One flat bag rather than a class per
 * instrument's state: each processor only ever runs one instrument, so the unused
 * fields cost four objects' worth of slots and buy a shared pool and scheduler.
 */
function makeVoice() {
  return {
    active: false,
    startFrame: 0,
    age: 0,

    /**
     * The amplitude envelope, shared with the string and with the other two
     * percussion voices -- one shape for the whole instrument. It is what replaced
     * each voice's private exponential decay, so nothing below sets a decay of its
     * own except the two that are timbre rather than length (the kick's noise burst
     * and the snare's shell).
     */
    env: makeEnvelope(),
    /** Frames left before the voice is inaudible and can be reclaimed. */
    lifeRemaining: 0,
    /** Velocity, applied once at the end of the chain. */
    amp: 1,

    /** Kick: a sine whose pitch falls from semiStart to semiEnd, in semitones. */
    phase: 0,
    semiStart: 0,
    semiEnd: 0,
    sweep: 0,
    sweepFactor: 0,

    /** Kick's noise burst: its own envelope, tilted through the one-pole below. */
    noiseAmp: 0,
    noiseEnv: 0,
    noiseEnvFactor: 0,
    tiltCoef: 0,
    tiltDark: 1,
    tiltBright: 0,
    tiltState: 0,
    /** Hi-hat only: a second one-pole, subtracted to keep low rumble out. */
    rumbleCoef: 0,
    rumbleState: 0,

    /** Snare + hi-hat: the shared resonant colour filter, bandpass and highpass. */
    svfBp: 0,
    svfLp: 0,
    colorG: 0,
    colorD: 0,
    colorDark: 1,
    colorBright: 0,

    /** Snare: the shell, as impulse-driven two-pole resonators. */
    modeCount: 0,
    bodyAmp: 0,
    bodyEnvFactor: 0,
    bodyEnv: 0,
    a1: new Float32Array(MAX_MODES),
    a2: new Float32Array(MAX_MODES),
    norm: new Float32Array(MAX_MODES),
    y1: new Float32Array(MAX_MODES),
    y2: new Float32Array(MAX_MODES),
    /** One sample of excitation, then the resonators ring on their own. */
    exciteRemaining: 0,

    /** Hi-hat: a small metallic oscillator cluster, blended against noise. */
    hatMix: 0,
    oscPhase: new Float32Array(6),
    oscInc: new Float32Array(6),
  };
}

/** Back to silence, with every filter's memory cleared. */
function resetVoice(v) {
  v.active = false;
  // A null spec is the "no envelope" case, which is exactly what a silent voice is.
  startEnvelope(v.env, null);
  v.noiseEnv = 0;
  v.bodyEnv = 0;
  v.phase = 0;
  v.tiltState = 0;
  v.rumbleState = 0;
  v.svfBp = 0;
  v.svfLp = 0;
  v.exciteRemaining = 0;
  v.lifeRemaining = 0;
  v.y1.fill(0);
  v.y2.fill(0);
  v.oscPhase.fill(0);
}

/**
 * Set up one impulse-driven resonator: the same coefficients modal-processor derives,
 * including `norm = sin(w)` so the mode's envelope starts at exactly 1 and its audible
 * amplitude is its gain rather than a function of its own decay time.
 */
function setResonator(v, index, hz, r) {
  const w = (TWO_PI * hz) / sampleRate;
  if (w >= MAX_OMEGA || w <= 0) {
    v.norm[index] = 0;
    v.a1[index] = 0;
    v.a2[index] = 0;
    return;
  }
  v.a1[index] = -2 * r * Math.cos(w);
  v.a2[index] = r * r;
  v.norm[index] = Math.sin(w);
}

/**
 * Latch a colour setting: where the tilt hinges, and the gain each half needs.
 *
 * The two halves of a one-pole split do NOT carry equal noise power -- the bright half
 * keeps everything from the hinge to Nyquist and the dark half only what is below it,
 * so at a 4 kHz hinge the bright side has several times the energy. Crossfading them
 * with equal-power gains alone therefore made the colour knob a volume knob, which is
 * exactly what it was supposed not to be.
 *
 * Both variances are known in closed form for white noise through `y += a(x - y)`:
 *
 *   var(lowpass)  = a / (2 - a)
 *   var(highpass) = var(x - y) = 1 - 2a + a / (2 - a)
 *
 * Normalising each half to unit variance first is what makes noiseTilt's equal-power
 * crossfade mean what it says. Computed once per hit, not per sample.
 */
function setTilt(v, hingeHz, tilt) {
  const a = onePoleCoef(hingeHz);
  v.tiltCoef = a;
  const lowVariance = a / (2 - a);
  const highVariance = Math.max(1e-6, 1 - 2 * a + lowVariance);
  v.tiltDark = tilt.dark / Math.sqrt(Math.max(1e-6, lowVariance));
  v.tiltBright = tilt.bright / Math.sqrt(highVariance);
}

/**
 * One tilt-filtered noise sample.
 *
 * A single one-pole gives both halves: its output is the dark copy, and the input minus
 * its output is the bright one. The gains come from setTilt, so sweeping the colour
 * moves energy up and down the band at a constant level.
 */
function tiltedNoise(v) {
  const x = noise();
  v.tiltState += v.tiltCoef * (x - v.tiltState);
  return v.tiltDark * v.tiltState + v.tiltBright * (x - v.tiltState);
}

/**
 * Latch a colour setting for the resonant filter snare and hi-hat share: where it
 * hinges, and the gain each output needs.
 *
 * Snare and hi-hat colour is a resonant band, not a one-pole tilt -- a bandpass reads
 * as filtered and snappy where a one-pole only reads as darker or brighter. This is
 * the same zero-delay-feedback topology `setResonator`'s two-pole already uses, kept
 * open as two simultaneous outputs (bandpass and highpass) instead of summed into one
 * ringing mode. "Dark" is the bandpass -- a contained, tonal-ish band -- and "bright"
 * is the highpass; there is no lowpass side here, on purpose, because a lowpassed
 * cymbal or rattle is just quieter noise, not a different colour.
 *
 * As with the one-pole tilt, the two outputs do NOT carry equal noise power for a
 * fixed resonance, so crossfading them with noiseTilt's equal-power gains alone would
 * make the colour knob a volume knob again. There is no formula as short as the
 * one-pole's `a / (2 - a)` for a resonant filter, so this finds each output's
 * steady-state variance for white-noise input by iterating the filter's own
 * covariance update to convergence -- the discrete Lyapunov equation
 * `Sigma = A*Sigma*A' + B*B'` for the filter's two-state update `s' = A*s + B*x`,
 * solved by fixed-point rather than in closed form because the ZDF SVF is
 * unconditionally stable (its poles stay inside the unit circle for any cutoff and
 * this fixed damping), so the iteration is guaranteed to converge, and 64 steps of a
 * six-multiply update -- once per hit, not per sample -- costs nothing worth avoiding
 * the risk of a hand-derived closed form.
 */
function setColorFilter(v, hingeHz, tilt) {
  const bounded = Math.min(sampleRate * 0.45, Math.max(10, hingeHz));
  const g = Math.tan((Math.PI * bounded) / sampleRate);
  const D = 1 / (1 + g * (g + COLOR_DAMPING));

  // One filter step's state update, s' = A*s + B*x -- see colorFilteredSample, which
  // is this same arithmetic run once per sample instead of iterated to convergence.
  const a11 = 1 - g * COLOR_DAMPING * D;
  const a12 = -g * D;
  const a21 = g * a11;
  const a22 = 1 - g * g * D;
  const b1 = g * D;
  const b2 = g * b1;

  // Highpass reads off the same step: hp = c1*s1 + c2*s2 + d*x.
  const c1 = -COLOR_DAMPING * D;
  const c2 = -D;

  let s11 = 0;
  let s22 = 0;
  let s12 = 0;
  for (let n = 0; n < 64; n += 1) {
    const n11 = a11 * a11 * s11 + 2 * a11 * a12 * s12 + a12 * a12 * s22 + b1 * b1;
    const n22 = a21 * a21 * s11 + 2 * a21 * a22 * s12 + a22 * a22 * s22 + b2 * b2;
    const n12 = a11 * a21 * s11 + (a12 * a21 + a11 * a22) * s12 + a12 * a22 * s22 + b1 * b2;
    s11 = n11;
    s22 = n22;
    s12 = n12;
  }

  const bpVariance = s11;
  const hpVariance = c1 * c1 * s11 + 2 * c1 * c2 * s12 + c2 * c2 * s22 + D * D;

  v.colorG = g;
  v.colorD = D;
  v.colorDark = tilt.dark / Math.sqrt(Math.max(1e-6, bpVariance));
  v.colorBright = tilt.bright / Math.sqrt(Math.max(1e-6, hpVariance));
}

/**
 * One sample through the shared resonant colour filter.
 *
 * The zero-delay-feedback update itself: a highpass read directly off the input and
 * both integrator states, then the bandpass and lowpass integrators advance from it.
 * Only `svfBp`/`svfLp` are kept between calls -- unlike setResonator's single ringing
 * mode, this needs both live outputs every sample, not just the state to produce one
 * of them later.
 */
function colorFilteredSample(v, x) {
  const hp = (x - COLOR_DAMPING * v.svfBp - v.svfLp) * v.colorD;
  const bp = v.colorG * hp + v.svfBp;
  const lp = v.colorG * bp + v.svfLp;
  v.svfBp = bp;
  v.svfLp = lp;
  return v.colorDark * bp + v.colorBright * hp;
}

/**
 * The pool, the message port, and the sample-accurate scheduling every percussion
 * voice shares. Subclasses fill in `initVoice` and `renderVoice`; those two are the
 * extension points, so they are ordinary methods rather than `#private` ones.
 */
class PercussionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({ length: MAX_VOICES }, makeVoice);
    this.ageCounter = 0;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(msg) {
    if (msg.type === 'noteOn') this.startVoice(msg);
    else if (msg.type === 'panic') this.panic();
    // A delivery barrier, for offline rendering. A port message crosses threads
    // asynchronously, and an OfflineAudioContext renders as fast as the CPU allows --
    // fast enough to pass a note's start frame before the note has arrived, which is
    // what makes test/browser/selftest.html report zeros for voices that work. Port
    // order is guaranteed, so a pong proves everything sent before the ping landed.
    // Costs nothing in production, where nobody pings.
    else if (msg.type === 'ping') this.port.postMessage({ type: 'pong' });
  }

  /**
   * Free voices first, then the oldest.
   *
   * By age rather than by amplitude, which is where this differs from the string: a
   * drum hit is a gesture with a beginning, so the one that has been ringing longest
   * is the right sacrifice. It also cannot steal a voice that is waiting for a future
   * `startFrame`, since that one is always the newest.
   */
  allocate() {
    let oldest = this.voices[0];
    for (const v of this.voices) {
      if (!v.active) return v;
      if (v.age < oldest.age) oldest = v;
    }
    return oldest;
  }

  startVoice(msg) {
    const v = this.allocate();
    resetVoice(v);
    v.active = true;
    v.age = this.ageCounter++;
    // Sample-accurate: the hit lands on the frame the scheduler promised, whenever the
    // message happened to arrive. See process().
    v.startFrame = Math.round(msg.startTime * sampleRate);
    v.amp = msg.amp;
    startEnvelope(v.env, msg.env);
    // The envelope is what silences a percussion hit now, so it is also what says how
    // long the voice is worth rendering. A hit that carried none -- a message built by
    // hand, see startEnvelope -- gets a second, which is longer than any of these three
    // instruments' own tails and short enough that the pool still turns over.
    v.lifeRemaining = v.env.active ? v.env.totalFrames : Math.round(sampleRate);
    this.initVoice(v, msg);
  }

  /** Silence everything, instantly -- used when the transport stops. */
  panic() {
    for (const v of this.voices) resetVoice(v);
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    out.fill(0);

    const blockStart = currentFrame;
    const blockEnd = blockStart + out.length;

    for (const v of this.voices) {
      if (!v.active) continue;

      // Still in the future: nothing about the hit ages, because every counter it owns
      // is advanced inside renderVoice. It is frozen, not started and muted.
      if (v.startFrame >= blockEnd) continue;
      // Late, because the message was slow: it starts at the head of this block and
      // plays in full rather than being dropped or skipped forward.
      const offset = Math.max(0, v.startFrame - blockStart);
      this.renderVoice(v, out, offset, out.length - offset);

      if (v.lifeRemaining <= 0) resetVoice(v);
    }

    // Not limited here: the granulator downstream owns the chain's single saturation
    // point. Kept alive even when silent; it is a permanent source.
    return true;
  }

  /**
   * Latch one hit's settings. `lifeRemaining` is not a subclass's job any more -- the
   * shared envelope is what silences every one of these voices, so startVoice above
   * sizes the life from it and a subclass only has to describe its own sound.
   * Unimplemented here on purpose: every real instrument overrides this. Parameters are
   * still named and documented, since this signature is the interface a subclass fills in.
   *
   * @param {object} _v the voice being started
   * @param {object} _msg the note-on
   */
  initVoice(_v, _msg) {}

  /**
   * Render `length` samples into `out` starting at `offset`, additively, and decrement
   * `lifeRemaining` by what was rendered. Unimplemented here for the same reason as
   * `initVoice` above.
   *
   * @param {object} _v @param {Float32Array} _out @param {number} _offset @param {number} _length
   */
  renderVoice(_v, _out, _offset, _length) {}
}

/**
 * Kick: a sine whose pitch falls from `fStart` to `fEnd`, plus a noise burst on the
 * attack for the sound of the beater itself.
 *
 * The falling pitch is what makes the attack read as a strike rather than as a note
 * starting -- the ear hears the drop as impact, not as melody. The interpolation
 * itself happens in semitone space rather than in Hz: additive in semitones means
 * multiplicative in Hz, so the same envelope covers more Hz right at the attack and
 * eases into the settle, which reads as more of a strike than a straight Hz ramp does.
 */
class KickProcessor extends PercussionProcessor {
  initVoice(v, msg) {
    v.semiStart = hzToSemi(msg.fStart);
    v.semiEnd = hzToSemi(msg.fEnd);
    // Falls from 1 to 0 with `sweepTime` as its time constant, so the pitch starts at
    // semiStart and settles onto semiEnd.
    v.sweep = 1;
    v.sweepFactor = Math.exp(-1 / (Math.max(0.001, msg.sweepTime) * sampleRate));

    v.noiseAmp = msg.noiseAmp;
    // The burst keeps an envelope of its own: it is the beater's click *inside* the
    // hit, over long before the body is, so it is timbre rather than note length --
    // which is the one thing the shared envelope owns.
    v.noiseEnv = 1;
    v.noiseEnvFactor = decayFactor(msg.noiseDecay);
    // Hinged on the starting pitch: the click belongs to the attack, so what counts as
    // "bright" for it scales with how high the sweep begins.
    setTilt(v, msg.fStart * TILT_HINGE, msg.tilt);
  }

  renderVoice(v, out, offset, length) {
    const end = offset + length;
    let i = offset;

    while (i < end) {
      const chunk = Math.min(SUB_BLOCK, end - i);
      // Frequency is a control-rate quantity: once per chunk is far finer than the ear
      // resolves, and it keeps a log2/pow pair out of the sample loop.
      const semi = v.semiEnd + (v.semiStart - v.semiEnd) * v.sweep;
      const hz = semiToHz(semi);
      const increment = (TWO_PI * hz) / sampleRate;

      for (let s = 0; s < chunk; s += 1) {
        v.phase += increment;
        if (v.phase >= TWO_PI) v.phase -= TWO_PI;

        // Starting at phase 0 means starting at a zero crossing, so the hit has no
        // click of its own beyond the one the noise burst is there to provide.
        let sample = Math.sin(v.phase);
        if (v.noiseAmp > 0) sample += tiltedNoise(v) * v.noiseEnv * v.noiseAmp;

        out[i] += sample * envelopeSample(v.env) * v.amp * KICK_TRIM;
        v.noiseEnv *= v.noiseEnvFactor;
        i += 1;
      }

      v.sweep *= v.sweepFactor ** chunk;
      v.lifeRemaining -= chunk;
    }
  }
}

/**
 * Snare: a tuned shell under a wire rattle.
 *
 * The shell is two impulse-driven resonators at an inharmonic ratio, which stops the
 * body reading as a pitched tom. The rattle is noise through the shared resonant
 * colour filter, with its own decay. Two independent amounts rather than one
 * crossfade, so either layer can be soloed to hear what it contributes.
 */
class SnareProcessor extends PercussionProcessor {
  initVoice(v, msg) {
    const r = decayFactor(msg.bodyDecay);
    v.modeCount = Math.min(MAX_MODES, msg.bodyHz.length);
    for (let m = 0; m < v.modeCount; m += 1) setResonator(v, m, msg.bodyHz[m], r);
    v.bodyAmp = msg.bodyAmp;
    v.bodyEnv = 1;
    v.bodyEnvFactor = decayFactor(msg.bodyDecay);
    v.exciteRemaining = 1;

    // The rattle has no envelope of its own any more -- the shared one shapes it, and
    // the shell's own ring above is the only decay left here, because how tight the
    // shell is and how long the hit lasts are two different questions.
    v.noiseAmp = msg.noiseAmp;
    // Hinged above the shell, so the colour knob sweeps the rattle rather than
    // re-voicing the drum underneath it.
    setColorFilter(v, msg.bodyHz[0] * 8, msg.tilt);
  }

  renderVoice(v, out, offset, length) {
    const end = offset + length;
    let i = offset;
    const { a1, a2, norm, y1, y2 } = v;

    while (i < end) {
      const chunk = Math.min(SUB_BLOCK, end - i);

      for (let s = 0; s < chunk; s += 1) {
        let sample = 0;

        if (v.bodyAmp > 0) {
          // One sample of excitation, then the resonators ring on their own.
          const x = v.exciteRemaining > 0 ? 1 : 0;
          if (v.exciteRemaining > 0) v.exciteRemaining -= 1;
          let body = 0;
          for (let m = 0; m < v.modeCount; m += 1) {
            const y = norm[m] * x - a1[m] * y1[m] - a2[m] * y2[m];
            y2[m] = y1[m];
            y1[m] = y;
            body += y;
          }
          sample += body * v.bodyEnv * v.bodyAmp;
        }

        if (v.noiseAmp > 0) sample += colorFilteredSample(v, noise()) * v.noiseAmp;

        out[i] += sample * envelopeSample(v.env) * v.amp * SNARE_TRIM;
        v.bodyEnv *= v.bodyEnvFactor;
        i += 1;
      }

      v.lifeRemaining -= chunk;
    }
  }
}

/**
 * Hi-hat: a small metallic oscillator cluster, blended against noise and both shaped
 * by the shared resonant colour filter.
 *
 * The note sets where the colour filter hinges and where the cluster sits, so the
 * Pitch panel genuinely tunes the cymbal instead of doing nothing on this track. The
 * blend runs 0 (oscillator cluster alone) to 1 (noise alone), and it is mixed in
 * before the colour filter rather than after -- the
 * filter's coefficients are latched for the whole hit, so it is linear for that
 * duration and the two orders are exactly equal, at half the per-sample cost. A second
 * one-pole is subtracted after the colour filter to keep low rumble out -- without it,
 * a dark colour setting turns the cymbal into a thump.
 */
class HihatProcessor extends PercussionProcessor {
  initVoice(v, msg) {
    v.hatMix = msg.mix;
    for (let o = 0; o < 6; o += 1) v.oscInc[o] = msg.oscHz[o] / sampleRate;

    // Nothing decays inside a hi-hat any more: the cymbal is a steady blend of
    // cluster and noise, and the shared envelope alone decides whether it reads as
    // closed or open.
    setColorFilter(v, msg.bandHz, msg.tilt);
    v.rumbleCoef = onePoleCoef(HAT_FLOOR_HZ);
  }

  renderVoice(v, out, offset, length) {
    const end = offset + length;
    let i = offset;
    const { oscPhase, oscInc } = v;

    while (i < end) {
      const chunk = Math.min(SUB_BLOCK, end - i);

      for (let s = 0; s < chunk; s += 1) {
        // Square via phase comparison, not Math.sin/Math.sign -- six oscillators a
        // sample is not the place for a transcendental call.
        let oscSum = 0;
        for (let o = 0; o < 6; o += 1) {
          oscPhase[o] += oscInc[o];
          if (oscPhase[o] >= 1) oscPhase[o] -= 1;
          oscSum += oscPhase[o] < 0.5 ? 1 : -1;
        }
        oscSum *= HAT_OSC_GAIN;

        const x = v.hatMix * noise() + (1 - v.hatMix) * oscSum;
        const cymbal = colorFilteredSample(v, x);

        // The floor comes off after the colour: applied before it, it would eat the
        // dark end of the sweep and turn the colour knob back into a volume knob,
        // which is what the normalised colour gains exist to avoid.
        v.rumbleState += v.rumbleCoef * (cymbal - v.rumbleState);

        out[i] += (cymbal - v.rumbleState) * envelopeSample(v.env) * v.amp * HAT_TRIM;
        i += 1;
      }

      v.lifeRemaining -= chunk;
    }
  }
}

registerProcessor('kick-processor', KickProcessor);
registerProcessor('snare-processor', SnareProcessor);
registerProcessor('hihat-processor', HihatProcessor);

// addModule() evaluates this file as a module script, so this is legal -- and it is
// what keeps the top-level constants in their own scope rather than colliding with the
// other worklets'. Nothing is imported; the file stays self-contained.
export {};
