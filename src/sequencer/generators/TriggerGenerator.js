import { HistoryBuffer } from '../HistoryBuffer.js';
import { euclid } from '../euclid.js';
import { applyLogic } from '../logic.js';

/**
 * The rhythm generator: a Euclidean pattern combined bit-wise with a stochastic
 * (or looped) bit stream through one of OR / AND / XOR / NAND.
 *
 * The random register writes at index 15 and reads at 14, so the bit combined
 * with a step was flipped on the step before -- see HistoryBuffer.
 *
 * Combining a deterministic pattern of one length with a loop of another is what
 * makes long patterns cheap: a 7-step random loop against a 10-step Euclidean
 * pattern only realigns after 70 steps, their least common multiple.
 */
export class TriggerGenerator {
  constructor(rng, size = 32) {
    this.rng = rng;
    this.pattern = euclid(1, 1, 0);
    this.patternIndex = 0;

    this.history = new HistoryBuffer({
      size,
      writeIndex: 15,
      fill: () => rng.coinBit(0.5),
    });
    this.loopEnabled = false;
    this.history.captureLoop(1, 0);
  }

  /**
   * Rebuild the Euclidean pattern in place, preserving the playhead.
   *
   * The playhead is an independent counter that survives regeneration, so the
   * rotation is applied as given -- compensating for it here would double-shift
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
