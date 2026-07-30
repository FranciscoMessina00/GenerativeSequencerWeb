import test from 'node:test';
import assert from 'node:assert/strict';
import { permutationIndex, permute } from '../src/sequencer/permute.js';

const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1));

test('index 0 is the identity', () => {
  const a = [1, 2, 3, 4, 5];
  assert.deepEqual(permute(a, 0), a);
});

test('does not mutate its input', () => {
  const a = [1, 2, 3, 4];
  permute(a, 7);
  assert.deepEqual(a, [1, 2, 3, 4]);
});

test('every index yields a true permutation', () => {
  const a = [10, 20, 30, 40, 50];
  const sorted = [...a].sort((x, y) => x - y);
  for (let n = 0; n < factorial(a.length); n += 1) {
    const p = permute(a, n);
    assert.equal(p.length, a.length);
    assert.deepEqual([...p].sort((x, y) => x - y), sorted, `index ${n}`);
  }
});

test('all permutations of a set are reachable and distinct', () => {
  const a = [1, 2, 3, 4];
  const seen = new Set();
  for (let n = 0; n < factorial(4); n += 1) {
    seen.add(permute(a, n).join(','));
  }
  assert.equal(seen.size, factorial(4));
});

test('mapping is stable across calls', () => {
  const a = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(permute(a, 13), permute(a, 13));
});

test('the permutation knob reorders without changing density', () => {
  // What the "Rhythm permutation" knob must guarantee: the loop is shuffled but
  // its pulse count -- and therefore its density -- is untouched.
  const rhythm = [1, 0, 1, 1, 0, 0, 1];
  const density = rhythm.reduce((a, b) => a + b, 0);
  for (let n = 0; n <= 20; n += 1) {
    assert.equal(permute(rhythm, n).reduce((a, b) => a + b, 0), density);
  }
});

test('handles degenerate sizes', () => {
  assert.deepEqual(permute([], 5), []);
  assert.deepEqual(permute([9], 5), [9]);
});

test('permutationIndex spans the whole space for the loop length', () => {
  // A 7-slot loop has 5040 permutations; the knob must reach the last one.
  assert.equal(permutationIndex(0, 7), 0);
  assert.equal(permutationIndex(1, 7), 5039);
  assert.equal(permutationIndex(0.5, 7), 2520);
  // Clamped at 12! as the source does, since 13! overflows a 32-bit int.
  assert.equal(permutationIndex(1, 32), 479001599);
  assert.equal(permutationIndex(1, 12), 479001599);
});

test('permutationIndex never wraps back to the identity at full travel', () => {
  // floor(1.0 * n!) would land on n!, which factorial-base decoding maps back to
  // the identity -- making the top of the knob silently inert.
  for (let len = 2; len <= 12; len += 1) {
    const a = Array.from({ length: len }, (_, i) => i);
    assert.notDeepEqual(permute(a, permutationIndex(1, len)), a, `length ${len}`);
  }
});

test('the knob produces a range of distinct orderings', () => {
  const a = [0, 1, 2, 3, 4, 5, 6];
  const seen = new Set();
  for (let k = 0; k <= 20; k += 1) {
    seen.add(permute(a, permutationIndex(k / 20, a.length)).join(','));
  }
  // The raw 0..20 index the Processing GUI sent would yield only a handful here.
  assert.ok(seen.size >= 18, `only ${seen.size} distinct orderings from 21 knob positions`);
});
