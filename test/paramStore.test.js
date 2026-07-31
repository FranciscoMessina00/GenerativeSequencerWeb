import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { ParamStore } from '../src/core/ParamStore.js';
import { normalizeParam, paramSpec } from '../src/core/paramSchema.js';

function harness({ trackCount = 1 } = {}) {
  const bus = new EventBus();
  const routed = [];
  const announced = [];
  const store = new ParamStore({
    bus,
    trackCount,
    route: (key, value, trackId) => routed.push({ key, value, trackId }),
  });
  bus.on('param:changed', (e) => announced.push(e));
  return { bus, store, routed, announced };
}

test('normalizeParam clamps and snaps to the declared step', () => {
  // Between steps: 0.5537 is not a reachable velocity, 0.55 is.
  assert.equal(normalizeParam('velBias', 0.5537), 0.55);
  // Integer params land on integers.
  assert.equal(normalizeParam('steps', 7.6), 8);
  // Out of range clamps to the declared bounds.
  assert.equal(normalizeParam('steps', 999), paramSpec('steps').max);
  assert.equal(normalizeParam('steps', -5), paramSpec('steps').min);
  // Toggles become real booleans, whatever arrives.
  assert.equal(normalizeParam('trigLoop', 1), true);
  assert.equal(normalizeParam('trigLoop', 0), false);
});

test('normalizeParam leaves no float dust', () => {
  // 0.1-step params are where multiplication artefacts show up.
  for (const raw of [4.1, 4.2, 4.3, 12.7, 0.3]) {
    const v = normalizeParam('modBias', raw);
    assert.equal(v, Number(v.toFixed(1)), `${raw} -> ${v}`);
  }
});

test('unknown keys and non-finite values cannot corrupt the store', () => {
  const { store } = harness();
  assert.equal(store.set('notAParam', 5), false);
  assert.equal(store.get('notAParam'), undefined);

  store.set('bpm', Number.NaN);
  assert.equal(store.get('bpm'), paramSpec('bpm').def);
});

test('defaults come from the schema', () => {
  const { store } = harness();
  assert.equal(store.get('steps'), paramSpec('steps').def);
  assert.equal(store.get('bpm'), paramSpec('bpm').def);
  assert.equal(store.get('masterGain'), paramSpec('masterGain').def);
});

test('a committed change routes once and announces once', () => {
  const { store, routed, announced } = harness();
  assert.equal(store.set('bpm', 140), true);
  assert.equal(store.get('bpm'), 140);
  assert.deepEqual(routed, [{ key: 'bpm', value: 140, trackId: 0 }]);
  assert.deepEqual(announced, [{ trackId: 0, key: 'bpm', value: 140, global: true }]);
});

test('announcements carry scope, so a track-bound listener still sees globals', () => {
  const { store, announced } = harness({ trackCount: 2 });

  // A global param, requested via track 1.
  store.set('bpm', 145, 1);
  assert.equal(announced.at(-1).global, true, 'bpm is global regardless of trackId');

  // A per-track param.
  store.set('steps', 9, 1);
  assert.equal(announced.at(-1).global, false);
  assert.equal(announced.at(-1).trackId, 1);
});

test('an unchanged value is dropped before routing or announcing', () => {
  const { store, routed, announced } = harness();
  store.set('bpm', 140);
  routed.length = 0;
  announced.length = 0;

  // The same value again -- this is the control's own echo coming back.
  assert.equal(store.set('bpm', 140), false);
  // And a value that normalises onto the one already held.
  assert.equal(store.set('bpm', 140.4), false);

  assert.deepEqual(routed, [], 'engines must not be re-written');
  assert.deepEqual(announced, [], 'no echo means no sync loop');
});

test('silent writes route but stay quiet', () => {
  const { store, routed, announced } = harness();
  assert.equal(store.set('bpm', 90, 0, { silent: true }), true);
  assert.equal(store.get('bpm'), 90);
  assert.equal(routed.length, 1);
  assert.deepEqual(announced, []);
});

test('track params are per-track; global params are not forked', () => {
  const { store } = harness({ trackCount: 3 });

  store.set('steps', 12, 0);
  store.set('steps', 7, 1);
  assert.equal(store.get('steps', 0), 12);
  assert.equal(store.get('steps', 1), 7);
  assert.equal(store.get('steps', 2), paramSpec('steps').def, 'untouched track keeps its default');

  // bpm is transport-scoped, so the trackId is irrelevant to where it lands.
  store.set('bpm', 150, 2);
  assert.equal(store.get('bpm', 0), 150);
  assert.equal(store.get('bpm', 1), 150);
});

test('writes to a track that does not exist are refused', () => {
  const { store, routed } = harness({ trackCount: 1 });
  assert.equal(store.set('steps', 9, 4), false);
  assert.deepEqual(routed, []);
});

test('the announced value is the normalised one, not the raw input', () => {
  const { store, announced } = harness();
  // 0.6237 is between steps and differs from the default, so it must both snap
  // and survive the dedupe.
  store.set('velBias', 0.6237);
  assert.deepEqual(announced, [{ trackId: 0, key: 'velBias', value: 0.62, global: false }]);
});

test('syncAll re-routes every held value, including unchanged ones', () => {
  const { store, routed, announced } = harness({ trackCount: 2 });
  routed.length = 0;
  announced.length = 0;

  store.syncAll();

  // Every param exists once per scope: globals once, track params once per track.
  const trackKeyCount = Object.keys(store.trackValues[0]).length;
  const globalKeyCount = Object.keys(store.globalValues).length;
  assert.equal(routed.length, globalKeyCount + trackKeyCount * 2);
  assert.equal(announced.length, routed.length);

  // And it reports values, not undefined.
  assert.ok(routed.every((r) => r.value !== undefined));
});
