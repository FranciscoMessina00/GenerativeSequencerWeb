import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { Rng } from '../src/core/rng.js';
import { ParamStore } from '../src/core/ParamStore.js';
import { paramSpec } from '../src/core/paramSchema.js';
import { Track } from '../src/sequencer/Track.js';
import { Scheduler } from '../src/sequencer/Scheduler.js';
import { Modulation } from '../src/modulation/Modulation.js';
import { MOD_TARGETS } from '../src/modulation/modTargets.js';

/**
 * Groundwork check: nothing in the sequencing, parameter or modulation layers
 * assumes a single track. These tests exist so that adding channels stays a UI
 * problem rather than an engine problem -- if one of them breaks, the plumbing
 * regressed.
 */

const NULL_TICKER = { start() {}, stop() {}, dispose() {} };

function harness({ trackCount = 2, bpm = 120 } = {}) {
  const bus = new EventBus();
  // Separate Rng per track: a shared one would couple their random walks, so each
  // track's stream has to be its own.
  const tracks = Array.from({ length: trackCount }, (_, i) => new Track(i, new Rng(1000 + i)));
  let now = 0;
  const scheduler = new Scheduler({
    bus,
    getCurrentTime: () => now,
    tracks,
    ticker: NULL_TICKER,
  });
  /** Everything the engines were told, so per-track routing can be inspected. */
  const written = [];
  const store = new ParamStore({
    bus,
    trackCount,
    route: (key, value, trackId, spec) => {
      written.push({ key, value, trackId, target: spec.target });
      if (spec.target === 'track') tracks[trackId]?.setParam(key, value);
      else if (spec.target === 'transport') scheduler.setParam(key, value);
    },
  });
  store.set('bpm', bpm);

  const steps = [];
  bus.on('step', (s) => steps.push(s));
  return {
    bus,
    tracks,
    scheduler,
    store,
    steps,
    written,
    // Explicit, so a test can configure patterns before the clock emits anything --
    // start() itself pumps once.
    start: () => scheduler.start(),
    advance: (dt) => { now += dt; scheduler.pump(); },
  };
}

test('each track keeps its own pattern', () => {
  const { tracks, store } = harness();

  store.set('steps', 16, 0);
  store.set('pulses', 4, 0);
  store.set('steps', 12, 1);
  store.set('pulses', 7, 1);

  assert.equal(tracks[0].getPattern().length, 16);
  assert.equal(tracks[1].getPattern().length, 12);
  assert.equal(tracks[0].getPattern().filter((b) => b === 1).length, 4);
  assert.equal(tracks[1].getPattern().filter((b) => b === 1).length, 7);
});

test('a param written to one track does not leak into the other', () => {
  const { tracks, store } = harness();
  store.set('probability', 0.75, 1);
  assert.equal(tracks[0].params.probability, tracks[0].params.probability);
  assert.equal(tracks[1].params.probability, 0.75);
  assert.notEqual(tracks[0].params.probability, 0.75);
});

test('transport params are shared, since there is one clock', () => {
  const { scheduler, store } = harness();
  store.set('bpm', 90, 1);
  assert.equal(scheduler.params.bpm, 90);
  assert.equal(scheduler.stepDurationFor(0), 60 / (90 * 4));
});

test('every step is tagged with the track that produced it', () => {
  const { steps, start, advance } = harness({ trackCount: 3 });
  start();
  advance(0.3);

  assert.ok(steps.length > 0);
  for (const s of steps) {
    assert.ok(s.trackId >= 0 && s.trackId < 3, `unexpected trackId ${s.trackId}`);
  }
  // All three tracks are represented, one event each per step.
  assert.deepEqual([...new Set(steps.map((s) => s.trackId))].sort(), [0, 1, 2]);
});

test('all tracks advance on the same grid', () => {
  const { steps, start, advance } = harness({ trackCount: 2 });
  start();
  advance(0.5);

  const byTrack = new Map();
  for (const s of steps) {
    if (!byTrack.has(s.trackId)) byTrack.set(s.trackId, []);
    byTrack.get(s.trackId).push(s.audioTime);
  }
  // Same count and same times: one clock drives every track.
  assert.deepEqual(byTrack.get(0), byTrack.get(1));
});

test('tracks with different pattern lengths drift apart and realign at the LCM', () => {
  const { tracks, store, steps, start, advance } = harness({ trackCount: 2, bpm: 240 });
  store.set('steps', 4, 0);
  store.set('steps', 6, 1);
  // Deterministic triggers only, so stepIndex is the whole story.
  store.set('probability', 0, 0);
  store.set('probability', 0, 1);

  start();
  advance(6);
  const a = steps.filter((s) => s.trackId === 0).map((s) => s.stepIndex);
  const b = steps.filter((s) => s.trackId === 1).map((s) => s.stepIndex);

  assert.ok(a.length >= 12, `only ${a.length} steps captured`);
  // Both restart together only every 12 steps -- lcm(4, 6).
  for (let i = 0; i + 12 < Math.min(a.length, b.length); i += 1) {
    assert.equal(a[i], a[i + 12], 'track 0 should repeat every 12');
    assert.equal(b[i], b[i + 12], 'track 1 should repeat every 12');
  }
  assert.notDeepEqual(a.slice(0, 12), b.slice(0, 12), 'the two should not move in lockstep');
  assert.equal(tracks[0].getPattern().length, 4);
});

test('a snapshot round-trips every track independently', () => {
  const { store } = harness({ trackCount: 3 });
  store.set('steps', 5, 0);
  store.set('steps', 9, 1);
  store.set('steps', 13, 2);
  const snap = store.snapshot([42, 43, 44]);

  const fresh = new ParamStore({ trackCount: 3 });
  fresh.load(snap);
  assert.deepEqual(
    [0, 1, 2].map((t) => fresh.get('steps', t)),
    [5, 9, 13],
  );
});

// ---------------------------------------------------------------------------
// The voice and the mixer: each track's own timbre
// ---------------------------------------------------------------------------

test('voice params are per-track, so four pages hold four timbres', () => {
  const { store } = harness({ trackCount: 4 });
  store.set('stiffness', 30, 0);
  store.set('grainDryWet', 0.5, 2);

  assert.equal(store.get('stiffness', 0), 30);
  assert.equal(store.get('stiffness', 1), paramSpec('stiffness').def, 'must not leak sideways');
  assert.equal(store.get('grainDryWet', 2), 0.5);
  assert.equal(store.get('grainDryWet', 0), paramSpec('grainDryWet').def);
});

test('a voice param is routed with the trackId that owns it', () => {
  // The engine dispatches on this: get it wrong and track 3's string edits land on
  // track 1's chain.
  const { store, written } = harness({ trackCount: 4 });
  written.length = 0;
  store.set('decay', 2, 3);

  assert.deepEqual(written, [{ key: 'decay', value: 2, trackId: 3, target: 'voice' }]);
});

test('every track starts muted, so four of them cannot stack up on load', () => {
  const { store } = harness({ trackCount: 4 });
  assert.deepEqual(
    [0, 1, 2, 3].map((t) => store.get('mute', t)),
    [true, true, true, true],
  );
  // Unmuting one leaves the others alone -- mute is per-track like everything else.
  store.set('mute', false, 0);
  assert.deepEqual(
    [0, 1, 2, 3].map((t) => store.get('mute', t)),
    [false, true, true, true],
  );
});

test('only the tempo and the master fader are shared', () => {
  const { store } = harness({ trackCount: 4 });
  store.set('bpm', 90, 3);
  store.set('masterGain', 0.5, 2);
  // Written via one track, readable from every track: one clock, one output.
  assert.deepEqual([0, 1, 2, 3].map((t) => store.get('bpm', t)), [90, 90, 90, 90]);
  assert.deepEqual([0, 1, 2, 3].map((t) => store.get('masterGain', t)), [0.5, 0.5, 0.5, 0.5]);
});

// ---------------------------------------------------------------------------
// One LFO per track
// ---------------------------------------------------------------------------

/** Four Modulations over one store, wired the way main.js wires them. */
function lfoHarness(h) {
  const written = [];
  const modulations = h.tracks.map((track) => new Modulation({
    store: h.store,
    write: (key, value, trackId, spec) => written.push({ key, value, trackId, target: spec.target }),
    getBarSeconds: () => h.scheduler.barDuration,
    trackId: track.trackId,
  }));
  // The store routes modulation params to the matching track's LFO, as main.js does.
  h.bus.on('param:changed', ({ trackId, key, value }) => {
    if (key.startsWith('lfo')) modulations[trackId]?.setParam(key, value);
  });
  for (const m of modulations) m.setRunning(true);
  return { modulations, written };
}

test('each track has its own LFO, and it drives only its own track', () => {
  const h = harness({ trackCount: 4 });
  const { modulations, written } = lfoHarness(h);

  // Two tracks sweeping the same parameter name -- which used to be one global
  // value the two would fight over.
  for (const t of [1, 3]) {
    h.store.set('lfoTarget', MOD_TARGETS.indexOf('stiffness'), t);
    h.store.set('lfoAmount', 1, t);
  }

  written.length = 0;
  for (let i = 0; i < 4; i += 1) {
    modulations.forEach((m) => m.onStep({ audioTime: i * 0.125, stepDuration: 0.125 }));
  }

  const touched = [...new Set(written.map((w) => w.trackId))].sort();
  assert.deepEqual(touched, [1, 3], 'only the mapped tracks may be written');
  assert.ok(written.every((w) => w.key === 'stiffness'));
});

test('an unmapped track\'s LFO writes nothing at all', () => {
  const h = harness({ trackCount: 4 });
  const { modulations, written } = lfoHarness(h);
  // Amount without a target, and a target without amount: neither is a mapping.
  h.store.set('lfoAmount', 1, 0);
  h.store.set('lfoTarget', MOD_TARGETS.indexOf('decay'), 1);

  written.length = 0;
  for (const m of modulations) m.onStep({ audioTime: 0, stepDuration: 0.125 });
  assert.deepEqual(written, []);
});

test('each LFO advances on its own track\'s steps, at its own resolution', () => {
  // Track 0 runs at 1/16 and track 1 at 1/8, so over the same span track 0's LFO is
  // sampled twice as often. Both must cover the same ground: the phase is a
  // function of elapsed time, not of how many steps carried it.
  const h = harness({ trackCount: 2, bpm: 120 });
  const { modulations } = lfoHarness(h);
  for (const t of [0, 1]) h.store.set('lfoRate', 1, t);

  const span = 0.5;
  const run = (m, stepDuration) => {
    for (let t = 0; t < span - 1e-9; t += stepDuration) m.onStep({ audioTime: t, stepDuration });
  };
  run(modulations[0], span / 8);
  run(modulations[1], span / 4);

  assert.ok(Math.abs(modulations[0].phase - modulations[1].phase) < 1e-9,
    `phases diverged: ${modulations[0].phase} vs ${modulations[1].phase}`);
  // ...and they are genuinely separate objects, not one shared phase.
  modulations[0].onStep({ audioTime: span, stepDuration: 0.1 });
  assert.notEqual(modulations[0].phase, modulations[1].phase);
});

test('stopping releases every track\'s target, not just the visible one', () => {
  // An LFO left holding a modulated value would leave that param stuck away from
  // what the controls show, on a track nobody is looking at.
  const h = harness({ trackCount: 4 });
  const { modulations, written } = lfoHarness(h);
  for (const t of [0, 1, 2, 3]) {
    h.store.set('lfoTarget', MOD_TARGETS.indexOf('decay'), t);
    h.store.set('lfoAmount', 1, t);
    modulations[t].onStep({ audioTime: 0.1, stepDuration: 0.125 });
  }

  written.length = 0;
  for (const m of modulations) m.setRunning(false);

  assert.equal(written.length, 4, 'all four must hand their param back');
  assert.deepEqual([...new Set(written.map((w) => w.trackId))].sort(), [0, 1, 2, 3]);
  for (const w of written) {
    assert.equal(w.value, paramSpec('decay').def, 'restored to the stored base value');
  }
});
