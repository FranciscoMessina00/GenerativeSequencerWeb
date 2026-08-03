import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAM_SCHEMA, paramSpec } from '../src/core/paramSchema.js';
import { stepModFactor } from '../src/sequencer/stepDivision.js';
import {
  SHAPE_NAMES,
  foldValue,
  lfoPeriod,
  lfoValue,
  shapeName,
  shapeValue,
} from '../src/modulation/lfo.js';
import { MOD_TARGETS, modTargetKey } from '../src/modulation/modTargets.js';
import { Modulation } from '../src/modulation/Modulation.js';

const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;
/** The morph positions the four anchors land on: 0, 1/3, 2/3, 1. */
const ANCHOR_AT = [0, 1 / 3, 2 / 3, 1];
const PHASES = [0, 0.05, 0.12, 0.25, 0.33, 0.49, 0.5, 0.51, 0.75, 0.9, 0.99];

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('each anchor position reproduces that shape exactly', () => {
  const expected = [
    (p) => Math.sin(2 * Math.PI * p),
    (p) => 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5),
    (p) => 2 * ((p + 0.5) % 1) - 1,
    (p) => (p < 0.5 ? 1 : -1),
  ];
  for (let i = 0; i < 4; i += 1) {
    for (const p of PHASES) {
      assert.ok(
        close(shapeValue(ANCHOR_AT[i], p), expected[i](p)),
        `${SHAPE_NAMES[i]} at phase ${p}: got ${shapeValue(ANCHOR_AT[i], p)}`,
      );
    }
  }
});

test('every shape leaves phase 0 at zero and rising, so morphing never shifts phase', () => {
  // Square is the exception by nature -- it has no ramp, it is already at its peak.
  for (const at of ANCHOR_AT.slice(0, 3)) {
    assert.ok(close(shapeValue(at, 0), 0), `shape ${at} should start at zero`);
    assert.ok(shapeValue(at, 0.01) > 0, `shape ${at} should be rising at phase 0`);
  }
  assert.equal(shapeValue(1, 0), 1);
  // The morph in between must not introduce a phase offset either.
  for (const at of [0.1, 0.4, 0.5, 0.6]) {
    assert.ok(shapeValue(at, 0.01) > 0, `shape ${at} should still be rising at phase 0`);
  }
});

test('a morph between two anchors is a plain crossfade of them', () => {
  // Halfway through the first segment is half sine, half triangle.
  const halfway = (0 + 1 / 3) / 2;
  for (const p of PHASES) {
    const sine = shapeValue(0, p);
    const triangle = shapeValue(1 / 3, p);
    assert.ok(close(shapeValue(halfway, p), (sine + triangle) / 2, 1e-9), `phase ${p}`);
  }
});

test('phase wraps, including negative phase', () => {
  for (const p of PHASES) {
    assert.ok(close(shapeValue(0.4, p), shapeValue(0.4, p + 1)), `phase ${p} vs ${p + 1}`);
    assert.ok(close(shapeValue(0.4, p), shapeValue(0.4, p - 1)), `phase ${p} vs ${p - 1}`);
  }
});

test('shapeName reports the nearest anchor', () => {
  assert.equal(shapeName(0), 'Sine');
  assert.equal(shapeName(1 / 3), 'Triangle');
  assert.equal(shapeName(2 / 3), 'Saw');
  assert.equal(shapeName(1), 'Square');
  assert.equal(shapeName(0.05), 'Sine');
  assert.equal(shapeName(0.95), 'Square');
  // Out of range should still name something rather than returning undefined.
  assert.equal(shapeName(-1), 'Sine');
  assert.equal(shapeName(4), 'Square');
});

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

test('fold 0 is the identity', () => {
  for (const x of [-1, -0.7, -0.25, 0, 0.25, 0.7, 1]) {
    assert.equal(foldValue(x, 0), x);
  }
});

test('fold reflects anything past the threshold, and keeps the sign', () => {
  // fold 1 -> threshold 0.5, so a peak of 1 folds all the way back to 0.
  assert.ok(close(foldValue(1, 1), 0));
  assert.ok(close(foldValue(-1, 1), 0));
  // 0.5 sits exactly on the threshold and is left alone.
  assert.ok(close(foldValue(0.5, 1), 0.5));
  // fold 0.5 -> threshold 0.75; 1 overshoots by 0.25 and reflects to 0.5.
  assert.ok(close(foldValue(1, 0.5), 0.5));
  assert.ok(close(foldValue(-1, 0.5), -0.5));
  // Below the threshold, nothing happens.
  assert.ok(close(foldValue(0.6, 0.5), 0.6));
});

test('a folded value never exceeds the threshold', () => {
  for (let fold = 0; fold <= 1.0001; fold += 0.05) {
    const threshold = 1 - 0.5 * Math.min(1, fold);
    for (let x = -1; x <= 1.0001; x += 0.02) {
      const y = foldValue(x, fold);
      assert.ok(
        Math.abs(y) <= threshold + 1e-9,
        `|fold(${x}, ${fold})| = ${Math.abs(y)} exceeded ${threshold}`,
      );
    }
  }
});

test('one reflection is provably enough -- folding never comes out negative-magnitude', () => {
  // The claim the single-pass implementation rests on: input magnitude at most 1 and
  // threshold at least 0.5, so 2t - m bottoms out at exactly 0.
  for (let fold = 0; fold <= 1.0001; fold += 0.05) {
    for (let x = -1; x <= 1.0001; x += 0.02) {
      const y = foldValue(x, fold);
      assert.ok(Math.sign(y) === Math.sign(x) || y === 0, `sign flipped at ${x}, ${fold}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The combined output
// ---------------------------------------------------------------------------

test('output is always finite and within [-1, 1] across the whole surface', () => {
  // This is the guard that matters most: clampParam does not check for NaN on its
  // numeric path, and a NaN reaching an AudioParam poisons it for the lifetime of
  // the audio graph. Includes deliberately out-of-range inputs.
  for (const shape of [-1, 0, 0.17, 1 / 3, 0.5, 2 / 3, 0.83, 1, 2]) {
    for (const fold of [-1, 0, 0.3, 0.5, 0.77, 1, 2]) {
      for (let p = -0.5; p <= 1.5; p += 0.017) {
        const v = lfoValue(shape, fold, p);
        assert.ok(Number.isFinite(v), `not finite at ${shape}/${fold}/${p}: ${v}`);
        assert.ok(v >= -1 && v <= 1, `out of range at ${shape}/${fold}/${p}: ${v}`);
      }
    }
  }
});

test('non-numeric settings still produce a finite value', () => {
  for (const bad of [NaN, undefined, null, 'x']) {
    assert.ok(Number.isFinite(lfoValue(bad, 0, 0.3)), `shape ${bad}`);
    assert.ok(Number.isFinite(lfoValue(0, bad, 0.3)), `fold ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

test('a free rate is just its period', () => {
  assert.equal(lfoPeriod({ sync: false, rate: 1 }), 1);
  assert.equal(lfoPeriod({ sync: false, rate: 10 }), 0.1);
  assert.ok(close(lfoPeriod({ sync: false, rate: 0.1 }), 10));
});

test('a synced cycle spans exactly what one sequencer step would', () => {
  // Deliberately the same formula as Track.stepDuration, asserted against
  // stepModFactor rather than a copied constant, so the two cannot drift.
  const barSeconds = 240 / 120; // 2s per bar at 120bpm
  for (const division of [1, 2, 4, 8, 16, 32]) {
    for (const modId of [0, 1, 2]) {
      const expected = (barSeconds / division) * stepModFactor(modId);
      const actual = lfoPeriod({
        sync: true, division, modFactor: stepModFactor(modId), barSeconds,
      });
      assert.ok(close(actual, expected), `1/${division} mod ${modId}`);
    }
  }
  // A quarter note at 120bpm is half a second.
  assert.ok(close(lfoPeriod({ sync: true, division: 4, modFactor: 1, barSeconds }), 0.5));
});

test('a nonsense rate or bar length falls back rather than yielding NaN', () => {
  // A NaN period would make every later phase NaN, so this must never happen.
  for (const bad of [0, -1, NaN, undefined, null]) {
    assert.ok(Number.isFinite(lfoPeriod({ sync: false, rate: bad })), `rate ${bad}`);
    assert.ok(lfoPeriod({ sync: false, rate: bad }) > 0);
    assert.ok(Number.isFinite(lfoPeriod({ sync: true, division: 4, barSeconds: bad })), `bar ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Targets, and the invariants that keep them honest
// ---------------------------------------------------------------------------

test('lfoTarget spans exactly the target table', () => {
  // paramSchema.js is deliberately import-free, so its max is a literal. This is what
  // stops the literal and the table drifting apart.
  assert.equal(paramSpec('lfoTarget').max, MOD_TARGETS.length - 1);
  assert.equal(paramSpec('lfoTarget').min, 0);
  assert.equal(MOD_TARGETS[0], null, 'index 0 must stay "not mapped"');
});

test('every target is a real param that can actually be swept', () => {
  for (const key of MOD_TARGETS.filter(Boolean)) {
    const spec = paramSpec(key);
    assert.ok(spec, `${key} is not in the schema`);
    // Enumerated and toggle params snap or coerce, so an offset jumps between
    // unrelated settings instead of sweeping.
    assert.ok(!spec.values, `${key} is enumerated and cannot be modulated smoothly`);
    assert.notEqual(spec.type, 'toggle', `${key} is a toggle`);
    assert.ok(Number.isFinite(spec.min) && Number.isFinite(spec.max), `${key} has no range`);
    assert.ok(spec.max > spec.min, `${key} has an empty range`);
  }
});

test('the destructive params are kept off the target list', () => {
  // Each of these either rebuilds the pattern or re-captures a frozen loop on every
  // write, so modulating them would fight the feature they belong to.
  const forbidden = [
    'steps', 'pulses', 'rotation',
    'trigLoopLength', 'trigPerm', 'noteLoopLength', 'notePerm', 'velLoopLength',
    'modes',
  ];
  for (const key of forbidden) {
    assert.ok(!MOD_TARGETS.includes(key), `${key} must not be modulatable`);
  }
});

test('modTargetKey maps indices to keys, and anything odd to unmapped', () => {
  assert.equal(modTargetKey(0), null);
  assert.equal(modTargetKey(1), 'modBias');
  assert.equal(modTargetKey(MOD_TARGETS.length - 1), MOD_TARGETS.at(-1));
  for (const bad of [-1, 999, NaN, undefined, null]) {
    assert.equal(modTargetKey(bad), null, `index ${bad}`);
  }
});

test('the LFO params form their own routing target, and default to inert', () => {
  const lfoParams = PARAM_SCHEMA.filter((s) => s.target === 'modulation');
  assert.equal(lfoParams.length, 8);
  for (const spec of lfoParams) {
    assert.equal(spec.group, 'Modulation', `${spec.key} should be in the Modulation group`);
  }
  // Nothing is modulated until the user maps something, so adding this feature cannot
  // change how an existing patch sounds.
  assert.equal(paramSpec('lfoAmount').def, 0);
  assert.equal(paramSpec('lfoTarget').def, 0);
});

// ---------------------------------------------------------------------------
// Modulation: the offset, and giving the parameter back
// ---------------------------------------------------------------------------

/** A store stand-in plus a log of everything written to the "engines". */
function harness(base = {}) {
  const values = { grainDryWet: 0, modBias: 4, stiffness: 11, ...base };
  const writes = [];
  const modulation = new Modulation({
    store: { get: (key) => values[key] },
    write: (key, value) => writes.push({ key, value }),
    getBarSeconds: () => 2,
    trackId: 0,
  });
  return { modulation, writes, values };
}

/** Point it at a target with some depth, and start the transport. */
function armed(targetKey, amount = 1, extra = {}) {
  const h = harness();
  h.modulation.setParam('lfoTarget', MOD_TARGETS.indexOf(targetKey));
  h.modulation.setParam('lfoAmount', amount);
  for (const [k, v] of Object.entries(extra)) h.modulation.setParam(k, v);
  h.modulation.setRunning(true);
  h.writes.length = 0;
  return h;
}

test('nothing is written while unmapped or at zero depth', () => {
  const h = harness();
  h.modulation.setRunning(true);
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.125 });
  assert.deepEqual(h.writes, [], 'unmapped LFO should write nothing');

  h.modulation.setParam('lfoTarget', MOD_TARGETS.indexOf('grainDryWet'));
  h.modulation.onStep({ audioTime: 0.125, stepDuration: 0.125 });
  assert.deepEqual(h.writes, [], 'zero depth should write nothing');
});

test('the phase advances even with nothing mapped, while still writing nothing', () => {
  // Regression test: the phase advance used to sit behind the same guard as the write,
  // so at the factory defaults (target 0, amount 0) the LFO never moved at all and the
  // scope's marker stayed frozen at the start of the cycle. Watching the shape and rate
  // must not require having chosen a destination first.
  const h = harness();
  h.modulation.setParam('lfoRate', 1);
  h.modulation.setRunning(true);

  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    h.modulation.onStep({ audioTime: i * 0.25, stepDuration: 0.25 });
    seen.push(h.modulation.phase);
  }
  // A quarter of a 1Hz cycle per step.
  assert.ok(close(seen[0], 0.25), `got ${seen[0]}`);
  assert.ok(close(seen[1], 0.5), `got ${seen[1]}`);
  assert.ok(close(seen[2], 0.75), `got ${seen[2]}`);
  assert.ok(close(seen[3], 0), `should wrap, got ${seen[3]}`);
  assert.deepEqual(h.writes, [], 'an unmapped LFO must still write nothing');
  // And the interpolated read the scope uses has to work too, which needs anchorTime.
  assert.ok(Number.isFinite(h.modulation.phaseAt(1)));
});

test('the offset is bipolar around the stored value and scaled by half the range', () => {
  // Square at phase 0 is exactly +1, which makes the arithmetic checkable by hand.
  // grainDryWet spans -1..1, so half its range is 1: amount 0.5 gives +0.5.
  const h = armed('grainDryWet', 0.5, { lfoShape: 1, lfoRate: 1 });
  // A quarter of a cycle per step at 1Hz keeps phase inside the square's positive half.
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].key, 'grainDryWet');
  assert.ok(close(h.writes[0].value, 0.5), `got ${h.writes[0].value}`);

  // Half a cycle further on, the square is at -1 and the offset mirrors.
  h.modulation.onStep({ audioTime: 0.25, stepDuration: 0.5 });
  assert.ok(close(h.writes[1].value, -0.5), `got ${h.writes[1].value}`);
});

test('the offset centres on whatever the store currently holds', () => {
  const h = armed('grainDryWet', 0.5, { lfoShape: 1, lfoRate: 1 });
  h.values.grainDryWet = -0.25; // as if the user moved the control
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  assert.ok(close(h.writes[0].value, 0.25), `got ${h.writes[0].value}`);
});

test('the store is never written to', () => {
  const h = armed('grainDryWet', 1, { lfoShape: 1 });
  for (let i = 0; i < 20; i += 1) {
    h.modulation.onStep({ audioTime: i * 0.125, stepDuration: 0.125 });
  }
  assert.equal(h.values.grainDryWet, 0, 'the base value must be left alone');
  assert.ok(h.writes.length >= 20);
});

test('every written value is finite and inside the target range', () => {
  const spec = paramSpec('modBias');
  // Full depth on a param whose base sits near its floor: the offset must saturate at
  // the rail rather than escaping it.
  const h = armed('modBias', 1, { lfoShape: 0.5, lfoFold: 0.4, lfoRate: 3.7 });
  for (let i = 0; i < 200; i += 1) {
    h.modulation.onStep({ audioTime: i * 0.07, stepDuration: 0.07 });
  }
  for (const { value } of h.writes) {
    assert.ok(Number.isFinite(value), `wrote a non-finite value: ${value}`);
    assert.ok(value >= spec.min && value <= spec.max, `${value} outside ${spec.min}..${spec.max}`);
  }
});

test('changing the target hands the old one back to its stored value', () => {
  const h = armed('grainDryWet', 1, { lfoShape: 1 });
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  assert.notEqual(h.writes.at(-1).value, 0, 'should have been driven away from base');

  h.modulation.setParam('lfoTarget', MOD_TARGETS.indexOf('modBias'));
  const restore = h.writes.at(-1);
  assert.equal(restore.key, 'grainDryWet');
  assert.equal(restore.value, 0, 'must be put back to the stored base');
});

test('dropping the depth to zero also hands the parameter back', () => {
  const h = armed('grainDryWet', 1, { lfoShape: 1 });
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  h.modulation.setParam('lfoAmount', 0);
  assert.deepEqual(h.writes.at(-1), { key: 'grainDryWet', value: 0 });
});

test('stopping the transport hands the parameter back', () => {
  const h = armed('grainDryWet', 1, { lfoShape: 1 });
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  h.modulation.setRunning(false);
  assert.deepEqual(h.writes.at(-1), { key: 'grainDryWet', value: 0 });
});

test('restoring happens once, not on every later step', () => {
  const h = armed('grainDryWet', 1, { lfoShape: 1 });
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  h.modulation.setParam('lfoAmount', 0);
  h.writes.length = 0;
  h.modulation.onStep({ audioTime: 0.25, stepDuration: 0.25 });
  h.modulation.onStep({ audioTime: 0.5, stepDuration: 0.25 });
  assert.deepEqual(h.writes, [], 'an idle LFO should keep writing nothing');
});

test('starting the transport resets the phase, so a synced LFO locks to the bar', () => {
  const h = armed('grainDryWet', 1, { lfoSync: true, lfoDivision: 4 });
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.125 });
  h.modulation.onStep({ audioTime: 0.125, stepDuration: 0.125 });
  assert.notEqual(h.modulation.phase, 0);
  h.modulation.setRunning(true);
  assert.equal(h.modulation.phase, 0);
});

test('phase advances by elapsed time over period, and wraps', () => {
  const h = armed('grainDryWet', 1, { lfoRate: 1 });
  // First step seeds from its own duration; a quarter of a 1Hz cycle.
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  assert.ok(close(h.modulation.phase, 0.25), `got ${h.modulation.phase}`);
  h.modulation.onStep({ audioTime: 0.25, stepDuration: 0.5 });
  assert.ok(close(h.modulation.phase, 0.75), `got ${h.modulation.phase}`);
  // Past a full cycle it wraps rather than growing without bound.
  h.modulation.onStep({ audioTime: 0.75, stepDuration: 0.5 });
  assert.ok(close(h.modulation.phase, 0.25), `got ${h.modulation.phase}`);
});

test('a tempo change moves the synced period without jumping the phase', () => {
  let bar = 2; // 120bpm
  const writes = [];
  const modulation = new Modulation({
    store: { get: () => 0 },
    write: (key, value) => writes.push({ key, value }),
    getBarSeconds: () => bar,
  });
  modulation.setParam('lfoTarget', MOD_TARGETS.indexOf('grainDryWet'));
  modulation.setParam('lfoAmount', 1);
  modulation.setParam('lfoSync', true);
  modulation.setParam('lfoDivision', 4); // one cycle per quarter note
  modulation.setRunning(true);

  assert.ok(close(modulation.period(), 0.5));
  modulation.onStep({ audioTime: 0, stepDuration: 0.125 });
  const before = modulation.phase;
  bar = 4; // 60bpm: everything halves in speed
  assert.ok(close(modulation.period(), 1));
  assert.equal(modulation.phase, before, 'the phase itself must not jump');
});

test('phaseAt reads back from the anchor without advancing, and freezes when stopped', () => {
  const h = armed('grainDryWet', 1, { lfoRate: 1 });
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  const anchored = h.modulation.phase;

  // The anchor sits at the *next* step's time (0.25), so asking about now reads back.
  assert.ok(close(h.modulation.phaseAt(0.25), anchored));
  assert.ok(close(h.modulation.phaseAt(0.125), anchored - 0.125), 'should interpolate back');
  assert.equal(h.modulation.phase, anchored, 'phaseAt must not mutate');

  h.modulation.setRunning(false);
  assert.equal(h.modulation.phaseAt(99), h.modulation.phase, 'frozen while stopped');
});

test('phaseAt never runs away, even if steps stop arriving', () => {
  const h = armed('grainDryWet', 1, { lfoRate: 1 });
  h.modulation.onStep({ audioTime: 0, stepDuration: 0.25 });
  for (const t of [1, 10, 1e6]) {
    const p = h.modulation.phaseAt(t);
    assert.ok(Number.isFinite(p) && p >= 0 && p < 1, `phaseAt(${t}) = ${p}`);
  }
});
