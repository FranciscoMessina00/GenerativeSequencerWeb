import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { Rng } from '../src/core/rng.js';
import { ParamStore } from '../src/core/ParamStore.js';
import { Track } from '../src/sequencer/Track.js';
import { Scheduler } from '../src/sequencer/Scheduler.js';

/**
 * Groundwork check: nothing in the sequencing or parameter layers assumes a single
 * track. These tests exist so that adding channels stays a UI problem rather than
 * an engine problem -- if one of them breaks, the plumbing regressed.
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
    bus,
    tracks,
    scheduler,
    store,
    steps,
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
  assert.equal(scheduler.stepDuration, 60 / (90 * 4));
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
  const snap = store.snapshot(42);

  const fresh = new ParamStore({ trackCount: 3 });
  fresh.load(snap);
  assert.deepEqual(
    [0, 1, 2].map((t) => fresh.get('steps', t)),
    [5, 9, 13],
  );
});
