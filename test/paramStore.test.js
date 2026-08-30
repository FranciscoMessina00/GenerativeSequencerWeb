import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { ParamStore } from '../src/core/ParamStore.js';
import { PARAM_SCHEMA, normalizeParam, paramSpec } from '../src/core/paramSchema.js';

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

// ---------------------------------------------------------------------------
// Cross-parameter bounds: `maxFrom` (issue #10 -- Pulses cannot exceed Steps)
// ---------------------------------------------------------------------------

test('a bounded param is clamped to the one that bounds it', () => {
  const { store, announced } = harness();
  store.set('steps', 8);
  announced.length = 0;

  // The control could ask for 20; there are only 8 slots to put pulses in.
  assert.equal(store.set('pulses', 20), true);
  assert.equal(store.get('pulses'), 8);
  // And what is announced is the clamped value, not what was asked for -- otherwise
  // the control would redraw itself at 20 and disagree with the store.
  assert.deepEqual(announced, [{ trackId: 0, key: 'pulses', value: 8, global: false }]);
});

test('lowering the source truncates what it bounds, and says so', () => {
  const { store, routed, announced } = harness();
  store.set('pulses', 12);
  routed.length = 0;
  announced.length = 0;

  store.set('steps', 4);

  assert.equal(store.get('pulses'), 4, 'twelve pulses cannot fit four steps');
  // Both reach the engines and both are announced -- the source first, then what
  // followed from it.
  assert.deepEqual(routed, [
    { key: 'steps', value: 4, trackId: 0 },
    { key: 'pulses', value: 4, trackId: 0 },
  ]);
  assert.deepEqual(announced.map((e) => e.key), ['steps', 'pulses']);
  assert.deepEqual(announced.map((e) => e.value), [4, 4]);
});

test('raising the source again does not put back what was truncated', () => {
  // Truncation loses the old value, which is what issue #10 asks for -- restoring it
  // would mean the store remembering a number the user can no longer see.
  const { store } = harness();
  store.set('pulses', 12);
  store.set('steps', 4);
  store.set('steps', 16);
  assert.equal(store.get('pulses'), 4);
});

test('a source change that takes nothing away announces only itself', () => {
  const { store, announced } = harness();
  store.set('pulses', 3);
  announced.length = 0;

  store.set('steps', 8); // still room for three pulses
  assert.deepEqual(announced.map((e) => e.key), ['steps']);
  assert.equal(store.get('pulses'), 3);
});

test('a request that clamps onto the value already held is dropped', () => {
  const { store, routed, announced } = harness();
  store.set('steps', 8);
  store.set('pulses', 20); // clamps to 8
  routed.length = 0;
  announced.length = 0;

  // 25 clamps to 8 as well, which is what is already there. It is not news.
  assert.equal(store.set('pulses', 25), false);
  assert.deepEqual(routed, []);
  assert.deepEqual(announced, []);
});

test('the bound is per track, like the values it reads', () => {
  const { store } = harness({ trackCount: 2 });
  store.set('steps', 4, 0);
  store.set('steps', 32, 1);

  store.set('pulses', 30, 0);
  store.set('pulses', 30, 1);

  assert.equal(store.get('pulses', 0), 4);
  assert.equal(store.get('pulses', 1), 30);
});

test('a snapshot cannot carry more pulses than steps, whatever order it lists them', () => {
  // Object key order is whatever the file happens to hold, so clamping as each value
  // landed would measure pulses against the *previous* steps.
  for (const bag of [{ steps: 8, pulses: 30 }, { pulses: 30, steps: 8 }]) {
    const { store } = harness();
    store.load({ version: 2, seeds: [1], global: {}, tracks: [bag] });
    assert.equal(store.get('steps'), 8, JSON.stringify(bag));
    assert.equal(store.get('pulses'), 8, JSON.stringify(bag));
  }
});

test('loading announces the truncated value, so the controls agree with it', () => {
  const { store, announced } = harness();
  store.load({ version: 2, seeds: [1], global: {}, tracks: [{ pulses: 30, steps: 8 }] });
  const pulses = announced.filter((e) => e.key === 'pulses');
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].value, 8);
});

test('a snapshot round-trips through the bound unchanged', () => {
  const { store } = harness();
  store.set('steps', 12);
  store.set('pulses', 12);
  const snap = store.snapshot([7]);

  const fresh = harness().store;
  fresh.load(snap);
  assert.equal(fresh.get('steps'), 12);
  assert.equal(fresh.get('pulses'), 12, 'a value already at its ceiling must survive');
});

test('every maxFrom names a real param it can actually be measured against', () => {
  for (const spec of PARAM_SCHEMA) {
    if (!spec.maxFrom) continue;
    const source = paramSpec(spec.maxFrom);
    assert.ok(source, `${spec.key} is bounded by ${spec.maxFrom}, which does not exist`);
    assert.equal(source.scope, spec.scope, `${spec.key} and ${spec.maxFrom} must share a scope`);
    assert.equal(source.type, undefined, `${spec.maxFrom} must be numeric to bound anything`);
    assert.ok(Number.isFinite(source.def), `${spec.maxFrom} needs a numeric default`);
  }
});

test('the maxFrom graph is acyclic, or the cascade would never return', () => {
  // set() re-sets every dependent of the key it just wrote, and those cascade in turn.
  // A cycle would recurse until the stack gave out, so it is worth failing here rather
  // than on the first drag that happens to trip it.
  for (const spec of PARAM_SCHEMA) {
    const seen = new Set();
    let at = spec;
    while (at?.maxFrom) {
      assert.ok(!seen.has(at.key), `${spec.key} sits on a maxFrom cycle`);
      seen.add(at.key);
      at = paramSpec(at.maxFrom);
    }
  }
});
