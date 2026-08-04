import test from 'node:test';
import assert from 'node:assert/strict';
import { modSweepRange } from '../src/modulation/modRange.js';

const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

test('no amount, no range', () => {
  assert.equal(modSweepRange('decay', 1, 0), null);
  assert.equal(modSweepRange('decay', 1, -0.5), null);
});

test('a non-finite base is nothing to draw', () => {
  assert.equal(modSweepRange('decay', NaN, 1), null);
  assert.equal(modSweepRange('decay', undefined, 1), null);
});

test('an unknown key has no spec to measure against', () => {
  assert.equal(modSweepRange('notAParam', 1, 1), null);
});

test('full amount from the exact centre spans the whole schema range', () => {
  // decay: min 0.25, max 3 -- 1.625 is the midpoint.
  const range = modSweepRange('decay', 1.625, 1);
  assert.ok(close(range.lo, 0.25));
  assert.ok(close(range.hi, 3));
  assert.equal(range.base, 1.625);
});

test('half amount halves the excursion around the base', () => {
  // decay: span 2.75, half amount -> ±0.6875 either side of the base.
  const range = modSweepRange('decay', 1.625, 0.5);
  assert.ok(close(range.lo, 1.625 - 0.6875));
  assert.ok(close(range.hi, 1.625 + 0.6875));
});

test('an excursion past an edge clamps to the schema bound, asymmetrically', () => {
  // decay: base 0.3 sits near min (0.25); the full-amount excursion (±1.375)
  // would push lo well below min but hi stays comfortably inside max.
  const range = modSweepRange('decay', 0.3, 1);
  assert.ok(close(range.lo, 0.25), `lo clamped to min, got ${range.lo}`);
  assert.ok(close(range.hi, 0.3 + 1.375), `hi unclamped, got ${range.hi}`);
});
