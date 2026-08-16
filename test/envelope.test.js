import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ahdEnvelope,
  attackCurve,
  decayCurve,
  envelopeDuration,
  envelopeLevel,
} from '../src/audio/envelope.js';
import { paramSpec } from '../src/core/paramSchema.js';

/**
 * The AHD envelope's step-boundary rules, which are the substance of issue #7 and are
 * deliberately closed-form so they can be checked here rather than by ear.
 *
 * This file covers the maths. What the audio thread does with it -- the per-sample
 * recursion, compiled out of the shipped worklet source -- is test/workletEnvelope.js.
 */

/** 120 BPM, 1/16 notes -- the schema's defaults, and the step most checks use. */
const STEP = 0.125;

const base = (over = {}) => ahdEnvelope({
  attackMs: 10, holdMs: 500, decayMs: 200, stepSeconds: STEP, exponential: false, ...over,
});

// ---------------------------------------------------------------------------
// Curve shapes
// ---------------------------------------------------------------------------

for (const exponential of [false, true]) {
  const name = exponential ? 'exponential' : 'linear';

  test(`the ${name} attack runs from exactly 0 to exactly 1`, () => {
    assert.equal(attackCurve(0, exponential), 0);
    assert.equal(attackCurve(1, exponential), 1);
  });

  test(`the ${name} decay runs from exactly 1 to exactly 0`, () => {
    // Not "near zero": an un-offset exponential stops at a thousandth, and a
    // thousandth held forever is a voice that never frees and DC under the mix.
    assert.equal(decayCurve(0, exponential), 1);
    assert.equal(decayCurve(1, exponential), 0);
  });

  test(`both ${name} curves are monotonic across their whole span`, () => {
    let lastUp = -Infinity;
    let lastDown = Infinity;
    for (let i = 0; i <= 100; i += 1) {
      const up = attackCurve(i / 100, exponential);
      const down = decayCurve(i / 100, exponential);
      assert.ok(up >= lastUp, `attack fell back at x=${i / 100}`);
      assert.ok(down <= lastDown, `decay rose at x=${i / 100}`);
      lastUp = up;
      lastDown = down;
    }
  });

  test(`the ${name} curves stay inside 0..1 for out-of-range input`, () => {
    for (const x of [-5, -0.001, 1.001, 42, Number.NaN, undefined]) {
      const up = attackCurve(x, exponential);
      const down = decayCurve(x, exponential);
      assert.ok(up >= 0 && up <= 1, `attackCurve(${x}) = ${up}`);
      assert.ok(down >= 0 && down <= 1, `decayCurve(${x}) = ${down}`);
    }
  });
}

test('the exponential attack is the mirror of the exponential decay', () => {
  // One shape, read in two directions -- if these ever drift apart, a note's rise
  // and its fall stop sounding like the same envelope.
  for (let i = 0; i <= 20; i += 1) {
    const x = i / 20;
    assert.ok(Math.abs(attackCurve(x, true) - (1 - decayCurve(x, true))) < 1e-12, `at x=${x}`);
  }
});

test('the exponential is genuinely curved, and the linear genuinely straight', () => {
  // Halfway through, an exponential attack is already most of the way up.
  assert.ok(attackCurve(0.5, true) > 0.9, 'exponential attack is barely faster than linear');
  assert.equal(attackCurve(0.5, false), 0.5);
});

// ---------------------------------------------------------------------------
// Rule 2: the attack fits, and hold decides where the decay starts
// ---------------------------------------------------------------------------

test('A + H < step: hold ends early and the decay starts before the boundary', () => {
  // 10 ms + 40 ms = 50 ms, well inside a 125 ms step.
  const env = base({ attackMs: 10, holdMs: 40 });
  assert.equal(env.attack, 0.01);
  assert.equal(env.hold, 0.04);
  assert.equal(env.peak, 1, 'the attack completed, so it reached full level');
  assert.ok(env.attack + env.hold < STEP, 'the decay must begin inside the step');
});

test('A + H >= step: hold is clamped so the decay starts exactly at the boundary', () => {
  const env = base({ attackMs: 10, holdMs: 5000 });
  assert.equal(env.attack, 0.01);
  assert.equal(env.hold, STEP - 0.01);
  assert.equal(env.attack + env.hold, STEP, 'the decay starts on the step boundary');
  assert.equal(env.peak, 1);
});

test('the default envelope holds to the boundary rather than releasing early', () => {
  // A = 10, H = 500, D = 200 against a 125 ms step -- the shipped defaults, which
  // land squarely in rule 2's clamped branch.
  const env = base();
  assert.equal(env.attack + env.hold, STEP);
  assert.equal(env.decay, 0.2);
});

// ---------------------------------------------------------------------------
// Rule 1: the attack does not fit
// ---------------------------------------------------------------------------

test('A >= step: the attack is cut at the boundary, below full level, with no hold', () => {
  // A 500 ms attack on a 125 ms step: a quarter of the way up when the step ends.
  const env = base({ attackMs: 500, holdMs: 5000 });
  assert.equal(env.attack, STEP, 'cut at the step boundary');
  assert.equal(env.attackFull, 0.5, 'the requested time is kept -- it is what shapes the ramp');
  assert.equal(env.hold, 0, 'hold is skipped entirely, not shortened');
  assert.ok(env.peak < 1, 'the ramp never reached the top');
  assert.equal(env.peak, attackCurve(0.25, false));
});

test('a truncated attack loses its hold whatever the hold was set to', () => {
  for (const holdMs of [0, 1, 500, 5000]) {
    assert.equal(base({ attackMs: 400, holdMs }).hold, 0, `holdMs ${holdMs}`);
  }
});

test('peak is continuous across the truncation threshold -- the no-pop guarantee', () => {
  // Either side of A === T_step the level the decay starts from must not jump, or
  // an attack nudged past the boundary would click.
  const justUnder = base({ attackMs: 124 }).peak;
  const exactly = base({ attackMs: 125 }).peak;
  const justOver = base({ attackMs: 126 }).peak;
  assert.equal(justUnder, 1);
  assert.equal(exactly, 1, 'an attack exactly one step long still completes');
  assert.ok(justOver > 0.99 && justOver < 1, `a hair past the boundary gave ${justOver}`);
});

test('the exponential curve truncates at its own level, not the linear one', () => {
  const linear = base({ attackMs: 500, exponential: false }).peak;
  const exponential = base({ attackMs: 500, exponential: true }).peak;
  assert.equal(linear, 0.25);
  assert.ok(exponential > linear, 'an exponential attack is further along at the same point');
});

// ---------------------------------------------------------------------------
// Rule 3: the decay is never clipped
// ---------------------------------------------------------------------------

test('the decay keeps its full length however little of the step is left', () => {
  for (const attackMs of [0, 10, 124, 500, 2000]) {
    assert.equal(base({ attackMs, decayMs: 900 }).decay, 0.9, `attackMs ${attackMs}`);
  }
});

test('a long envelope bleeds past its step rather than being cut to fit', () => {
  const env = base({ attackMs: 10, holdMs: 500, decayMs: 5000 });
  assert.ok(envelopeDuration(env) > STEP * 20, 'the tail outlives many steps');
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test('no step duration means nothing is truncated', () => {
  // A hit built outside the sequencer -- a check page assembling a message by hand.
  for (const stepSeconds of [0, undefined, Number.NaN, -1]) {
    const env = ahdEnvelope({
      attackMs: 400, holdMs: 300, decayMs: 200, stepSeconds, exponential: false,
    });
    assert.equal(env.attack, 0.4, `stepSeconds ${stepSeconds}`);
    assert.equal(env.hold, 0.3, `stepSeconds ${stepSeconds}`);
    assert.equal(env.peak, 1, `stepSeconds ${stepSeconds}`);
  }
});

test('this module\'s own bounds are the schema\'s', () => {
  // The schema is what the controls obey; these are what a value arriving from
  // anywhere else obeys -- a preset, a future MIDI mapping. Two copies of one fact,
  // so they get pinned together rather than trusted.
  const ceiling = (key) => ahdEnvelope({
    attackMs: 1e9, holdMs: 1e9, decayMs: 1e9, stepSeconds: 1e9, exponential: false,
  })[key] * 1000;
  assert.equal(ceiling('attackFull'), paramSpec('envAttack').max);
  assert.equal(ceiling('hold'), paramSpec('envHold').max);
  assert.equal(ceiling('decay'), paramSpec('envDecay').max);
});

test('every stage is clamped to its schema range, and a NaN cannot escape', () => {
  const wild = ahdEnvelope({
    attackMs: 99999, holdMs: -50, decayMs: Number.NaN, stepSeconds: 100, exponential: true,
  });
  assert.equal(wild.attackFull, 2, 'attack tops out at 2000 ms');
  assert.equal(wild.hold, 0, 'a negative hold floors at zero');
  // A NaN decay clamps to the range floor, then the minimum-decay guard lifts it --
  // a zero-length decay would divide by zero in the worklet's per-sample step.
  assert.equal(wild.decay, 0.005);
  for (const [key, value] of Object.entries(wild)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is ${value}`);
  }
});

test('a zero attack is at full level on its first sample', () => {
  const env = base({ attackMs: 0 });
  assert.equal(env.attack, 0);
  assert.equal(env.peak, 1);
  assert.equal(envelopeLevel(env, 0), 1);
});

// ---------------------------------------------------------------------------
// envelopeLevel: the shape the visualiser draws
// ---------------------------------------------------------------------------

test('the level walks 0 -> peak -> hold -> 0 and stays there', () => {
  const env = base({ attackMs: 20, holdMs: 40, decayMs: 100 });
  assert.equal(envelopeLevel(env, 0), 0);
  assert.equal(envelopeLevel(env, 0.02), 1, 'full level at the end of the attack');
  assert.equal(envelopeLevel(env, 0.05), 1, 'still held');
  assert.ok(envelopeLevel(env, 0.11) < 1, 'decaying');
  assert.equal(envelopeLevel(env, 0.16), 0, 'silent at the end of the decay');
  assert.equal(envelopeLevel(env, 99), 0, 'and stays silent');
  assert.equal(envelopeLevel(env, -1), 0, 'before the note starts');
});

test('a truncated attack hands the decay exactly the level it reached', () => {
  const env = base({ attackMs: 500 });
  const atBoundary = envelopeLevel(env, STEP - 1e-9);
  const justAfter = envelopeLevel(env, STEP + 1e-9);
  assert.ok(Math.abs(atBoundary - env.peak) < 1e-6, 'the ramp ends at peak');
  assert.ok(Math.abs(justAfter - env.peak) < 1e-6, 'and the decay starts from it');
});

test('the level never leaves 0..peak, for either curve', () => {
  for (const exponential of [false, true]) {
    const env = base({ attackMs: 300, holdMs: 200, decayMs: 400, exponential });
    const total = envelopeDuration(env);
    for (let i = 0; i <= 200; i += 1) {
      const level = envelopeLevel(env, (i / 200) * total * 1.2);
      assert.ok(level >= 0 && level <= env.peak + 1e-12, `level ${level} at ${i}`);
    }
  }
});

// The per-sample recursion the two worklets run against this same shape is checked in
// test/workletEnvelope.test.js, which compiles it out of the shipped worklet source
// rather than re-implementing it here.
