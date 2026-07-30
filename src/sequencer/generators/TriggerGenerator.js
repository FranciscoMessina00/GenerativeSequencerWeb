import { HistoryBuffer } from '../HistoryBuffer.js';
import { euclid } from '../euclid.js';
import { applyLogic } from '../logic.js';

/**
 * The rhythm generator: a Euclidean pattern combined bit-wise with a stochastic
 * (or looped) bit stream through one of OR / AND / XOR / NAND.
 *
 * Ported from `TriggerWithGlide.scd:291-354`. The random register writes at
 * index 15 and reads at 14, so the bit combined with a step was flipped on the
 * step before -- see HistoryBuffer for why that off-by-one is preserved.
 *
 * Combining a deterministic pattern of one length with a loop of another is what
 * the paper means by "setting the random trigger loop length to 7 and combining
 * it with a 10-step Euclidean pattern produces a 70-step pattern": the two
 * cycles only realign at their least common multiple.
 */
export class TriggerGenerator {
  constructor(rng, size = 32) {
    this.rng = rng;
    this.pattern = euclid(1, 1, 0);
    this.patternIndex = 0;

    this.history = new HistoryBuffer({
      size,
      writeIndex: 15, // the source's `~randomSeq.put(15, ...)`
      fill: () => rng.coinBit(0.5),
    });
    this.loopEnabled = false;
    this.history.captureLoop(1, 0);
  }

  /**
   * Rebuild the Euclidean pattern in place, preserving the playhead.
   *
   * The original adds its live step counter to the rotation
   * (`TriggerWithGlide.scd:49`) purely to cancel the phase reset that replacing
   * a `Pdefn` causes. Here the playhead is an independent counter that survives
   * regeneration, so no compensation is needed -- adding one would double-shift
   * the pattern on every knob move.
   */
  setPattern(steps, pulses, rotation) {
    this.pattern = euclid(steps, pulses, rotation);
    if (this.pattern.length > 0) {
      this.patternIndex %= this.pattern.length;
    } else {
      this.patternIndex = 0;
    }
  }

  recaptureLoop(length, permIndex = 0) {
    this.history.captureLoop(length, permIndex);
  }

  setLoopEnabled(enabled, length, permIndex = 0) {
    this.loopEnabled = Boolean(enabled);
    this.recaptureLoop(length, permIndex);
  }

  /** Current Euclidean pattern, for the step-ring display. */
  getPattern() {
    return this.pattern;
  }

  get stepIndex() {
    return this.patternIndex;
  }

  /**
   * Advance one step.
   * @param {object} params { probability, logicOp }
   * @returns {{ triggered: boolean, euclidBit: number, randomBit: number, stepIndex: number }}
   */
  step(params) {
    const stepIndex = this.patternIndex;
    const euclidBit = this.pattern[stepIndex] ?? 0;

    let randomBit;
    if (this.loopEnabled) {
      this.history.advanceLoop();
      randomBit = this.history.loopCurrent;
    } else {
      this.history.advance(this.rng.coinBit(params.probability));
      randomBit = this.history.current;
    }

    const bit = applyLogic(params.logicOp, euclidBit, randomBit);
    this.patternIndex = (this.patternIndex + 1) % Math.max(1, this.pattern.length);

    return {
      triggered: bit === 1,
      euclidBit,
      randomBit,
      stepIndex,
    };
  }
}
