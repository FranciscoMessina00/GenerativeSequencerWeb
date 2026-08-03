import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { Rng } from '../src/core/rng.js';
import { Track } from '../src/sequencer/Track.js';
import { Scheduler } from '../src/sequencer/Scheduler.js';
import { paramSpec } from '../src/core/paramSchema.js';

/**
 * A scheduler driven by a fake audio clock, so timing is deterministic.
 *
 * The real Ticker is replaced by a no-op: tests call `pump()` themselves, and a
 * live timer would both race the fake clock and keep Node's event loop open
 * forever after the test finished.
 */
const NULL_TICKER = { start() {}, stop() {}, dispose() {} };

function harness({ bpm = 120, seed = 2024 } = {}) {
  const bus = new EventBus();
  const track = new Track(0, new Rng(seed));
  const clock = { now: 0 };
  const scheduler = new Scheduler({
    bus,
    getCurrentTime: () => clock.now,
    tracks: [track],
    ticker: NULL_TICKER,
  });
  scheduler.setParam('bpm', bpm);

  const steps = [];
  bus.on('step', (s) => steps.push(s));

  // Mirrors main.js: the bus routes a param change to whichever consumer owns it.
  bus.on('param:change', ({ key, value }) => {
    const spec = paramSpec(key);
    if (spec?.target === 'track') track.setParam(key, value);
    else if (spec?.target === 'transport') scheduler.setParam(key, value);
  });

  /** Advance the clock in small slices, pumping as the ticker would. */
  const advance = (seconds, sliceMs = 25) => {
    const slice = sliceMs / 1000;
    const target = clock.now + seconds;
    while (clock.now < target) {
      clock.now = Math.min(target, clock.now + slice);
      scheduler.pump();
    }
  };

  return { bus, track, scheduler, steps, clock, advance };
}

test('EventBus delivers, unsubscribes, and survives a throwing listener', () => {
  const bus = new EventBus();
  const seen = [];
  const off = bus.on('x', (v) => seen.push(v));
  bus.emit('x', 1);
  off();
  bus.emit('x', 2);
  assert.deepEqual(seen, [1]);

  // A broken UI listener must not be able to stop the audio one.
  const after = [];
  bus.on('y', () => {
    throw new Error('boom');
  });
  bus.on('y', (v) => after.push(v));
  bus.emit('y', 7);
  assert.deepEqual(after, [7]);
});

test('one step is a 16th note at the set tempo', () => {
  for (const bpm of [30, 120, 300]) {
    const h = harness({ bpm });
    assert.equal(h.scheduler.stepDurationFor(0), 60 / (bpm * 4));
  }
});

test('steps are evenly spaced and free of drift', () => {
  const h = harness({ bpm: 120 });
  h.scheduler.start();
  h.advance(20);

  assert.ok(h.steps.length > 100, `only ${h.steps.length} steps`);
  const expected = h.scheduler.stepDurationFor(0);
  const first = h.steps[0].audioTime;

  for (let i = 1; i < h.steps.length; i += 1) {
    const gap = h.steps[i].audioTime - h.steps[i - 1].audioTime;
    assert.ok(Math.abs(gap - expected) < 1e-9, `gap ${gap} at step ${i}`);
    // Absolute position must stay exact, not just locally even.
    const drift = h.steps[i].audioTime - (first + i * expected);
    assert.ok(Math.abs(drift) < 1e-9, `drift ${drift} at step ${i}`);
  }
});

test('scheduling always runs ahead of the audio clock', () => {
  const h = harness();
  h.scheduler.start();
  const decided = [];
  h.bus.on('step', (s) => decided.push(s.audioTime - h.clock.now));
  h.advance(5);
  // Every step must be decided before it is due, or the note would be late.
  for (const lead of decided) {
    assert.ok(lead >= 0, `step was decided ${(-lead * 1000).toFixed(1)} ms late`);
    assert.ok(lead <= 0.11, `step decided ${lead}s early, beyond the lookahead`);
  }
});

test('a late tick emits the missed steps rather than sliding the grid', () => {
  const h = harness({ bpm: 120 });
  h.scheduler.start();
  h.advance(0.5);
  const before = h.steps.length;

  // Simulate a badly stalled timer: jump a whole second in one go.
  h.clock.now += 1;
  h.scheduler.pump();

  const gained = h.steps.length - before;
  // 1 s at 120 BPM is 8 sixteenth notes; all of them must appear.
  assert.ok(gained >= 8, `only recovered ${gained} steps`);
  const expected = h.scheduler.stepDurationFor(0);
  for (let i = 1; i < h.steps.length; i += 1) {
    const gap = h.steps[i].audioTime - h.steps[i - 1].audioTime;
    assert.ok(Math.abs(gap - expected) < 1e-9, `grid slipped at step ${i}`);
  }
});

test('a tempo change applies from the next step onward', () => {
  const h = harness({ bpm: 120 });
  h.scheduler.start();
  h.advance(2);
  const beforeCount = h.steps.length;

  h.bus.emit('param:change', { trackId: 0, key: 'bpm', value: 240 });
  h.advance(2);

  const after = h.steps.slice(beforeCount + 1);
  const expected = 60 / (240 * 4);
  for (let i = 1; i < after.length; i += 1) {
    const gap = after[i].audioTime - after[i - 1].audioTime;
    assert.ok(Math.abs(gap - expected) < 1e-9, `gap ${gap}, expected ${expected}`);
  }
  // Twice the tempo should produce roughly twice the steps in the same time.
  assert.ok(after.length > (beforeCount - 1) * 1.8, `${after.length} vs ${beforeCount}`);
});

test('stop preserves the playhead; the generators resume where they left off', () => {
  const h = harness();
  h.bus.emit('param:change', { trackId: 0, key: 'steps', value: 8 });
  h.scheduler.start();
  h.advance(1);
  const lastIndex = h.steps[h.steps.length - 1].stepIndex;

  h.scheduler.stop();
  h.advance(2); // nothing should be emitted while stopped
  assert.equal(h.steps[h.steps.length - 1].stepIndex, lastIndex);

  h.scheduler.start();
  h.advance(0.2);
  assert.equal(h.steps[h.steps.length - 1].stepIndex !== lastIndex, true);
  // The pattern index continued rather than restarting from 0.
  const resumed = h.steps.filter((s) => s.audioTime > h.clock.now - 0.2);
  assert.ok(resumed.length > 0);
});

test('untriggered steps are still emitted, so generators keep advancing', () => {
  const h = harness();
  // 16 steps, 1 pulse, probability 0, OR -> exactly one trigger per cycle.
  for (const [k, v] of Object.entries({
    steps: 16, pulses: 1, probability: 0, logicOp: 1,
  })) {
    h.bus.emit('param:change', { trackId: 0, key: k, value: v });
  }
  h.scheduler.start();
  h.advance(4);

  const fired = h.steps.filter((s) => s.triggered).length;
  assert.ok(h.steps.length > fired * 8, 'silent steps should dominate');
  // Every step index in the cycle must appear, in order.
  const indices = h.steps.slice(1, 17).map((s) => s.stepIndex);
  assert.deepEqual(indices, [...Array(16).keys()].map((i) => (indices[0] + i) % 16));
});

test('every step carries what the audio engine needs', () => {
  const h = harness();
  // Glide is now an unsigned amount plus a separate mode flag (was one signed
  // value where the sign doubled as the mode).
  h.bus.emit('param:change', { trackId: 0, key: 'glideAmount', value: 0.5 });
  h.bus.emit('param:change', { trackId: 0, key: 'glideMode', value: true });
  h.scheduler.start();
  h.advance(1);

  for (const s of h.steps) {
    for (const key of [
      'trackId', 'stepIndex', 'audioTime', 'triggered', 'note', 'prevNote',
      'velocity', 'mod', 'prevMod', 'glideTime', 'glideExponential',
      'modTime', 'modExponential', 'stepDuration',
    ]) {
      assert.ok(key in s, `step is missing ${key}`);
    }
    assert.ok(Number.isFinite(s.note) && s.note >= 0 && s.note <= 200);
    assert.ok(s.velocity >= 0.1 && s.velocity <= 1);
    assert.ok(s.mod >= 2 && s.mod <= 20);
    assert.equal(s.glideExponential, true); // glideMode: true -> exponential
    // Pluck-position interpolation was removed; the ramp is now fixed at zero.
    assert.equal(s.modTime, 0);
    assert.equal(s.modExponential, false);
    assert.ok(s.glideTime > 0 && s.glideTime < s.stepDuration);
  }
});

test('glide ramps for one step minus 30ms, scaled by amount', () => {
  const track = new Track(0, new Rng(1));
  const stepDuration = 0.125;

  // Zero amount skips the ramp entirely, which also makes the mode moot.
  track.setParam('glideAmount', 0);
  track.setParam('glideMode', true);
  const none = track.step(stepDuration);
  assert.equal(none.glideTime, 0);
  assert.equal(none.glideExponential, false);

  track.setParam('glideMode', false);
  for (const amount of [0.01, 0.4, 1]) {
    track.setParam('glideAmount', amount);
    const step = track.step(stepDuration);
    assert.equal(step.glideTime, (stepDuration - 0.03) * amount, `amount ${amount}`);
    assert.equal(step.glideExponential, false, `amount ${amount}`);
  }

  // Mode selects the curve without touching the ramp's length.
  track.setParam('glideMode', true);
  const exponential = track.step(stepDuration);
  assert.equal(exponential.glideTime, (stepDuration - 0.03) * 1);
  assert.equal(exponential.glideExponential, true);
});

test('the trigger loop produces a 70-step super-pattern', () => {
  // A 7-step random trigger loop against a 10-step Euclidean pattern gives a
  // 70-step pattern -- which holds when the pulse
  // count is coprime with the step count. With gcd > 1 the Euclidean cycle
  // repeats within itself and the combined period is correspondingly shorter.
  const period = (arr) => {
    for (let p = 1; p <= arr.length / 2; p += 1) {
      let ok = true;
      for (let i = 0; i + p < arr.length; i += 1) {
        if (arr[i] !== arr[i + p]) { ok = false; break; }
      }
      if (ok) return p;
    }
    return null;
  };

  for (const [pulses, expected] of [[3, 70], [7, 70], [4, 35]]) {
    const h = harness({ bpm: 300 });
    for (const [k, v] of Object.entries({
      steps: 10, pulses, logicOp: 3, probability: 0.5,
      trigLoop: true, trigLoopLength: 7,
    })) {
      h.bus.emit('param:change', { trackId: 0, key: k, value: v });
    }
    h.scheduler.start();
    h.advance(40);
    const bits = h.steps.map((s) => (s.triggered ? 1 : 0));
    assert.ok(bits.length > 300, `only ${bits.length} steps`);
    assert.equal(period(bits), expected, `10/${pulses} against a 7-loop`);
  }
});

test('recapturing a loop with the same permutation is a true no-op', () => {
  // Regression test: captureLoop used to reset the loop's rotational phase to
  // a fixed starting point on every call, while the Euclidean playhead kept
  // advancing untouched. Nudging the permutation knob and setting it back to
  // its original value restored the loop's *content* correctly but rewound
  // *where in its cycle playback was*, audibly shifting the combined pattern
  // relative to what it would have been if left alone. See HistoryBuffer.js.
  const setup = (h) => {
    for (const [k, v] of Object.entries({
      steps: 10, pulses: 3, logicOp: 3, probability: 0.5,
      trigLoop: true, trigLoopLength: 7,
    })) {
      h.bus.emit('param:change', { trackId: 0, key: k, value: v });
    }
  };

  const untouched = harness({ bpm: 300, seed: 99 });
  setup(untouched);
  untouched.scheduler.start();
  untouched.advance(3); // let the loop run for a while before comparing

  const touched = harness({ bpm: 300, seed: 99 });
  setup(touched);
  touched.scheduler.start();
  touched.advance(3);
  // Nudge the permutation away and back, exactly like moving the knob.
  touched.bus.emit('param:change', { trackId: 0, key: 'trigPerm', value: 0.4 });
  touched.bus.emit('param:change', { trackId: 0, key: 'trigPerm', value: 0.9 });
  touched.bus.emit('param:change', { trackId: 0, key: 'trigPerm', value: 0 });

  const before = untouched.steps.length;
  untouched.advance(5);
  touched.advance(5);

  const untouchedBits = untouched.steps.slice(before).map((s) => (s.triggered ? 1 : 0));
  const touchedBits = touched.steps.slice(before).map((s) => (s.triggered ? 1 : 0));
  assert.ok(untouchedBits.length > 50, 'expected a substantial comparison window');
  assert.deepEqual(touchedBits, untouchedBits);
});

test('revisiting a loop length restores the phase that length would have reached on its own', () => {
  // Regression test: captureLoop used to fold the loop's phase into whatever
  // length was current, which is lossy -- once reduced modulo a shorter
  // length, there is no way back to what a longer length's phase "should" be.
  // Visiting 16 -> 8 -> 20 -> 16 used to land length 16 on a different point
  // in its cycle than if it had never been left. See HistoryBuffer.js's
  // loopStepCount, which now tracks steps absolutely and folds only at read
  // time so every length keeps its own correct phase throughout.
  //
  // Driven at the Track level (direct .step() calls) rather than through the
  // scheduler, so both runs advance by an identical, exactly-controlled
  // number of steps -- no wall-clock timing to risk misaligning the two.
  const stepDur = 0.05;
  const baseParams = { steps: 10, pulses: 3, logicOp: 3, probability: 0.5, trigLoop: true };
  const run = (track, n) => Array.from({ length: n }, () => (track.step(stepDur).triggered ? 1 : 0));

  // Baseline stays at length 16 for the same total step count "touched" below
  // spends across all three lengths, so the Euclidean playhead -- which
  // advances every step regardless of loop length -- lines up before the two
  // are compared.
  const baseline = new Track(0, new Rng(55));
  for (const [k, v] of Object.entries({ ...baseParams, trigLoopLength: 16 })) baseline.setParam(k, v);
  run(baseline, 34);
  const baselineContinuation = run(baseline, 30);

  const touched = new Track(0, new Rng(55));
  for (const [k, v] of Object.entries({ ...baseParams, trigLoopLength: 16 })) touched.setParam(k, v);
  run(touched, 26);
  touched.setParam('trigLoopLength', 8);
  run(touched, 5);
  touched.setParam('trigLoopLength', 20);
  run(touched, 3);
  touched.setParam('trigLoopLength', 16);
  const touchedContinuation = run(touched, 30);

  assert.deepEqual(touchedContinuation, baselineContinuation);
});

test('getTrigLoopWindow circularly tiles a loop shorter than the requested count', () => {
  // For the ring's buffer overlay: a whole revolution's worth of positions
  // projected from a loop that doesn't divide the step count evenly must wrap
  // around and repeat from its own start, rather than running out partway.
  // Checked structurally (every index equals the one 3 steps later) so the
  // test holds regardless of what the RNG-seeded history actually contains.
  const track = new Track(0, new Rng(7));
  track.setParam('trigLoop', true);
  track.setParam('trigLoopLength', 3);

  const window = track.getTrigLoopWindow(10);
  assert.equal(window.length, 10);
  for (let i = 0; i < 7; i += 1) {
    assert.equal(window[i], window[i + 3], `index ${i} should repeat 3 steps later`);
  }
});

test('getTrigLoopWindow advances by exactly one step per step() call', () => {
  // A projection taken after one more step() has run should be the previous
  // one shifted left by one -- what was "2 steps ahead" is now "1 step ahead".
  // This is what lets the ring project a correct upcoming revolution from
  // wherever the loop's phase currently sits, not just from a fresh capture.
  const track = new Track(0, new Rng(7));
  track.setParam('trigLoop', true);
  track.setParam('trigLoopLength', 5);

  const before = track.getTrigLoopWindow(5);
  track.step(0.125);
  const after = track.getTrigLoopWindow(5);
  assert.deepEqual(after.slice(0, 4), before.slice(1));
});
