import { permute, permutationIndex } from './permute.js';

/**
 * The shift register every generator is built on: a 32-slot array rotated left by
 * one each step, with a fresh value written at a fixed index and then *read one
 * slot behind the write head*. That off-by-one is deliberate -- a step consumes
 * the value generated on the step before, and that latency is part of the feel.
 *
 * Rotating physically means the layout encodes chronology: writeIndex holds the
 * newest value, writeIndex-1 the one before, wrapping down through 0. Loop capture
 * slices off the front, so it deliberately grabs *older* history.
 */
export class HistoryBuffer {
  /**
   * @param {object} opts
   * @param {number} [opts.size]      slots in the register
   * @param {number} opts.writeIndex  where fresh values land (15 for triggers, 31 otherwise)
   * @param {() => any} opts.fill     initial value for each slot
   */
  constructor({ size = 32, writeIndex, fill }) {
    this.size = size;
    this.writeIndex = writeIndex;
    this.data = Array.from({ length: size }, fill);

    this.loop = this.data.slice(0, 1);
    this.loopLength = 1;
    this.loopReadIndex = 0;
    // Total steps the loop has ever advanced -- absolute, never reset and
    // never truncated to the current length. See captureLoop() for why.
    this.loopStepCount = 0;
  }

  /** Rotate left by one, then write `value` at the write head. */
  advance(value) {
    const first = this.data[0];
    for (let i = 0; i < this.size - 1; i += 1) {
      this.data[i] = this.data[i + 1];
    }
    this.data[this.size - 1] = first;
    this.data[this.writeIndex] = value;
  }

  /** The value this step should consume: one slot behind the write head. */
  get current() {
    return this.data[this.writeIndex - 1];
  }

  /** The value consumed on the previous step -- the glide origin. */
  get previous() {
    return this.data[this.writeIndex - 2];
  }

  /**
   * Re-snapshot the loop from live history, on every change to length,
   * permutation, or the toggle. Re-capturing rather than freezing once is what
   * keeps loop mode alive: the loop is always built from recent material.
   *
   * `permNormalized` is a 0..1 knob position -- see permutationIndex().
   * `loopStepCount` is deliberately left untouched; see advanceLoop().
   */
  captureLoop(length, permNormalized = 0) {
    this.loopLength = Math.max(1, Math.min(this.size, Math.floor(length)));
    this.loop = permute(
      this.data.slice(0, this.loopLength),
      permutationIndex(permNormalized, this.loopLength),
    );
    // Clamped, so length 1 lands on 0 and yields a one-value repeat.
    this.loopReadIndex = Math.max(0, Math.min(this.loopLength - 1, this.loopLength - 2));
  }

  /**
   * Advance the loop by one step, counting absolute steps rather than a phase
   * folded into the current length. Folding early is lossy: reduced mod a shorter
   * length, the information needed to resume a longer one is gone. Folding at read
   * time instead gives every length its own correct phase from one shared count,
   * as if each length's cycle had kept running in the background all along.
   */
  advanceLoop() {
    if (this.loopLength <= 1) return;
    this.loopStepCount += 1;
  }

  get loopCurrent() {
    const phase = this.loopStepCount % this.loopLength;
    return this.loop[(this.loopReadIndex + phase) % this.loopLength];
  }

  /**
   * The next `count` loop values, current one first (offset 0 is loopCurrent
   * itself) -- a whole window projected at once from today's frozen capture,
   * rather than reading one step at a time. Wraps circularly through `loop`
   * exactly the way loopCurrent already does, just repeated: a loop shorter
   * than `count` simply repeats from its own start as many times as it takes
   * to fill the window.
   *
   * Kept separate from loopCurrent (rather than the reverse) so the per-step
   * hot path never allocates an array just to read one value.
   */
  loopWindow(count) {
    const out = new Array(count);
    for (let k = 0; k < count; k += 1) {
      const phase = (this.loopStepCount + k) % this.loopLength;
      out[k] = this.loop[(this.loopReadIndex + phase) % this.loopLength];
    }
    return out;
  }

  /**
   * Glide origin while looping. The natural index here is `loopLength - 3`, which
   * goes negative for loops shorter than 3 -- clamped, so short loops glide to
   * themselves rather than reading off the end.
   */
  get loopPrevious() {
    const phase = this.loopStepCount % this.loopLength;
    const baseIndex = Math.max(0, Math.min(this.loopLength - 1, this.loopLength - 3));
    return this.loop[(baseIndex + phase) % this.loopLength];
  }
}
