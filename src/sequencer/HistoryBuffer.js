import { permute, permutationIndex } from './permute.js';

/**
 * The shift register at the heart of every generator in this instrument.
 *
 * All four generators in the original (trigger, note, velocity, modulation) use
 * the identical mechanism: a 32-slot array that is rotated left by one on every
 * step, has a fresh value written at a fixed index, and is then *read one slot
 * behind the write head*. That off-by-one is not a bug -- it means the value
 * consumed on a step was generated on the previous step, and the resulting
 * one-step latency is part of the instrument's feel. See
 * `TriggerWithGlide.scd:305-309` (trigger) and `:398-400` (notes).
 *
 * Because the array is rotated physically, its layout encodes chronology:
 * writeIndex holds the newest value, writeIndex-1 the one before, and so on
 * down through 0 and then wrapping to size-1. Loop capture takes `slice(0, n)`
 * off that layout, so it grabs a window of *older* history rather than the most
 * recent values -- again faithful to `TriggerWithGlide.scd:75`.
 */
export class HistoryBuffer {
  /**
   * @param {object} opts
   * @param {number} opts.size        slots in the register (32 in the original)
   * @param {number} opts.writeIndex  where fresh values land (15 for triggers, 31 otherwise)
   * @param {Function} opts.fill      () => initial value for each slot
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
   * Re-snapshot the loop from live history.
   *
   * Called whenever loop length, permutation index, or the loop toggle changes
   * (`TriggerWithGlide.scd:72-93`). Re-capturing on every change rather than
   * freezing once is what keeps loop mode feeling alive: the loop is always
   * built out of material the generator has recently produced.
   *
   * `permNormalized` is a 0..1 knob position, scaled to a permutation index
   * against the loop's own length -- see permutationIndex().
   *
   * `loopStepCount` is deliberately left untouched here -- see advanceLoop().
   * The loop's *content* already comes back identical on its own whenever you
   * return to a (length, permutation) pair you've used before, since it's a
   * pure function of the frozen history underneath; the phase is the only
   * part that needs this care.
   */
  captureLoop(length, permNormalized = 0) {
    this.loopLength = Math.max(1, Math.min(this.size, Math.floor(length)));
    this.loop = permute(
      this.data.slice(0, this.loopLength),
      permutationIndex(permNormalized, this.loopLength),
    );
    // Source reads `loopLength - 2` clipped into range; for length 1 that
    // clamps to 0, which correctly yields a one-value repeat.
    this.loopReadIndex = Math.max(0, Math.min(this.loopLength - 1, this.loopLength - 2));
  }

  /**
   * Advance the loop by one step.
   *
   * Counts absolute steps rather than storing a phase already folded into the
   * current length. Folding early is lossy: once the count has been reduced
   * mod a shorter length, the higher-order information needed to resume a
   * longer length correctly is gone, so returning to a length you'd visited
   * before would land on a different point in its cycle than if you'd never
   * left. Folding only at read time (see loopCurrent/loopPrevious) means every
   * length has its own always-correct phase, recoverable from the one shared
   * count no matter what other lengths were visited in between -- as if each
   * length's cycle had simply kept running in the background the whole time.
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
   * Glide origin while looping. The source indexes `loopLength - 3` unclipped
   * (`TriggerWithGlide.scd:388`), which goes negative for loops shorter than 3
   * and hands SuperCollider a nil -- an error the original only avoids because
   * zero glide short-circuits before the read. Clamped here so short loops
   * glide to themselves instead of breaking.
   */
  get loopPrevious() {
    const phase = this.loopStepCount % this.loopLength;
    const baseIndex = Math.max(0, Math.min(this.loopLength - 1, this.loopLength - 3));
    return this.loop[(baseIndex + phase) % this.loopLength];
  }
}
