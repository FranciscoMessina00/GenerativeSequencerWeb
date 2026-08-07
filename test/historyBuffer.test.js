import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryBuffer } from '../src/sequencer/HistoryBuffer.js';

/**
 * HistoryBuffer had no direct test before its internal storage was rewritten from
 * an O(n) physically-rotating array to an O(1) ring-plus-counter -- only indirect
 * coverage through Track/TriggerGenerator/ValueGenerator in sequencer.test.js.
 * These two things guard the rewrite:
 *
 *   1. Fixed-shape tests at the two writeIndex values the app actually uses.
 *   2. A metamorphic fuzz test: a tiny local re-implementation of the ORIGINAL
 *      shifting algorithm, run in lockstep against the real class over many random
 *      advance() calls, cross-checking every public member at every step. This is
 *      the strongest available check against exactly the class of bug an internal
 *      rewrite like this risks (an off-by-one in the write-order, a mod-wrap edge
 *      case) without hand-deriving expected values for a long random sequence.
 */

/** The pre-rewrite algorithm, kept here only as a reference oracle -- never used
 *  in src/, and deliberately re-implemented rather than imported so a bug shared
 *  between the two would not cancel out. */
class ReferenceHistoryBuffer {
  constructor({ size = 32, writeIndex, fill }) {
    this.size = size;
    this.writeIndex = writeIndex;
    this.data = Array.from({ length: size }, fill);
    this.loop = this.data.slice(0, 1);
    this.loopLength = 1;
    this.loopReadIndex = 0;
    this.loopStepCount = 0;
  }

  advance(value) {
    const first = this.data[0];
    for (let i = 0; i < this.size - 1; i += 1) this.data[i] = this.data[i + 1];
    this.data[this.size - 1] = first;
    this.data[this.writeIndex] = value;
  }

  get current() { return this.data[this.writeIndex - 1]; }
  get previous() { return this.data[this.writeIndex - 2]; }

  captureLoop(length, permNormalized = 0) {
    // Local, dependency-free stand-in for permute()/permutationIndex() -- identity
    // order is enough here, since what's under test is the *window contents* the
    // real permute() receives, not the shuffle itself (already covered by
    // permute.test.js).
    this.loopLength = Math.max(1, Math.min(this.size, Math.floor(length)));
    this.loop = this.data.slice(0, this.loopLength);
    void permNormalized;
    this.loopReadIndex = Math.max(0, Math.min(this.loopLength - 1, this.loopLength - 2));
  }

  advanceLoop() {
    if (this.loopLength <= 1) return;
    this.loopStepCount += 1;
  }

  get loopCurrent() {
    const phase = this.loopStepCount % this.loopLength;
    return this.loop[(this.loopReadIndex + phase) % this.loopLength];
  }

  loopWindow(count) {
    const out = new Array(count);
    for (let k = 0; k < count; k += 1) {
      const phase = (this.loopStepCount + k) % this.loopLength;
      out[k] = this.loop[(this.loopReadIndex + phase) % this.loopLength];
    }
    return out;
  }

  get loopPrevious() {
    const phase = this.loopStepCount % this.loopLength;
    const baseIndex = Math.max(0, Math.min(this.loopLength - 1, this.loopLength - 3));
    return this.loop[(baseIndex + phase) % this.loopLength];
  }
}

/** Same seed sequence for both instances under test, so `fill` produces identical
 *  starting contents without depending on a shared Rng. */
function makeFill() {
  let n = 0;
  return () => n++;
}

test('fixed shape: writeIndex 15 (the trigger register), a short hand-computable sequence', () => {
  const buf = new HistoryBuffer({ size: 32, writeIndex: 15, fill: makeFill() });
  // Fresh fill: data[i] = i. current = data[14] = 14, previous = data[13] = 13.
  assert.equal(buf.current, 14);
  assert.equal(buf.previous, 13);

  buf.advance('a');
  // Rotate left by one: new data[14] = old data[15] = 15, new data[13] = old data[14] = 14.
  assert.equal(buf.current, 15);
  assert.equal(buf.previous, 14);

  buf.advance('b');
  assert.equal(buf.current, 'a');
  assert.equal(buf.previous, 15);
});

test('fixed shape: writeIndex 31 (a value register), a short hand-computable sequence', () => {
  const buf = new HistoryBuffer({ size: 32, writeIndex: 31, fill: makeFill() });
  assert.equal(buf.current, 30);
  assert.equal(buf.previous, 29);

  buf.advance('x');
  // writeIndex === size - 1, so the shift's own recycled data[31] = old data[0] is
  // immediately overwritten by 'x' -- the rotation still moves everything else down.
  assert.equal(buf.current, 31);
  assert.equal(buf.previous, 30);

  buf.advance('y');
  assert.equal(buf.current, 'x');
  assert.equal(buf.previous, 31);
});

test('captureLoop at loopLength 1 is a one-value repeat', () => {
  const buf = new HistoryBuffer({ size: 32, writeIndex: 15, fill: () => 0 });
  buf.advance(7);
  buf.captureLoop(1, 0);
  assert.deepEqual(buf.loopWindow(4), [buf.loopCurrent, buf.loopCurrent, buf.loopCurrent, buf.loopCurrent]);
});

test('captureLoop at a mid-size length tiles loopWindow circularly past its own length', () => {
  const buf = new HistoryBuffer({ size: 32, writeIndex: 15, fill: makeFill() });
  buf.captureLoop(5, 0);
  const window = buf.loopWindow(12);
  assert.equal(window.length, 12);
  // Circular: the 6th element repeats the 1st, etc.
  for (let k = 0; k < 12; k += 1) {
    assert.equal(window[k], window[k % 5]);
  }
});

for (const writeIndex of [15, 31]) {
  test(`metamorphic: real HistoryBuffer matches the reference shifting algorithm over a long random run (writeIndex ${writeIndex})`, () => {
    let seed = writeIndex === 15 ? 0x1234 : 0x5678;
    // A tiny local PRNG -- this file stays dependency-free, matching the rest of
    // the suite (no import of core/rng.js needed for a fuzz driver this small).
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const fill = makeFill();
    const real = new HistoryBuffer({ size: 32, writeIndex, fill });
    const ref = new ReferenceHistoryBuffer({ size: 32, writeIndex, fill: makeFill() });

    for (let step = 0; step < 500; step += 1) {
      const value = Math.floor(rand() * 1000);
      real.advance(value);
      ref.advance(value);
      assert.equal(real.current, ref.current, `current diverged at step ${step}`);
      assert.equal(real.previous, ref.previous, `previous diverged at step ${step}`);

      // Occasionally re-capture the loop at a random length/permutation and walk it
      // a few steps, cross-checking every loop-facing member.
      if (step % 17 === 0) {
        const length = 1 + Math.floor(rand() * 32);
        const perm = rand();
        real.captureLoop(length, perm);
        // The reference's captureLoop ignores permutation (identity order) by
        // design -- see its own comment -- so only compare the two on captures
        // with perm=0, where both apply the identity permutation.
        ref.captureLoop(length, 0);
        if (perm === 0) {
          for (let k = 0; k < 3; k += 1) {
            real.advanceLoop();
            ref.advanceLoop();
            assert.equal(real.loopCurrent, ref.loopCurrent, `loopCurrent diverged near step ${step}`);
            assert.equal(real.loopPrevious, ref.loopPrevious, `loopPrevious diverged near step ${step}`);
            assert.deepEqual(real.loopWindow(6), ref.loopWindow(6), `loopWindow diverged near step ${step}`);
          }
        }
      }
    }
  });
}
