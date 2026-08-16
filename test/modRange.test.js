import test from 'node:test';
import assert from 'node:assert/strict';
import { modSweepRange } from '../src/modulation/modRange.js';

const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

/** A representative mappable param: envDecay, min 1 and max 4000. */
const KEY = 'envDecay';
const MID = 2000.5;

test('no amount, no range', () => {
  assert.equal(modSweepRange(KEY, 1, 0), null);
  assert.equal(modSweepRange(KEY, 1, -0.5), null);
});

test('a non-finite base is nothing to draw', () => {
  assert.equal(modSweepRange(KEY, NaN, 1), null);
  assert.equal(modSweepRange(KEY, undefined, 1), null);
});

test('an unknown key has no spec to measure against', () => {
  assert.equal(modSweepRange('notAParam', 1, 1), null);
});

test('full amount from the exact centre spans the whole schema range', () => {
  const range = modSweepRange(KEY, MID, 1);
  assert.ok(close(range.lo, 1));
  assert.ok(close(range.hi, 4000));
  assert.equal(range.base, MID);
});

test('half amount halves the excursion around the base', () => {
  // Span 3999, half amount -> ±999.75 either side of the base.
  const range = modSweepRange(KEY, MID, 0.5);
  assert.ok(close(range.lo, MID - 999.75));
  assert.ok(close(range.hi, MID + 999.75));
});

test('an excursion past an edge clamps to the schema bound, asymmetrically', () => {
  // Base 100 sits near min (1); the full-amount excursion (±1999.5) would push lo
  // well below min but hi stays comfortably inside max.
  const range = modSweepRange(KEY, 100, 1);
  assert.ok(close(range.lo, 1), `lo clamped to min, got ${range.lo}`);
  assert.ok(close(range.hi, 100 + 1999.5), `hi unclamped, got ${range.hi}`);
});
