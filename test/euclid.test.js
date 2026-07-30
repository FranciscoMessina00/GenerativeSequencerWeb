import test from 'node:test';
import assert from 'node:assert/strict';
import { euclid, rotateRight } from '../src/sequencer/euclid.js';

const density = (p) => p.reduce((a, b) => a + b, 0);

test('rotateRight shifts right and wraps', () => {
  assert.deepEqual(rotateRight([1, 0, 0, 0], 1), [0, 1, 0, 0]);
  assert.deepEqual(rotateRight([1, 0, 0, 0], 3), [0, 0, 0, 1]);
  assert.deepEqual(rotateRight([1, 2, 3, 4], 4), [1, 2, 3, 4]);
});

test('pulse count equals requested pulses', () => {
  for (let steps = 1; steps <= 32; steps += 1) {
    for (let pulses = 0; pulses <= steps; pulses += 1) {
      const p = euclid(steps, pulses, 0);
      assert.equal(p.length, steps, `length for ${steps}/${pulses}`);
      assert.equal(density(p), pulses, `density for ${steps}/${pulses}`);
    }
  }
});

test('degenerate cases', () => {
  assert.deepEqual(euclid(4, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(euclid(4, 4, 0), [1, 1, 1, 1]);
  // pulses > steps saturates rather than throwing
  assert.deepEqual(euclid(4, 9, 0), [1, 1, 1, 1]);
  assert.deepEqual(euclid(1, 1, 0), [1]);
});

test('the source +1 rotation offset puts a pulse on the downbeat', () => {
  // The raw accumulator emits its pulse on the LAST step; the built-in +1
  // rotation moves it to the first. Losing this offset would shift every
  // pattern in the instrument by one 16th.
  assert.equal(euclid(4, 1, 0)[0], 1);
  assert.equal(euclid(8, 1, 0)[0], 1);
  assert.equal(euclid(16, 1, 0)[0], 1);
});

test('rotation preserves density and cycles back', () => {
  const base = euclid(16, 5, 0);
  for (let r = 1; r < 16; r += 1) {
    assert.equal(density(euclid(16, 5, r)), 5, `density at rotation ${r}`);
  }
  // Rotating by a full cycle returns to the starting pattern.
  assert.deepEqual(euclid(16, 5, 16), base);
});

test('known patterns', () => {
  // 5 in 16, the paper's worked example: inter-onset gaps of 4,3,3,3,3.
  assert.deepEqual(
    euclid(16, 5, 0),
    [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
  );
  // Even division lands on a plain subdivision.
  assert.deepEqual(euclid(8, 4, 0), [1, 0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual(euclid(8, 2, 0), [1, 0, 0, 0, 1, 0, 0, 0]);
});

test('onsets are spread as evenly as the step count allows', () => {
  // The defining property of a Euclidean rhythm: inter-onset gaps take at most
  // two distinct values, and those differ by exactly one step.
  for (const [steps, pulses] of [[16, 5], [16, 7], [13, 5], [32, 12], [9, 4]]) {
    const p = euclid(steps, pulses, 0);
    const onsets = p.reduce((acc, v, i) => (v ? [...acc, i] : acc), []);
    const gaps = onsets.map((o, i) =>
      i === 0 ? o + steps - onsets[onsets.length - 1] : o - onsets[i - 1],
    );
    const distinct = [...new Set(gaps)].sort((a, b) => a - b);
    assert.ok(distinct.length <= 2, `${steps}/${pulses} gaps: ${distinct}`);
    if (distinct.length === 2) {
      assert.equal(distinct[1] - distinct[0], 1, `${steps}/${pulses} gaps: ${distinct}`);
    }
  }
});

test('the accumulator diverges from Bjorklund, as the source does', () => {
  // Canonical Bjorklund E(5,8) is [1,0,1,1,0,1,1,0] -- two adjacent pairs.
  // The source's bucket accumulator yields a different, more syncopated
  // rotation of five pulses. Both are valid "5 as evenly as possible over 8",
  // but they are audibly different rhythms, so this pins the ported behaviour
  // against someone later "correcting" euclid.js into a real Bjorklund.
  assert.deepEqual(euclid(8, 5, 0), [1, 0, 1, 0, 1, 1, 0, 1]);
  assert.notDeepEqual(euclid(8, 5, 0), [1, 0, 1, 1, 0, 1, 1, 0]);
});
