/**
 * Real-time granulator, ported from the `GrainBuf` section of the source's
 * SynthDef (`TriggerWithGlide.scd:209-223`).
 *
 * The string signal is written continuously into a 3-second circular buffer.
 * Grains fire from a Poisson process and each reads from a fixed distance behind
 * the write head, so the granulator always works on material the string has just
 * produced -- it is a live effect, not a sampler.
 *
 * Dry/wet lives inside this processor rather than as a parallel Web Audio path,
 * so the dry signal stays sample-aligned with the wet one. Splitting the graph
 * would need a compensating delay on the dry side to avoid comb filtering.
 *
 * Self-contained: AudioWorkletGlobalScope has no module loader.
 */

const BUFFER_SECONDS = 3;
const MAX_GRAINS = 64; // the source's maxGrains
const GRAIN_DENSITY = 16; // the source's Dust.kr(16), grains per second
const READ_DELAY = 0.2; // the source's ptrdelay, seconds behind the write head
const MAX_GRAIN_DUR = 0.3; // the source's min(0.3, ...) ceiling
const TWO_PI = Math.PI * 2;

/** Below this level the limiter is bypassed entirely. */
const KNEE = 0.8;

/**
 * Soft-knee limiter: identity below KNEE, asymptotic to +/-1 above it.
 *
 * This is the only saturation stage in the chain, and it lives here because this
 * is the last DSP node before the master fader. It matters more than it looks:
 * at grain pitch 1 every grain reads the same delayed signal at the same speed,
 * so they sum *coherently* -- with ~3 grains overlapping on average the wet path
 * reaches roughly 1.7x the dry level. GrainBuf in the original does not normalise
 * for that either, so the gain is kept and the peak is caught here instead of
 * being left to hard-clip in the output device.
 *
 * The knee is what makes it safe to sit on the dry path. A plain cubic soft clip
 * would shave a few percent off *every* sample, so a fully-dry setting would no
 * longer be a true bypass. This form is exactly the identity below KNEE and
 * C1-continuous across it, so normal-level signals pass through untouched and
 * only genuine overshoot is bent.
 */
function softClip(x) {
  const a = x < 0 ? -x : x;
  if (a <= KNEE) return x;
  const u = (a - KNEE) / (1 - KNEE);
  const limited = KNEE + (1 - KNEE) * (u / (1 + u));
  return x < 0 ? -limited : limited;
}

class GranulatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Grain playback rate, i.e. pitch. 1 = unshifted.
      { name: 'grainPitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' },
      // XFade2 pan: -1 is fully dry, +1 fully wet.
      { name: 'dryWet', defaultValue: -1, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.bufferLength = Math.ceil(BUFFER_SECONDS * sampleRate);
    this.buffer = new Float32Array(this.bufferLength);
    this.writeHead = 0;

    // Flat arrays rather than objects, so nothing allocates on the audio thread.
    this.grainPos = new Float32Array(MAX_GRAINS);
    this.grainInc = new Float32Array(MAX_GRAINS);
    this.grainAge = new Float32Array(MAX_GRAINS);
    this.grainLen = new Float32Array(MAX_GRAINS);
    this.grainActive = new Uint8Array(MAX_GRAINS);

    // Smoothed crossfade gains. The params are k-rate, so a knob move lands as a
    // step every 128 samples; one-poling the gains keeps that from zippering.
    this.dryGain = 1;
    this.wetGain = 0;
    this.smoothing = 1 - Math.exp(-1 / (0.005 * sampleRate)); // ~5 ms
  }

  /** Cubic (Catmull-Rom) read, matching the source's `interp: 4`. */
  #readCubic(position) {
    const len = this.bufferLength;
    const buf = this.buffer;
    const i1 = Math.floor(position);
    const frac = position - i1;
    const i0 = (i1 - 1 + len) % len;
    const y1 = buf[i1 % len];
    const y0 = buf[i0];
    const y2 = buf[(i1 + 1) % len];
    const y3 = buf[(i1 + 2) % len];

    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }

  #spawnGrain(rate) {
    let slot = -1;
    for (let g = 0; g < MAX_GRAINS; g += 1) {
      if (!this.grainActive[g]) {
        slot = g;
        break;
      }
    }
    // At 16 grains/s and up to 0.3 s each, ~5 overlap on average; hitting the
    // 64-grain ceiling means dropping this grain, exactly as maxGrains does.
    if (slot === -1) return;

    // dur = min(0.3, ptrdelay / rate) is what keeps a fast grain from overtaking
    // the write head: at rate r it consumes r seconds of buffer per second of
    // output, so starting 0.2 s back it arrives at the head precisely as it ends.
    const duration = Math.min(MAX_GRAIN_DUR, READ_DELAY / rate);
    const length = Math.max(2, Math.round(duration * sampleRate));

    this.grainActive[slot] = 1;
    this.grainAge[slot] = 0;
    this.grainLen[slot] = length;
    this.grainInc[slot] = rate;
    this.grainPos[slot] =
      (this.writeHead - READ_DELAY * sampleRate + this.bufferLength) % this.bufferLength;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;

    const input = inputs[0]?.[0];
    const rate = parameters.grainPitch[0];
    const pan = parameters.dryWet[0];

    // Equal-power crossfade, as SC's XFade2: -1 all dry, +1 all wet, and both
    // legs at 1/sqrt(2) in the middle so perceived loudness stays constant.
    const angle = ((pan + 1) * Math.PI) / 4;
    const targetDry = Math.cos(angle);
    const targetWet = Math.sin(angle);

    // Probability of a grain onset per sample -- a Poisson process with the same
    // mean rate as Dust.
    const spawnProbability = GRAIN_DENSITY / sampleRate;
    const len = this.bufferLength;

    for (let i = 0; i < out.length; i += 1) {
      const dry = input ? input[i] : 0;

      this.buffer[this.writeHead] = dry;
      this.writeHead += 1;
      if (this.writeHead >= len) this.writeHead = 0;

      if (Math.random() < spawnProbability) this.#spawnGrain(rate);

      let wet = 0;
      for (let g = 0; g < MAX_GRAINS; g += 1) {
        if (!this.grainActive[g]) continue;

        const age = this.grainAge[g];
        const grainLength = this.grainLen[g];
        // Hann window, the source's `envbufnum: -1`.
        const window = 0.5 * (1 - Math.cos((TWO_PI * age) / grainLength));
        wet += this.#readCubic(this.grainPos[g]) * window;

        let pos = this.grainPos[g] + this.grainInc[g];
        if (pos >= len) pos -= len;
        this.grainPos[g] = pos;

        const nextAge = age + 1;
        if (nextAge >= grainLength) this.grainActive[g] = 0;
        else this.grainAge[g] = nextAge;
      }

      this.dryGain += this.smoothing * (targetDry - this.dryGain);
      this.wetGain += this.smoothing * (targetWet - this.wetGain);

      out[i] = softClip(dry * this.dryGain + wet * this.wetGain);
    }

    return true;
  }
}

registerProcessor('granulator-processor', GranulatorProcessor);
