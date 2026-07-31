import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { Rng } from '../src/core/rng.js';
import { ParamStore } from '../src/core/ParamStore.js';
import { normalizeParam, clampParam, paramSpec } from '../src/core/paramSchema.js';
import { Track } from '../src/sequencer/Track.js';
import { Scheduler } from '../src/sequencer/Scheduler.js';
import {
  STEP_MODS,
  STEP_MOD_DOTTED,
  STEP_MOD_STRAIGHT,
  STEP_MOD_TRIPLET,
  STEP_DIVISIONS,
  noteValueDescription,
  noteValueLabel,
  stepModById,
  stepModFactor,
} from '../src/sequencer/stepDivision.js';

const NULL_TICKER = { start() {}, stop() {}, dispose() {} };
const close = (a, b, tolerance = 1e-12) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} !== ${b}`);

function harness({ trackCount = 1, bpm = 120 } = {}) {
  const bus = new EventBus();
  const tracks = Array.from({ length: trackCount }, (_, i) => new Track(i, new Rng(7 + i)));
  const clock = { now: 0 };
  const scheduler = new Scheduler({
    bus,
    getCurrentTime: () => clock.now,
    tracks,
    ticker: NULL_TICKER,
  });
  const store = new ParamStore({
    bus,
    trackCount,
    route: (key, value, trackId, spec) => {
      if (spec.target === 'track') tracks[trackId]?.setParam(key, value);
      else if (spec.target === 'transport') scheduler.setParam(key, value);
    },
  });
  store.set('bpm', bpm);

  const steps = [];
  bus.on('step', (s) => steps.push(s));
  return {
    tracks,
    scheduler,
    store,
    steps,
    clock,
    start: () => scheduler.start(),
    advance: (seconds, sliceMs = 25) => {
      const slice = sliceMs / 1000;
      const target = clock.now + seconds;
      while (clock.now < target) {
        clock.now = Math.min(target, clock.now + slice);
        scheduler.pump();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The note-value maths
// ---------------------------------------------------------------------------

test('the default division is a 16th note, matching the tempo formula exactly', () => {
  // The division control must not change how the instrument sounds out of the box.
  for (const bpm of [30, 120, 300]) {
    const h = harness({ bpm });
    assert.equal(h.scheduler.stepDurationFor(0), 60 / (bpm * 4));
  }
});

test('every division is one bar divided by its denominator', () => {
  const h = harness({ bpm: 120 });
  const bar = 240 / 120;
  assert.equal(h.scheduler.barDuration, bar);

  for (const division of STEP_DIVISIONS) {
    h.store.set('stepDivision', division, 0);
    close(h.scheduler.stepDurationFor(0), bar / division);
  }
});

test('a quarter note is one beat, and a whole note is one bar', () => {
  const h = harness({ bpm: 120 });
  h.store.set('stepDivision', 4, 0);
  close(h.scheduler.stepDurationFor(0), 0.5); // 60/120
  h.store.set('stepDivision', 1, 0);
  close(h.scheduler.stepDurationFor(0), 2); // a 4/4 bar
});

test('triplet is exactly two thirds and dotted exactly one and a half', () => {
  const h = harness({ bpm: 120 });
  for (const division of STEP_DIVISIONS) {
    h.store.set('stepDivision', division, 0);

    h.store.set('stepMod', STEP_MOD_STRAIGHT, 0);
    const straight = h.scheduler.stepDurationFor(0);

    h.store.set('stepMod', STEP_MOD_TRIPLET, 0);
    close(h.scheduler.stepDurationFor(0), straight * (2 / 3));

    h.store.set('stepMod', STEP_MOD_DOTTED, 0);
    close(h.scheduler.stepDurationFor(0), straight * 1.5);
  }
});

test('three triplets fill the space of two straight steps', () => {
  // The definition of a triplet, and the reason the factor is 2/3.
  const h = harness({ bpm: 120 });
  h.store.set('stepDivision', 8, 0);
  const straight = h.scheduler.stepDurationFor(0);
  h.store.set('stepMod', STEP_MOD_TRIPLET, 0);
  close(h.scheduler.stepDurationFor(0) * 3, straight * 2);
});

test('a dotted step is a step plus half a step', () => {
  const h = harness({ bpm: 120 });
  h.store.set('stepDivision', 4, 0);
  const straight = h.scheduler.stepDurationFor(0);
  h.store.set('stepMod', STEP_MOD_DOTTED, 0);
  close(h.scheduler.stepDurationFor(0), straight + straight / 2);
});

test('the modifier is tri-state, so triplet and dotted can never both apply', () => {
  // Two independent flags would allow x2/3 * x3/2 = x1, a state that looks meaningful
  // and sounds like neither. One value makes it unrepresentable.
  assert.equal(STEP_MODS.length, 3);
  assert.deepEqual(STEP_MODS.map((m) => m.id), [0, 1, 2]);

  const h = harness({ bpm: 120 });
  h.store.set('stepMod', STEP_MOD_TRIPLET, 0);
  assert.equal(h.tracks[0].params.stepMod, STEP_MOD_TRIPLET);
  h.store.set('stepMod', STEP_MOD_DOTTED, 0);
  // Setting one replaces the other; there is nowhere for both to live.
  assert.equal(h.tracks[0].params.stepMod, STEP_MOD_DOTTED);
});

test('an unrecognised modifier falls back to straight and never yields NaN', () => {
  // A NaN duration would leave the scheduler's `while (nextStepTime < horizon)` loop
  // unable to advance -- it would spin forever rather than merely sound wrong.
  for (const bad of [undefined, null, NaN, -1, 99, 'dotted', {}]) {
    assert.equal(stepModFactor(bad), 1, `factor for ${String(bad)}`);
    assert.equal(stepModById(bad).id, STEP_MOD_STRAIGHT);
  }

  const track = new Track(0, new Rng(1));
  track.params.stepMod = NaN;
  const duration = track.stepDuration(2);
  assert.ok(Number.isFinite(duration) && duration > 0, `duration ${duration}`);
});

test('label and spoken form', () => {
  assert.equal(noteValueLabel(16), '1/16');
  assert.equal(noteValueLabel(1), '1/1');
  assert.equal(noteValueDescription(8, STEP_MOD_STRAIGHT), '1/8');
  assert.equal(noteValueDescription(8, STEP_MOD_TRIPLET), '1/8 triplet');
  assert.equal(noteValueDescription(8, STEP_MOD_DOTTED), '1/8 dotted');
});

// ---------------------------------------------------------------------------
// Enumerated params in the schema
// ---------------------------------------------------------------------------

test('stepDivision snaps to the nearest offered note value', () => {
  assert.deepEqual(paramSpec('stepDivision').values, [1, 2, 4, 8, 16, 32]);
  assert.equal(normalizeParam('stepDivision', 16), 16);
  assert.equal(normalizeParam('stepDivision', 0.7), 1);
  assert.equal(normalizeParam('stepDivision', 3), 2, 'ties resolve downward');
  assert.equal(normalizeParam('stepDivision', 12), 8, 'ties resolve downward');
  assert.equal(normalizeParam('stepDivision', 20), 16);
  assert.equal(normalizeParam('stepDivision', 30), 32);
  // Out of range clamps to the ends of the list.
  assert.equal(normalizeParam('stepDivision', -5), 1);
  assert.equal(normalizeParam('stepDivision', 9999), 32);
  // Non-finite falls back to the default rather than poisoning the timing maths.
  assert.equal(normalizeParam('stepDivision', NaN), paramSpec('stepDivision').def);
});

test('clampParam snaps enumerated params too, as a net below the store', () => {
  assert.equal(clampParam('stepDivision', 12), 8);
  assert.equal(clampParam('stepDivision', 9999), 32);
  assert.equal(clampParam('stepMod', 7), 2);
  assert.equal(clampParam('stepMod', NaN), paramSpec('stepMod').def);
});

test('the store only ever holds an offered division', () => {
  const h = harness();
  for (const attempt of [3, 12, 20, 0.1, 1000]) {
    h.store.set('stepDivision', attempt, 0);
    assert.ok(
      STEP_DIVISIONS.includes(h.store.get('stepDivision', 0)),
      `${attempt} became ${h.store.get('stepDivision', 0)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

test('a slower division produces proportionally fewer steps', () => {
  for (const [division, factor] of [[8, 0.5], [32, 2]]) {
    const base = harness({ bpm: 120 });
    base.start();
    base.advance(4);

    const other = harness({ bpm: 120 });
    other.store.set('stepDivision', division, 0);
    other.start();
    other.advance(4);

    // Within one step, since the window boundary can land mid-step either way.
    const expected = base.steps.length * factor;
    assert.ok(
      Math.abs(other.steps.length - expected) <= 2,
      `division 1/${division}: ${other.steps.length} steps, expected ~${expected}`,
    );
  }
});

test('two tracks at different divisions run at different speeds off one clock', () => {
  // The whole point of the feature: faster and slower tracks, same tempo.
  const h = harness({ trackCount: 2, bpm: 120 });
  h.store.set('stepDivision', 16, 0);
  h.store.set('stepDivision', 8, 1);
  h.start();
  h.advance(8);

  const fast = h.steps.filter((s) => s.trackId === 0).length;
  const slow = h.steps.filter((s) => s.trackId === 1).length;
  assert.ok(fast > 50, `only ${fast} steps on the fast track`);
  assert.ok(Math.abs(fast - slow * 2) <= 2, `${fast} vs ${slow} -- expected 2:1`);
});

test('each track keeps its own division; a change does not leak', () => {
  const h = harness({ trackCount: 2 });
  h.store.set('stepDivision', 4, 1);
  h.store.set('stepMod', STEP_MOD_TRIPLET, 1);

  assert.equal(h.tracks[0].params.stepDivision, paramSpec('stepDivision').def);
  assert.equal(h.tracks[0].params.stepMod, STEP_MOD_STRAIGHT);
  assert.equal(h.tracks[1].params.stepDivision, 4);
  assert.equal(h.tracks[1].params.stepMod, STEP_MOD_TRIPLET);
  assert.notEqual(h.scheduler.stepDurationFor(0), h.scheduler.stepDurationFor(1));
});

test('steps stay evenly spaced and drift-free at every division and modifier', () => {
  for (const division of [4, 16, 32]) {
    for (const mod of [STEP_MOD_STRAIGHT, STEP_MOD_TRIPLET, STEP_MOD_DOTTED]) {
      const h = harness({ bpm: 120 });
      h.store.set('stepDivision', division, 0);
      h.store.set('stepMod', mod, 0);
      h.start();
      h.advance(10);

      const expected = h.scheduler.stepDurationFor(0);
      const first = h.steps[0].audioTime;
      assert.ok(h.steps.length > 4, `1/${division} mod ${mod}: only ${h.steps.length} steps`);
      for (let i = 1; i < h.steps.length; i += 1) {
        const drift = h.steps[i].audioTime - (first + i * expected);
        assert.ok(Math.abs(drift) < 1e-9, `1/${division} mod ${mod}: drift ${drift} at ${i}`);
      }
    }
  }
});

test('a division change applies from the next step, never retiming scheduled ones', () => {
  const h = harness({ bpm: 120 });
  h.start();
  h.advance(2);
  const decidedBefore = h.steps.map((s) => s.audioTime);

  h.store.set('stepDivision', 4, 0);
  h.advance(4);

  // Steps already emitted keep the times they were promised.
  assert.deepEqual(h.steps.slice(0, decidedBefore.length).map((s) => s.audioTime), decidedBefore);

  // And the tail settles onto the new spacing.
  const tail = h.steps.slice(-4);
  const expected = h.scheduler.stepDurationFor(0);
  for (let i = 1; i < tail.length; i += 1) {
    close(tail[i].audioTime - tail[i - 1].audioTime, expected, 1e-9);
  }
});

test('changing steps changes cycle length but not step duration', () => {
  // The distinguishing property of this design: the division is per step, not per cycle.
  const h = harness({ bpm: 120 });
  const before = h.scheduler.stepDurationFor(0);
  h.store.set('steps', 7, 0);
  assert.equal(h.scheduler.stepDurationFor(0), before);
  h.store.set('steps', 32, 0);
  assert.equal(h.scheduler.stepDurationFor(0), before);
});

test('every step still reports the duration the audio engine should ramp over', () => {
  const h = harness({ bpm: 120 });
  h.store.set('stepDivision', 8, 0);
  h.store.set('stepMod', STEP_MOD_DOTTED, 0);
  h.start();
  h.advance(2);

  const expected = h.scheduler.stepDurationFor(0);
  for (const s of h.steps) {
    close(s.stepDuration, expected, 1e-9);
    assert.ok(Number.isFinite(s.stepDuration) && s.stepDuration > 0);
  }
});
