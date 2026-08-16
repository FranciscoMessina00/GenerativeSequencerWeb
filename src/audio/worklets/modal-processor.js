/**
 * Modal string voice bank. Each voice is a set of two-pole resonators, one per
 * mode, struck by a shaped impulse. Mode tables come from `modal/modalModel.js`
 * with the note-on message, so this file is only the recursion, the voice pool,
 * and the ramps -- no physics is duplicated here.
 *
 * AudioWorkletGlobalScope has no module loader, so this must stay self-contained.
 */

const MAX_VOICES = 16;
const MAX_MODES = 32;
const SUB_BLOCK = 32; // ramp resolution: coefficients refresh this often
const TWO_PI = Math.PI * 2;
const LOG_1000 = Math.log(1000);
// Above this normalised frequency a two-pole resonator is numerically unhappy
// and would fold back into the audible band, so the mode is muted instead.
const MAX_OMEGA = Math.PI * 0.98;

/**
 * The T60, in seconds, the modes ring at while the envelope is holding the note open.
 *
 * A plucked string cannot physically be sustained, so an envelope's hold stage had
 * nothing to hold: the modes decayed at their own rate underneath a gain sitting at
 * full level, and a note was over before the hold was. Freezing the resonators for the
 * duration of attack + hold is what makes the stage mean something -- the spectrum the
 * pluck produced is held as it is, and the real per-mode decay (the one `damping`
 * shapes) starts when the release does.
 *
 * 60 s rather than an infinite ring: a pole radius of exactly 1 is marginally stable,
 * and this bank keeps its state in Float32Array, so rounding could as easily grow a
 * mode as fade it. This is long enough that the longest hold the schema allows -- one
 * second -- costs about a decibel, and short enough that every pole stays comfortably
 * inside the unit circle.
 */
const SUSTAIN_T60 = 60;

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

function makeVoice() {
  return {
    active: false,
    startFrame: 0,
    age: 0,
    peak: 0,
    count: 0,

    ratios: new Float32Array(MAX_MODES),
    /** The pole radius currently in force: sustained while held, real once released. */
    r: new Float32Array(MAX_MODES),
    /** The real one, from the note's own per-mode T60s. See SUSTAIN_T60. */
    rDecay: new Float32Array(MAX_MODES),
    /** True while the envelope is still in its attack or hold stage. */
    sustaining: false,
    a1: new Float32Array(MAX_MODES),
    a2: new Float32Array(MAX_MODES),
    norm: new Float32Array(MAX_MODES),
    gain: new Float32Array(MAX_MODES),
    gainFrom: new Float32Array(MAX_MODES),
    gainTo: new Float32Array(MAX_MODES),
    y1: new Float32Array(MAX_MODES),
    y2: new Float32Array(MAX_MODES),

    f0From: 440,
    f0To: 440,
    /** Whatever fundamental the coefficients were last built at -- see #updateCoefficients. */
    f0Current: 440,
    glideTotal: 0,
    glideDone: 0,
    glideExp: false,
    // True once the ramp has been snapped to its exact target -- see #renderVoice.
    // Without it a short glide can end up frozen a chunk short of f0To forever,
    // because the last update before glideDone crosses glideTotal is computed at
    // whatever glideDone was at the START of that chunk, never at exactly 1.
    glideSettled: false,

    mFrom: 4,
    mTo: 4,
    modTotal: 0,
    modDone: 0,
    modExp: false,

    exciteRemaining: 0,
    exciteTail: 0,
    exciteAmp: 1,
    exciteLpCoef: 1,
    exciteLpState: 0,

    /**
     * The amplitude envelope over the whole voice. It does not replace the modes'
     * own decay -- that is the string's physics, and `damping` shapes it per mode --
     * it shapes the note on top of it. The two share one dial: envDecay sets both
     * the ring the modes are given and this envelope's decay stage, so the string
     * still has exactly one answer to "how long is this note". See
     * audio/instruments.js's buildStringMessage.
     */
    env: makeEnvelope(),

    lifeRemaining: 0,
  };
}

class ModalProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({ length: MAX_VOICES }, makeVoice);
    this.ageCounter = 0;
    this.port.onmessage = (event) => this.#handleMessage(event.data);
  }

  #handleMessage(msg) {
    if (msg.type === 'noteOn') this.#noteOn(msg);
    else if (msg.type === 'panic') this.#panic();
    // A delivery barrier for offline rendering -- see percussion-processors.js, which
    // explains it at length. Port order is guaranteed, so a pong proves everything sent
    // before the ping has been handled. It is what selftest.html's own header asks for.
    else if (msg.type === 'ping') this.port.postMessage({ type: 'pong' });
  }

  #panic() {
    for (const v of this.voices) {
      v.active = false;
      v.y1.fill(0);
      v.y2.fill(0);
    }
  }

  /**
   * Pick a voice: free ones first, otherwise steal the quietest and break ties
   * toward the oldest. By amplitude rather than age, because for a plucked string
   * an already-decayed note is a far better sacrifice than a recent one.
   */
  #allocateVoice() {
    let best = null;
    for (const v of this.voices) {
      if (!v.active) return v;
      if (
        best === null ||
        v.peak < best.peak ||
        (v.peak === best.peak && v.age < best.age)
      ) {
        best = v;
      }
    }
    return best;
  }

  #noteOn(msg) {
    const v = this.#allocateVoice();
    const count = Math.min(MAX_MODES, msg.count);

    v.count = count;
    v.active = true;
    v.age = this.ageCounter++;
    v.peak = 0;
    v.startFrame = Math.round(msg.startTime * sampleRate);

    // Whether this note has anything to hold open. A message with no envelope, or one
    // whose attack and hold are both zero, goes straight to its natural decay -- which
    // is what a plucked string did before there was an envelope at all.
    const sustainSeconds = msg.env ? msg.env.attack + msg.env.hold : 0;
    v.sustaining = sustainSeconds > 0;
    const sustainRadius = Math.exp(-LOG_1000 / (SUSTAIN_T60 * sampleRate));

    for (let i = 0; i < count; i += 1) {
      v.ratios[i] = msg.ratios[i];
      v.gainFrom[i] = msg.gainsFrom[i];
      v.gainTo[i] = msg.gainsTo[i];
      // Ramps start at the origin gain; without a ramp both vectors are equal.
      v.gain[i] = msg.gainsFrom[i];
      // Pole radius from the mode's T60. Guarded because a zero decay would
      // divide by zero and a negative one would make the filter explode.
      const t60 = Math.max(0.005, msg.decays[i]);
      v.rDecay[i] = Math.exp(-LOG_1000 / (t60 * sampleRate));
      v.r[i] = v.sustaining ? sustainRadius : v.rDecay[i];
      v.y1[i] = 0;
      v.y2[i] = 0;
    }

    v.f0From = msg.f0From;
    v.f0To = msg.f0To;
    v.glideTotal = Math.round(msg.glideTime * sampleRate);
    v.glideDone = 0;
    v.glideSettled = false;
    v.glideExp = Boolean(msg.glideExponential);

    v.mFrom = msg.mFrom;
    v.mTo = msg.mTo;
    v.modTotal = Math.round(msg.modTime * sampleRate);
    v.modDone = 0;
    v.modExp = Boolean(msg.modExponential);

    // Excitation: a unit impulse through a one-pole lowpass, deliberately
    // deterministic. A noise burst is the usual cheap pluck, but its spectrum is
    // random, so each mode would be excited by whatever the noise happened to
    // contain there -- throwing away the point of computing per-mode amplitudes.
    // An impulse excites every mode equally, so the spectrum is exactly the
    // model's, and the one-pole's rolloff becomes the sole control over softness.
    v.exciteRemaining = 1;
    v.exciteAmp = msg.velocity;
    v.exciteLpState = 0;
    // softness 0 -> coefficient 1, a bare impulse and the brightest pluck;
    // softness 1 -> 0.015, roughly a 1.4 ms time constant and a dark, soft pluck.
    v.exciteLpCoef = 1 - 0.985 * Math.min(1, Math.max(0, msg.pluckSoftness));
    // Run the lowpass tail long enough to have decayed; beyond this the
    // excitation contributes nothing and the modes are just ringing.
    v.exciteTail = Math.ceil(8 / v.exciteLpCoef);

    startEnvelope(v.env, msg.env);

    // Retire the voice once its longest mode has decayed well past audibility -- or
    // once the envelope has closed over it, whichever comes first. A short envelope
    // over a long ring is otherwise seconds of CPU spent rendering a muted tail.
    //
    // The natural life is counted from the release, not from the note-on: while the
    // envelope holds the note open the modes are frozen and have not started spending
    // it yet, so measuring from zero would cut a held note's tail short.
    let longest = 0;
    for (let i = 0; i < count; i += 1) longest = Math.max(longest, msg.decays[i]);
    const naturalLife = Math.round((sustainSeconds + longest * 1.5 + 0.05) * sampleRate);
    v.lifeRemaining = v.env.active ? Math.min(naturalLife, v.env.totalFrames) : naturalLife;

    // No ramps? Lock the coefficients in once and take the fast path forever.
    this.#updateCoefficients(v, v.glideTotal > 0 ? msg.f0From : msg.f0To);
  }

  /** Recompute a1/a2/norm for every mode at fundamental `f0`. */
  #updateCoefficients(v, f0) {
    // Remembered so the release can rebuild the same coefficients at a new radius
    // without having to work out where a glide had got to -- see #releaseModes.
    v.f0Current = f0;
    const scale = (TWO_PI * f0) / sampleRate;
    for (let i = 0; i < v.count; i += 1) {
      const w = scale * v.ratios[i];
      if (w >= MAX_OMEGA || w <= 0) {
        v.norm[i] = 0;
        v.a1[i] = 0;
        v.a2[i] = 0;
        continue;
      }
      const cosw = Math.cos(w);
      const sinw = Math.sin(w);
      const r = v.r[i];
      v.a1[i] = -2 * r * cosw;
      v.a2[i] = r * r;
      // Struck-resonator normalisation. This filter's impulse response is
      //     h[n] = b0 * r^n * sin((n+1)w) / sin(w)
      // so b0 = sin(w) makes the envelope start at exactly 1 and each mode's
      // audible amplitude becomes precisely its gain B_n.
      //
      // NOT unity-peak-magnitude normalisation (b0 = |D(w)|), which is right for a
      // resonator driven continuously at resonance. These modes are struck once
      // and left to ring, and peak magnitude scales with Q -- so normalising by it
      // would tie each mode's amplitude to its own decay time, letting per-mode
      // damping silently rewrite the spectrum the model asked for.
      v.norm[i] = sinw;
    }
  }

  /**
   * Hand the modes back their own decay, now that the envelope has stopped holding
   * the note open.
   *
   * Only the pole radius changes: the ring state (`y1`/`y2`) is left exactly as it
   * is, so the note carries on from the amplitude and phase it was holding at and
   * simply begins to fade. Nothing here touches the frequency, so a glide in flight
   * is unaffected -- the coefficients are rebuilt at whatever fundamental the last
   * update used.
   */
  #releaseModes(v) {
    v.sustaining = false;
    for (let i = 0; i < v.count; i += 1) v.r[i] = v.rDecay[i];
    this.#updateCoefficients(v, v.f0Current);
  }

  /**
   * Advance the pitch ramp and refresh coefficients. Returns nothing; called
   * only while a voice is actually gliding.
   */
  #advanceGlide(v) {
    const t = Math.min(1, v.glideDone / v.glideTotal);
    const f0 = v.glideExp
      ? v.f0From * Math.pow(v.f0To / v.f0From, t)
      : v.f0From + (v.f0To - v.f0From) * t;
    this.#updateCoefficients(v, f0);
  }

  /**
   * Advance the plucking-position ramp. What interpolates is m itself; its
   * position between the endpoints becomes the blend weight between the two gain
   * vectors the main thread supplied.
   *
   * Blending endpoints is a linear approximation of re-deriving B_n from the
   * ramped m. B_n is smooth in m and the ramp lasts under one step, so it costs a
   * fraction of a dB mid-ramp and avoids duplicating the amplitude formula here.
   */
  #advanceModRamp(v) {
    const t = Math.min(1, v.modDone / v.modTotal);
    let w = t;
    if (v.modExp && Math.abs(v.mTo - v.mFrom) > 1e-9 && v.mFrom > 0 && v.mTo > 0) {
      const m = v.mFrom * Math.pow(v.mTo / v.mFrom, t);
      w = (m - v.mFrom) / (v.mTo - v.mFrom);
    }
    for (let i = 0; i < v.count; i += 1) {
      v.gain[i] = v.gainFrom[i] + (v.gainTo[i] - v.gainFrom[i]) * w;
    }
  }

  /** Render `length` samples of one voice, starting at `offset` in `out`. */
  #renderVoice(v, out, offset, length) {
    let peak = v.peak * 0.5; // decay the stealing metric so it tracks the tail
    let i = offset;
    const end = offset + length;

    while (i < end) {
      // While gliding, a chunk must never run past the ramp's own end: a normal
      // SUB_BLOCK-sized chunk started before the ramp finishes but covering
      // samples past it would render that whole chunk at the coefficients from
      // its *start*, and if that same chunk also carries glideDone past
      // glideTotal, the loop's `glideDone < glideTotal` guard goes false and
      // #advanceGlide is never called again -- freezing the pitch wherever that
      // stale chunk-start value left it, not at the target. The shorter the
      // glide relative to SUB_BLOCK, the worse this undershoots: a glide a few
      // samples long can end up frozen 30%+ of the way short of its note,
      // clearly out of tune, which is exactly backwards from what a short glide
      // should sound like.
      const gliding = v.glideTotal > 0 && v.glideDone < v.glideTotal;
      const chunk = Math.min(SUB_BLOCK, end - i, gliding ? Math.max(1, v.glideTotal - v.glideDone) : Infinity);

      // Checked per chunk rather than per sample: the same control rate every other
      // coefficient change here runs at, so the switch lands within 32 samples of the
      // envelope's own transition -- under a millisecond, and the level is continuous
      // across it either way, since only the rate of decay changes.
      if (v.sustaining && v.env.stage >= ENV_DECAY) {
        this.#releaseModes(v);
      }

      if (gliding) {
        this.#advanceGlide(v);
      }
      if (v.modTotal > 0 && v.modDone < v.modTotal) {
        this.#advanceModRamp(v);
      }

      const count = v.count;
      const { a1, a2, norm, gain, y1, y2 } = v;

      for (let s = 0; s < chunk; s += 1) {
        // --- excitation -----------------------------------------------------
        let x = 0;
        if (v.exciteTail > 0) {
          // One impulse sample, then only the lowpass tail.
          const impulse = v.exciteRemaining > 0 ? v.exciteAmp : 0;
          if (v.exciteRemaining > 0) v.exciteRemaining -= 1;
          v.exciteLpState += v.exciteLpCoef * (impulse - v.exciteLpState);
          x = v.exciteLpState;
          v.exciteTail -= 1;
        }

        // --- resonator bank -------------------------------------------------
        let sum = 0;
        for (let m = 0; m < count; m += 1) {
          const y = norm[m] * x - a1[m] * y1[m] - a2[m] * y2[m];
          y2[m] = y1[m];
          y1[m] = y;
          sum += y * gain[m];
        }

        // The envelope is the last thing applied, so the peak below tracks what is
        // actually audible -- a voice already faded out is then the right one for
        // #allocateVoice to steal, which it would not be if peak followed the modes'
        // raw ring underneath a closed envelope.
        sum *= envelopeSample(v.env);

        out[i] += sum;
        const mag = sum < 0 ? -sum : sum;
        if (mag > peak) peak = mag;
        i += 1;
      }

      v.glideDone += chunk;
      v.modDone += chunk;
      v.lifeRemaining -= chunk;

      // The chunk capping above guarantees this fires with glideDone exactly at
      // glideTotal, so the snap lands on the true target rather than one more
      // chunk-quantised approximation of it -- see the comment above.
      if (v.glideTotal > 0 && v.glideDone >= v.glideTotal && !v.glideSettled) {
        this.#updateCoefficients(v, v.f0To);
        v.glideSettled = true;
      }
    }

    v.peak = peak;
    if (v.lifeRemaining <= 0) {
      v.active = false;
      v.y1.fill(0);
      v.y2.fill(0);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    out.fill(0);

    const blockStart = currentFrame;
    const blockEnd = blockStart + out.length;

    for (const v of this.voices) {
      if (!v.active) continue;

      // Sample-accurate start: the note begins at the exact frame the scheduler
      // promised, regardless of when its message happened to arrive.
      if (v.startFrame >= blockEnd) continue;
      const offset = Math.max(0, v.startFrame - blockStart);
      this.#renderVoice(v, out, offset, out.length - offset);
    }

    // Intentionally not limited here: the granulator downstream owns the chain's
    // single saturation point, and its wet path adds coherent gain, so clipping
    // here would double-distort and still miss the real peak.
    //
    // Keep the node alive even when silent; it is a permanent source.
    return true;
  }
}

registerProcessor('modal-processor', ModalProcessor);

// addModule() evaluates this file as a module script, so this is legal -- and it is
// what keeps the top-level constants in their own scope rather than colliding with
// the other worklet's. Nothing is imported; the file stays self-contained.
export {};
