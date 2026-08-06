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

function makeVoice() {
  return {
    active: false,
    startFrame: 0,
    age: 0,
    peak: 0,
    count: 0,

    ratios: new Float32Array(MAX_MODES),
    r: new Float32Array(MAX_MODES),
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
    glideTotal: 0,
    glideDone: 0,
    glideExp: false,

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

    for (let i = 0; i < count; i += 1) {
      v.ratios[i] = msg.ratios[i];
      v.gainFrom[i] = msg.gainsFrom[i];
      v.gainTo[i] = msg.gainsTo[i];
      // Ramps start at the origin gain; without a ramp both vectors are equal.
      v.gain[i] = msg.gainsFrom[i];
      // Pole radius from the mode's T60. Guarded because a zero decay would
      // divide by zero and a negative one would make the filter explode.
      const t60 = Math.max(0.005, msg.decays[i]);
      v.r[i] = Math.exp(-LOG_1000 / (t60 * sampleRate));
      v.y1[i] = 0;
      v.y2[i] = 0;
    }

    v.f0From = msg.f0From;
    v.f0To = msg.f0To;
    v.glideTotal = Math.round(msg.glideTime * sampleRate);
    v.glideDone = 0;
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

    // Retire the voice once its longest mode has decayed well past audibility.
    let longest = 0;
    for (let i = 0; i < count; i += 1) longest = Math.max(longest, msg.decays[i]);
    v.lifeRemaining = Math.round((longest * 1.5 + 0.05) * sampleRate);

    // No ramps? Lock the coefficients in once and take the fast path forever.
    this.#updateCoefficients(v, v.glideTotal > 0 ? msg.f0From : msg.f0To);
  }

  /** Recompute a1/a2/norm for every mode at fundamental `f0`. */
  #updateCoefficients(v, f0) {
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
      const chunk = Math.min(SUB_BLOCK, end - i);

      if (v.glideTotal > 0 && v.glideDone < v.glideTotal) {
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

        out[i] += sum;
        const mag = sum < 0 ? -sum : sum;
        if (mag > peak) peak = mag;
        i += 1;
      }

      v.glideDone += chunk;
      v.modDone += chunk;
      v.lifeRemaining -= chunk;
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
