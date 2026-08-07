import { permute, permutationIndex } from './permute.js';

/**
 * The shift register every generator is built on: 32 slots of history, with a
 * fresh value written at a fixed index and then *read one slot behind the write
 * head*. That off-by-one is deliberate -- a step consumes the value generated on
 * the step before, and that latency is part of the feel.
 *
 * Storage is a static `ring` array plus one counter `t` that advances each step,
 * rather than physically rotating the array itself (an earlier version did, at
 * O(size) per step -- cheap at this size and step rate, but every other hot path in
 * this instrument is O(1), so it was worth removing). `t` is what "writeIndex holds
 * the newest value, writeIndex-1 the one before, wrapping down through 0" now means:
 * logical index `j`'s value always lives at ring slot `(j + t) mod size`. That single
 * identity replaces the old rotate-then-overwrite pair -- see #physical() -- and it
 * is exactly the same layout the rotating version produced, just computed instead of
 * moved. Loop capture slices off the front (logical indices `0..length-1`), so it
 * deliberately grabs *older* history, same as before.
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
    this.ring = Array.from({ length: size }, fill);
    // Steps advanced so far, mod size -- see #physical(). Starts at 0, which is what
    // makes the fresh `ring` read as logical index === physical index, i.e. identical
    // to the old pre-rotation array.
    this.t = 0;

    this.loop = this.ring.slice(0, 1);
    this.loopLength = 1;
    this.loopReadIndex = 0;
    // Total steps the loop has ever advanced -- absolute, never reset and
    // never truncated to the current length. See captureLoop() for why.
    this.loopStepCount = 0;
  }

  /**
   * The ring slot currently holding logical index `j` -- the value `advance()` would
   * have left at `data[j]` after however many calls have happened, back when this was
   * a physically-rotating array. Triple-mod'd so a negative `j` (never produced by
   * this file's own two writeIndex values, both >= 2, but cheap to guard) still lands
   * in range rather than returning `undefined`.
   */
  #physical(j) {
    return (((j % this.size) + this.t) % this.size + this.size) % this.size;
  }

  /** True mathematical modulo -- unlike `%`, never negative for a negative
   *  `n`. Needed for loop-phase reads once `loopStepCount` can go negative;
   *  see shiftLoopPlayhead(). */
  #mod(n, m) {
    return ((n % m) + m) % m;
  }

  /** Advance the register by one step, writing `value` at the write head. */
  advance(value) {
    // Incrementing before writing is what makes the write land where a rotate would
    // have moved writeIndex's *new* slot to -- reversing the order writes to
    // yesterday's slot instead and desyncs from the very first call.
    this.t = (this.t + 1) % this.size;
    this.ring[this.#physical(this.writeIndex)] = value;
  }

  /** The value this step should consume: one slot behind the write head. */
  get current() {
    return this.ring[this.#physical(this.writeIndex - 1)];
  }

  /** The value consumed on the previous step -- the glide origin. */
  get previous() {
    return this.ring[this.#physical(this.writeIndex - 2)];
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
    const window = Array.from(
      { length: this.loopLength },
      (_, p) => this.ring[this.#physical(p)],
    );
    this.loop = permute(window, permutationIndex(permNormalized, this.loopLength));
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

  /**
   * Translate the loop's phase by `delta` ticks -- a plain shift, not a
   * fold, so it stays exact for every possible length exactly like leaving
   * `loopStepCount` untouched would (see captureLoop()'s note on revisiting
   * lengths); `delta` can be negative, and so can the `loopStepCount` this
   * leaves behind -- loopCurrent/loopWindow/loopPrevious's modulo already
   * handles that.
   *
   * Used on a transport stop: rewinding the Euclidean cursor by N ticks
   * without shifting a loop's phase by the same N would jump its alignment
   * to the pattern by however long playback happened to run before that
   * particular stop -- see TriggerGenerator.resetPlayhead().
   */
  shiftLoopPlayhead(delta) {
    this.loopStepCount += delta;
  }

  get loopCurrent() {
    const phase = this.#mod(this.loopStepCount, this.loopLength);
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
      const phase = this.#mod(this.loopStepCount + k, this.loopLength);
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
    const phase = this.#mod(this.loopStepCount, this.loopLength);
    const baseIndex = Math.max(0, Math.min(this.loopLength - 1, this.loopLength - 3));
    return this.loop[(baseIndex + phase) % this.loopLength];
  }
}
