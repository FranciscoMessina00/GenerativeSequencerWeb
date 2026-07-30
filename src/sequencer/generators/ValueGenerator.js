import { HistoryBuffer } from '../HistoryBuffer.js';
import { sampleDistribution } from './distributions.js';

/**
 * One continuous-valued generator: note, velocity, or modulation.
 *
 * The original implements these three as three near-identical `Pdefn` blocks
 * (`TriggerWithGlide.scd:355-465`). They are collapsed here into one class
 * parameterised by a distribution descriptor, so the shift-register and looping
 * mechanics exist exactly once.
 *
 * Each step produces both the current value and the previous one, because glide
 * ramps from the previous value to the current across the step.
 */
export class ValueGenerator {
  /**
   * @param {object} distribution  one of the descriptors in distributions.js
   * @param {Rng} rng
   * @param {number} size          history depth (32, as in the original)
   */
  constructor(distribution, rng, size = 32) {
    this.distribution = distribution;
    this.rng = rng;
    this.history = new HistoryBuffer({
      size,
      writeIndex: size - 1, // notes/vel/mod write at 31 and read at 30
      fill: () => distribution.initial(rng),
    });
    this.loopEnabled = false;
    this.history.captureLoop(1, 0);
  }

  /**
   * Re-snapshot the loop window. Call on any change to loop length, permutation,
   * or the enable toggle -- see HistoryBuffer.captureLoop for why.
   */
  recaptureLoop(length, permIndex = 0) {
    this.history.captureLoop(length, permIndex);
  }

  setLoopEnabled(enabled, length, permIndex = 0) {
    this.loopEnabled = Boolean(enabled);
    this.recaptureLoop(length, permIndex);
  }

  /**
   * Advance one step.
   * @param {object} params { bias, spread, ...post-processing params }
   * @returns {{ value: number, previous: number, raw: number }}
   */
  step(params) {
    const { post } = this.distribution;

    if (this.loopEnabled) {
      this.history.advanceLoop();
      const raw = this.history.loopCurrent;
      const rawPrev = this.history.loopPrevious;
      return {
        raw,
        value: post(raw, params),
        previous: post(rawPrev, params),
      };
    }

    const fresh = sampleDistribution(
      this.distribution,
      this.rng,
      params.bias,
      params.spread,
    );
    this.history.advance(fresh);

    const raw = this.history.current;
    const rawPrev = this.history.previous;
    return {
      raw,
      value: post(raw, params),
      previous: post(rawPrev, params),
    };
  }
}
