/**
 * Real-time granulator. The string signal streams into a 3-second circular buffer;
 * grains fire from a Poisson process and read a fixed distance behind the write
 * head, so this is a live effect on just-produced material, not a sampler.
 *
 * Dry/wet lives inside the processor rather than as a parallel Web Audio path, so
 * the dry signal stays sample-aligned with the wet one -- splitting the graph
 * would need a compensating delay on the dry side to avoid comb filtering.
 *
 * Self-contained: AudioWorkletGlobalScope has no module loader.
 */

const BUFFER_SECONDS = 3;
const MAX_GRAINS = 64;
const GRAIN_DENSITY = 16; // grains per second
const READ_DELAY = 0.2; // seconds behind the write head
const MAX_GRAIN_DUR = 0.3;
const TWO_PI = Math.PI * 2;

/** Below this level the limiter is bypassed entirely. */
const KNEE = 0.8;

/**
 * Soft-knee limiter: identity below KNEE, asymptotic to +/-1 above it. The only
 * saturation stage in the chain, placed here as the last DSP node before the
 * master fader.
 *
 * It earns its place: at grain pitch 1 every grain reads the same delayed signal
 * at the same speed, so grains sum *coherently* and ~3 overlapping ones push the
 * wet path to roughly 1.7x dry. That gain is wanted, so the peak is caught here
 * rather than left to hard-clip in the output device.
 *
 * The knee is what makes it safe on the dry path: a plain cubic soft clip would
 * shave every sample, so fully-dry would stop being a true bypass. This form is
 * exactly the identity below KNEE and C1-continuous across it.
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
      // Equal-power crossfade position: -1 fully dry, +1 fully wet.
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

  /** Cubic (Catmull-Rom) interpolated read, so pitch-shifted grains stay clean. */
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
    // At 16 grains/s and up to 0.3 s each, ~5 overlap on average, so the 64-grain
    // ceiling is only reached pathologically -- drop the grain rather than steal.
    if (slot === -1) return;

    // Capping duration at READ_DELAY / rate is what keeps a fast grain from
    // overtaking the write head: at rate r it consumes r seconds of buffer per
    // second of output, so starting 0.2 s back it reaches the head as it ends.
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

    // Equal-power crossfade: -1 all dry, +1 all wet, and both legs at 1/sqrt(2)
    // in the middle so perceived loudness stays constant across the sweep.
    const angle = ((pan + 1) * Math.PI) / 4;
    const targetDry = Math.cos(angle);
    const targetWet = Math.sin(angle);

    // Probability of a grain onset per sample -- a Poisson process at GRAIN_DENSITY.
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
        // Hann window, so grains fade in and out instead of clicking.
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

// See the note in modal-processor.js: module scope, no imports.
export {};
