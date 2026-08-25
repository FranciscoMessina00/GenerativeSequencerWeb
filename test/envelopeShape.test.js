import test from 'node:test';
import assert from 'node:assert/strict';
import { ahdEnvelope } from '../src/audio/envelope.js';
import { DOT_INSET, MARGIN_TOP, envelopeShape } from '../src/ui/envelopeShape.js';

/**
 * The envelope display's geometry. What is worth testing here is not that a curve was
 * drawn -- that is a canvas's problem -- but that the step marker lands where the step
 * actually falls across it, since that alignment is the only thing on the panel
 * telling you whether the note releases before the boundary, on it, or after it.
 */

const BOX = { width: 200, height: 60 };
const STEP = 0.125;

const shapeOf = (over = {}, stepSeconds = STEP) => envelopeShape({
  env: ahdEnvelope({
    attackMs: 10, holdMs: 500, decayMs: 200, stepSeconds: STEP, exponential: false, ...over,
  }),
  stepSeconds,
  ...BOX,
});

test('the polyline spans the full width and stays inside the box', () => {
  const shape = shapeOf();
  assert.equal(shape.points[0].x, 0);
  assert.equal(shape.points.at(-1).x, BOX.width);
  for (const { x, y } of shape.points) {
    assert.ok(x >= 0 && x <= BOX.width, `x ${x}`);
    assert.ok(y >= 0 && y <= BOX.height, `y ${y}`);
  }
});

test('the curve starts at the floor and ends at the floor', () => {
  // A 10 ms attack means it starts from silence; the tail always reaches it again.
  const shape = shapeOf();
  const floor = shape.points[0].y;
  assert.equal(shape.points.at(-1).y, floor);
  assert.ok(Math.min(...shape.points.map((p) => p.y)) < floor, 'nothing rose at all');
});

test('the floor is the bottom of the box, with nothing left under it', () => {
  // Silence sits on the frame rather than hovering above it -- a gap there read as the
  // curve floating above its own baseline.
  const shape = shapeOf();
  assert.equal(shape.points[0].y, BOX.height);
  assert.equal(Math.max(...shape.points.map((p) => p.y)), BOX.height);
});

test('the curve stays out of the band the step caption lives in', () => {
  // The panel's own canvas is 68 px tall. A held note sits at full level for most of
  // its length, and before the top margin existed it drew straight through the
  // "Step Length" text -- illegible at exactly the settings worth reading.
  const shape = envelopeShape({
    env: ahdEnvelope({
      attackMs: 36, holdMs: 38, decayMs: 104, stepSeconds: STEP, exponential: true,
    }),
    stepSeconds: STEP,
    width: 280,
    height: 68,
  });
  const highest = Math.min(...shape.points.map((p) => p.y));
  assert.ok(highest >= MARGIN_TOP, `the peak reached y=${highest}, inside the caption's band`);
});

test('a short canvas gives up margin rather than the curve', () => {
  // A quarter of the box at most: on something much shorter than the panel there is
  // no room to reserve 16 px and still draw an envelope worth looking at.
  const shape = envelopeShape({
    env: ahdEnvelope({
      attackMs: 0, holdMs: 200, decayMs: 100, stepSeconds: STEP, exponential: false,
    }),
    stepSeconds: STEP,
    width: 200,
    height: 24,
  });
  const highest = Math.min(...shape.points.map((p) => p.y));
  const lowest = Math.max(...shape.points.map((p) => p.y));
  assert.ok(highest <= 24 * 0.25, `margin did not shrink: peak at ${highest}`);
  assert.ok(lowest - highest > 10, 'the curve was squashed to nothing');
});

test('a zero attack starts at full level rather than at silence', () => {
  const shape = shapeOf({ attackMs: 0 });
  const lowest = Math.min(...shape.points.map((p) => p.y));
  assert.equal(shape.points[0].y, lowest, 'the first sample is already at the top');
});

// ---------------------------------------------------------------------------
// The stage dots
// ---------------------------------------------------------------------------

test('both stage dots sit at the level the attack reached', () => {
  const shape = shapeOf({ attackMs: 10, holdMs: 40, decayMs: 100 });
  // Hold is flat, so the attack's end and the decay's start are the same height by
  // construction -- what separates them is only how far along they are.
  assert.equal(shape.attackEnd.y, shape.decayStart.y);
  // And that height is the top of the drawn curve.
  const highest = Math.min(...shape.points.map((p) => p.y));
  assert.ok(Math.abs(shape.attackEnd.y - highest) < 1, `dot at ${shape.attackEnd.y}, curve peaks at ${highest}`);
});

test('the dots bracket the hold, in order', () => {
  const shape = shapeOf({ attackMs: 10, holdMs: 40, decayMs: 100 });
  assert.ok(shape.attackEnd.x < shape.decayStart.x, 'the decay cannot start before the attack ends');
  // 10 ms and 50 ms through a 150 ms span.
  assert.ok(Math.abs(shape.span - 0.15) < 1e-9, `span ${shape.span}`);
  assert.ok(Math.abs(shape.attackEnd.x - (0.01 / 0.15) * BOX.width) < 1e-6);
  assert.ok(Math.abs(shape.decayStart.x - (0.05 / 0.15) * BOX.width) < 1e-6);
});

test('with no hold the two dots are the same point', () => {
  // Percussion, and any truncated attack. One dot is the right reading: there is one
  // boundary, not two -- so nothing special-cases it, it simply falls out.
  const shape = shapeOf({ attackMs: 20, holdMs: 0, decayMs: 100 });
  assert.deepEqual(shape.attackEnd, shape.decayStart);
});

test('a truncated attack puts both dots on the step boundary', () => {
  const shape = shapeOf({ attackMs: 500 });
  assert.equal(shape.truncated, true);
  assert.deepEqual(shape.attackEnd, shape.decayStart, 'a cut attack has no hold to bracket');
  assert.ok(
    Math.abs(shape.attackEnd.x - shape.stepMarkerX) < 1e-6,
    `dot at ${shape.attackEnd.x}, boundary at ${shape.stepMarkerX}`,
  );
  // ...and below full level, since the ramp never got there.
  assert.ok(shape.attackEnd.y > MARGIN_TOP + 1, 'a cut attack must draw below the top');
});

test('the decay-start dot lands on the boundary when hold is clamped to it', () => {
  const shape = shapeOf({ attackMs: 10, holdMs: 5000 });
  assert.ok(
    Math.abs(shape.decayStart.x - shape.stepMarkerX) < 1e-6,
    `dot at ${shape.decayStart.x}, boundary at ${shape.stepMarkerX}`,
  );
  // ...and the shape says so, which is what puts a warning on that dot.
  assert.equal(shape.holdClamped, true);
});

test('a hold that fits raises no flag', () => {
  const shape = shapeOf({ attackMs: 10, holdMs: 40, decayMs: 100 });
  assert.equal(shape.holdClamped, false);
  assert.equal(shape.truncated, false);
});

test('a cut attack flags itself and not the hold', () => {
  // One warning, on one dot -- the two coincide there, so both would sit on the same
  // point and say different things about it.
  const shape = shapeOf({ attackMs: 500, holdMs: 500 });
  assert.equal(shape.truncated, true);
  assert.equal(shape.holdClamped, false);
});

test('a zero attack still draws a whole dot rather than half of one', () => {
  // It genuinely ends at t = 0; a dot centred there would be half outside the frame.
  const shape = shapeOf({ attackMs: 0 });
  assert.equal(shape.attackEnd.x, DOT_INSET);
});

test('the dots stay inside the box at every extreme', () => {
  for (const over of [{ attackMs: 0, holdMs: 0 }, { attackMs: 2000 }, { decayMs: 1 }]) {
    const shape = shapeOf(over);
    for (const dot of [shape.attackEnd, shape.decayStart]) {
      assert.ok(dot.x >= 0 && dot.x <= BOX.width, `x ${dot.x} for ${JSON.stringify(over)}`);
      assert.ok(dot.y >= 0 && dot.y <= BOX.height, `y ${dot.y} for ${JSON.stringify(over)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The step marker
// ---------------------------------------------------------------------------

test('an envelope shorter than its step leaves the marker at the far edge', () => {
  // 10 + 60 + 40 = 110 ms inside a 125 ms step: the step is the longer of the two, so
  // it sets the span and the marker reaches the end of the box.
  const shape = shapeOf({ attackMs: 10, holdMs: 60, decayMs: 40 });
  assert.equal(shape.stepMarkerX, BOX.width);
  assert.equal(shape.bleeds, false);
  // ...and the curve is back at silence before the right-hand edge.
  const beforeEnd = shape.points[Math.round(shape.points.length * 0.95)];
  assert.equal(beforeEnd.y, shape.points[0].y);
});

test('an envelope longer than its step pulls the marker back proportionally', () => {
  // Default: 10 ms attack, hold clamped to the boundary, then a 200 ms decay -- so
  // 325 ms total against a 125 ms step.
  const shape = shapeOf();
  assert.ok(Math.abs(shape.span - 0.325) < 1e-9, `span ${shape.span}`);
  assert.ok(Math.abs(shape.stepMarkerX - (0.125 / 0.325) * BOX.width) < 1e-6);
  assert.equal(shape.bleeds, true, 'the tail carries into the next step');
});

test('the marker sits exactly where the decay begins when hold is clamped', () => {
  // Rule 2's clamped branch: hold ends at the boundary, so the marker and the top of
  // the curve break at the same x. Reading that alignment off the panel is the whole
  // reason the marker is there.
  const shape = shapeOf({ attackMs: 10, holdMs: 5000, decayMs: 200 });
  const top = Math.min(...shape.points.map((p) => p.y));
  const lastHeld = shape.points.findLastIndex((p) => p.y <= top + 1e-9);
  const heldUntilX = shape.points[lastHeld].x;
  const pointSpacing = BOX.width / (shape.points.length - 1);
  assert.ok(
    Math.abs(heldUntilX - shape.stepMarkerX) <= pointSpacing,
    `held to ${heldUntilX}, marker at ${shape.stepMarkerX}`,
  );
});

test('a truncated attack is reported, and its ramp breaks at the marker', () => {
  // Rule 1: a 500 ms attack on a 125 ms step. The curve is still climbing when the
  // marker arrives, and the highest point of the whole shape is right there.
  const shape = shapeOf({ attackMs: 500 });
  assert.equal(shape.truncated, true);
  const top = Math.min(...shape.points.map((p) => p.y));
  const peakAt = shape.points[shape.points.findIndex((p) => p.y === top)].x;
  const pointSpacing = BOX.width / (shape.points.length - 1);
  assert.ok(
    Math.abs(peakAt - shape.stepMarkerX) <= pointSpacing,
    `peak at ${peakAt}, marker at ${shape.stepMarkerX}`,
  );
});

test('a truncated attack never reaches the top of the box', () => {
  const full = shapeOf({ attackMs: 10 });
  const cut = shapeOf({ attackMs: 500 });
  assert.ok(
    Math.min(...cut.points.map((p) => p.y)) > Math.min(...full.points.map((p) => p.y)),
    'a cut-short attack must draw visibly lower than a completed one',
  );
});

test('no step means no marker, and the envelope alone sets the span', () => {
  // A page with no transport to ask -- the marker would be a line at an arbitrary
  // place, which is worse than no line.
  const shape = shapeOf({ attackMs: 20, holdMs: 30, decayMs: 50 }, 0);
  assert.equal(shape.stepMarkerX, null);
  assert.ok(Math.abs(shape.span - 0.1) < 1e-9, `span ${shape.span}`);
});

// ---------------------------------------------------------------------------
// Degenerate boxes -- a hidden panel measures zero, and is asked to draw anyway
// ---------------------------------------------------------------------------

test('a zero-sized box produces finite dots too', () => {
  const shape = envelopeShape({
    env: ahdEnvelope({
      attackMs: 10, holdMs: 20, decayMs: 30, stepSeconds: STEP, exponential: false,
    }),
    stepSeconds: STEP,
    width: 0,
    height: 0,
  });
  for (const dot of [shape.attackEnd, shape.decayStart]) {
    assert.ok(Number.isFinite(dot.x) && Number.isFinite(dot.y), `${dot.x},${dot.y}`);
    assert.ok(dot.x >= 0, `a box with no width cannot push a dot negative: ${dot.x}`);
  }
});

test('a zero-sized box produces finite points rather than NaN', () => {
  const shape = envelopeShape({
    env: ahdEnvelope({
      attackMs: 10, holdMs: 20, decayMs: 30, stepSeconds: STEP, exponential: true,
    }),
    stepSeconds: STEP,
    width: 0,
    height: 0,
  });
  assert.ok(shape.points.length >= 2);
  for (const { x, y } of shape.points) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `${x},${y}`);
  }
});

test('the sample count can be pinned independently of the width', () => {
  const shape = envelopeShape({
    env: ahdEnvelope({
      attackMs: 10, holdMs: 20, decayMs: 30, stepSeconds: STEP, exponential: false,
    }),
    stepSeconds: STEP,
    width: 300,
    height: 60,
    samples: 12,
  });
  assert.equal(shape.points.length, 13);
  assert.equal(shape.points.at(-1).x, 300);
});
