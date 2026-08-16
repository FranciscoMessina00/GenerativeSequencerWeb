import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXP_DRAG_K,
  FINE_DIVISOR,
  FULL_RANGE_PX,
  dragDeltaValue,
  expDragDeltaValue,
} from '../src/ui/dragGesture.js';
import { paramSpec } from '../src/core/paramSchema.js';

/**
 * The warped drag the envelope times use.
 *
 * Pure maths, so it belongs here rather than in a browser check -- what the browser
 * has to say about it is only that a pointer reaches it, which DragNumber's existing
 * coverage already establishes.
 *
 * The properties worth pinning are the ones a "feels better" change can quietly
 * break: that a full sweep still covers exactly the range, that the mapping is
 * monotonic and lands on the endpoints exactly, and that the resolution really is
 * finer at the bottom rather than merely different.
 */

/** envDecay's range: the widest of the three, and the one this exists for. */
const MIN = 1;
const MAX = 4000;

const at = (startValue, dy, shiftKey = false) => expDragDeltaValue(startValue, dy, MIN, MAX, shiftKey);

test('a full sweep from the bottom reaches exactly the top, and back again', () => {
  // The gesture's shape is unchanged -- 180 px is still one whole range, whichever
  // curve it is read through. Only where the resolution sits moves.
  assert.equal(at(MIN, FULL_RANGE_PX), MAX);
  assert.equal(at(MAX, -FULL_RANGE_PX), MIN);
});

test('the endpoints are exact, not merely close', () => {
  // A max that came out at 3999.7 would quantize to 4000 and look fine, then read
  // back as a value the inverse could not reproduce.
  assert.equal(at(MIN, 0), MIN);
  assert.equal(at(MAX, 0), MAX);
});

test('it clamps at both ends instead of running past them', () => {
  assert.equal(at(MAX, FULL_RANGE_PX * 5), MAX);
  assert.equal(at(MIN, -FULL_RANGE_PX * 5), MIN);
});

test('dragging back down from a clamped top responds immediately', () => {
  // Where the linear drag differs: it lets the value run past max for quantize to
  // catch, so retracing does nothing until it has undone the whole overshoot.
  const overshot = at(MAX, FULL_RANGE_PX * 3);
  assert.ok(at(overshot, -10) < MAX, 'a small drag back must move it');
});

test('the mapping is monotonic across the whole sweep', () => {
  let previous = -Infinity;
  for (let dy = 0; dy <= FULL_RANGE_PX; dy += 1) {
    const value = at(MIN, dy);
    assert.ok(value >= previous, `fell back at dy=${dy}: ${value} after ${previous}`);
    assert.ok(value >= MIN && value <= MAX, `left the range at dy=${dy}: ${value}`);
    previous = value;
  }
});

test('half the travel lands well inside the low end of the range', () => {
  // The whole point: a linear drag would be at the midpoint, ~2000 ms. This is the
  // number the curve's shape is chosen by, so it is worth stating rather than
  // deriving -- see EXP_DRAG_K's comment.
  const half = at(MIN, FULL_RANGE_PX / 2);
  const linearHalf = dragDeltaValue(MIN, FULL_RANGE_PX / 2, MAX - MIN, false);
  assert.ok(half < linearHalf * 0.4, `halfway sat at ${half}, against ${linearHalf} linear`);
  assert.ok(half > MIN, 'and it is not pinned to the bottom either');
});

test('the bottom of the range reads several times finer than a linear drag', () => {
  const onePixel = at(MIN, 1) - MIN;
  const linearPixel = (MAX - MIN) / FULL_RANGE_PX;
  assert.ok(onePixel < linearPixel / 4, `${onePixel} ms/px against ${linearPixel} linear`);
});

test('...and the top reads coarser, which is the trade being made', () => {
  const topPixel = MAX - at(MAX, -1);
  const linearPixel = (MAX - MIN) / FULL_RANGE_PX;
  assert.ok(topPixel > linearPixel, `${topPixel} ms/px at the top against ${linearPixel} linear`);
});

test('shift makes the same travel finer, here as everywhere else', () => {
  const coarse = at(500, 20) - 500;
  const fine = at(500, 20, true) - 500;
  assert.ok(fine > 0 && fine < coarse, `${fine} was not finer than ${coarse}`);
  // Not exactly 1/8 of the coarse *value* -- the divisor applies to the travel, and
  // the curve is not linear in it -- but it must be in that neighbourhood.
  assert.ok(fine < coarse / (FINE_DIVISOR / 2), 'shift barely changed anything');
});

test('a degenerate range gives the value back rather than dividing by zero', () => {
  assert.equal(expDragDeltaValue(5, 40, 5, 5, false), 5);
  assert.equal(expDragDeltaValue(5, 40, 10, 2, false), 5);
});

test('every param declaring a curve declares one this module implements', () => {
  // The flag is read in exactly one place (DragNumber), and an unknown value there
  // silently falls back to the linear drag rather than failing.
  const curved = ['envAttack', 'envHold', 'envDecay'];
  for (const key of curved) {
    assert.equal(paramSpec(key).curve, 'exp', `${key} lost its curve`);
  }
  assert.ok(EXP_DRAG_K > 0, 'the curve must actually bend');
});

test('each curved envelope param still sweeps its own declared range', () => {
  for (const key of ['envAttack', 'envHold', 'envDecay']) {
    const spec = paramSpec(key);
    assert.equal(expDragDeltaValue(spec.min, FULL_RANGE_PX, spec.min, spec.max, false), spec.max, key);
    assert.equal(expDragDeltaValue(spec.max, -FULL_RANGE_PX, spec.min, spec.max, false), spec.min, key);
  }
});
