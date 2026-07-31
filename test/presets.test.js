import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { Rng } from '../src/core/rng.js';
import { ParamStore, SNAPSHOT_VERSION } from '../src/core/ParamStore.js';
import { paramSpec } from '../src/core/paramSchema.js';
import { Track } from '../src/sequencer/Track.js';
import { readFileSync } from 'node:fs';
import {
  fromJSON,
  loadFactoryPresets,
  toJSON,
  validateFactoryPresets,
} from '../src/core/presets.js';

const FACTORY_FILE = new URL('../presets/factory.json', import.meta.url);
const readFactory = () => JSON.parse(readFileSync(FACTORY_FILE, 'utf8'));

function harness({ trackCount = 1 } = {}) {
  const bus = new EventBus();
  const announced = [];
  const store = new ParamStore({ bus, trackCount });
  bus.on('param:changed', (e) => announced.push(e));
  return { bus, store, announced };
}

test('a snapshot carries the version, the seed, and every scope', () => {
  const { store } = harness({ trackCount: 2 });
  store.set('steps', 12, 0);
  store.set('bpm', 145);

  const snap = store.snapshot(4242);
  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.seed, 4242);
  assert.equal(snap.global.bpm, 145);
  assert.equal(snap.tracks.length, 2);
  assert.equal(snap.tracks[0].steps, 12);
});

test('a snapshot is a copy, not a live view of the store', () => {
  const { store } = harness();
  const snap = store.snapshot(1);
  store.set('bpm', 200);
  assert.notEqual(snap.global.bpm, 200, 'mutating the store must not rewrite history');
});

test('snapshot -> load round-trips through JSON', () => {
  const { store } = harness({ trackCount: 2 });
  store.set('steps', 9, 0);
  store.set('pulses', 4, 0);
  store.set('steps', 13, 1);
  store.set('bpm', 99);
  store.set('scale', 5, 0);
  store.set('trigLoop', true, 0);
  const before = store.snapshot(777);

  // A fresh store, as if the page had just been reloaded.
  const { store: restored } = harness({ trackCount: 2 });
  const seed = restored.load(fromJSON(toJSON(before)));

  assert.equal(seed, 777);
  assert.deepEqual(restored.snapshot(777), before);
  assert.equal(restored.get('steps', 1), 13);
  assert.equal(restored.get('trigLoop', 0), true);
});

test('loading announces every param, so the whole UI can follow', () => {
  const { store } = harness({ trackCount: 1 });
  const source = harness();
  source.store.set('bpm', 133);

  const { announced } = { announced: [] };
  const bus2 = new EventBus();
  const target = new ParamStore({ bus: bus2, trackCount: 1 });
  bus2.on('param:changed', (e) => announced.push(e));

  target.load(source.store.snapshot(5));

  const trackKeyCount = Object.keys(target.trackValues[0]).length;
  const globalKeyCount = Object.keys(target.globalValues).length;
  assert.equal(announced.length, trackKeyCount + globalKeyCount);
  assert.ok(announced.some((e) => e.key === 'bpm' && e.value === 133));
  // Sanity: `store` from the first harness is untouched by the other two.
  assert.equal(store.get('bpm'), paramSpec('bpm').def);
});

test('unknown keys are ignored and missing ones keep their current value', () => {
  const { store } = harness();
  store.set('bpm', 111);

  const seed = store.load({
    version: 1,
    seed: 8,
    global: { bpm: 123, somethingRemovedLater: 42 },
    tracks: [{ steps: 5, alsoGone: 'x' }],
  });

  assert.equal(seed, 8);
  assert.equal(store.get('bpm'), 123);
  assert.equal(store.get('steps'), 5);
  // Not present in the snapshot, so it must survive untouched.
  assert.equal(store.get('pulses'), paramSpec('pulses').def);
  assert.equal(store.get('somethingRemovedLater'), undefined);
});

test('out-of-range and between-step values in a snapshot are normalised', () => {
  const { store } = harness();
  store.load({ global: { bpm: 99999 }, tracks: [{ steps: -3, velBias: 0.7777 }] });
  assert.equal(store.get('bpm'), paramSpec('bpm').max);
  assert.equal(store.get('steps'), paramSpec('steps').min);
  assert.equal(store.get('velBias'), 0.78);
});

test('a snapshot with extra tracks does not overflow a smaller store', () => {
  const { store } = harness({ trackCount: 1 });
  store.load({ tracks: [{ steps: 8 }, { steps: 9 }, { steps: 10 }] });
  assert.equal(store.trackCount, 1);
  assert.equal(store.get('steps', 0), 8);
});

test('malformed input is refused rather than thrown on', () => {
  const { store } = harness();
  assert.equal(fromJSON('{not json'), undefined);
  assert.equal(fromJSON('null'), undefined);
  assert.equal(fromJSON('7'), undefined);
  assert.equal(store.load(undefined), undefined);
  assert.equal(store.load('nope'), undefined);
  // Absent sections must not throw.
  assert.doesNotThrow(() => store.load({ version: 1 }));
});

test('a restored patch reproduces the identical step sequence', () => {
  // The point of storing the seed: same settings AND same performance.
  const play = (snapshot) => {
    const seed = snapshot.seed;
    const rng = new Rng(seed);
    const track = new Track(0, rng);
    const store = new ParamStore({
      trackCount: 1,
      route: (key, value, trackId, spec) => {
        if (spec.target === 'track') track.setParam(key, value);
      },
    });
    store.load(snapshot);
    return Array.from({ length: 48 }, () => {
      const s = track.step(0.125);
      return `${s.triggered ? 1 : 0}:${s.note}:${s.velocity.toFixed(3)}`;
    }).join(',');
  };

  const authoring = new ParamStore({ trackCount: 1 });
  authoring.set('steps', 16, 0);
  authoring.set('pulses', 7, 0);
  authoring.set('probability', 0.4, 0);
  authoring.set('noteSpread', 9, 0);
  const patch = authoring.snapshot(20240731);

  assert.equal(play(patch), play(patch), 'same patch must perform identically');

  const other = { ...patch, seed: patch.seed + 1 };
  assert.notEqual(play(patch), play(other), 'a different seed must perform differently');
});

// ---------------------------------------------------------------------------
// Factory patches
// ---------------------------------------------------------------------------

test('every entry in the shipped factory file is well-formed', () => {
  const file = readFactory();
  assert.equal(
    validateFactoryPresets(file).length,
    file.presets.length,
    'a shipped entry was rejected by validation -- it would silently vanish from the UI',
  );
});

test('the shipped Default patch has not drifted from the schema defaults', () => {
  // The file is generated from ParamStore's defaults. If someone changes a `def` in
  // paramSchema.js without regenerating, this is what says so.
  const shipped = validateFactoryPresets(readFactory()).find((p) => p.name === 'Default');
  assert.ok(shipped, 'a patch named "Default" must ship');
  assert.equal(typeof shipped.patch.seed, 'number', 'a factory patch needs a fixed seed');

  const defaults = new ParamStore({ trackCount: 1 }).snapshot(shipped.patch.seed);
  assert.deepEqual(
    shipped.patch,
    defaults,
    'presets/factory.json no longer matches the schema defaults -- regenerate it',
  );
});

test('loading the shipped Default patch returns the instrument to its defaults', () => {
  const { store } = harness();
  store.set('bpm', 210);
  store.set('steps', 3, 0);
  store.set('trigLoop', true, 0);

  const shipped = validateFactoryPresets(readFactory()).find((p) => p.name === 'Default');
  const seed = store.load(shipped.patch);

  assert.equal(seed, shipped.patch.seed);
  assert.equal(store.get('bpm'), paramSpec('bpm').def);
  assert.equal(store.get('steps'), paramSpec('steps').def);
  assert.equal(store.get('trigLoop'), paramSpec('trigLoop').def);
});

test('malformed factory entries are skipped rather than taken down the whole set', () => {
  const good = { name: 'Keeper', patch: { global: {}, tracks: [] } };
  const list = validateFactoryPresets({
    presets: [
      null,
      {},
      { name: '' },
      { name: 'no patch' },
      { patch: {} },
      { name: 'bad patch', patch: 'nope' },
      good,
    ],
  });
  assert.deepEqual(list, [good]);
});

test('a non-array or absent presets field yields an empty list', () => {
  assert.deepEqual(validateFactoryPresets(undefined), []);
  assert.deepEqual(validateFactoryPresets({}), []);
  assert.deepEqual(validateFactoryPresets({ presets: 'nope' }), []);
});

test('a failed or malformed fetch resolves empty instead of throwing', async () => {
  const original = globalThis.fetch;
  try {
    // Network failure.
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    assert.deepEqual(await loadFactoryPresets('x'), []);

    // 404.
    globalThis.fetch = () => Promise.resolve({ ok: false, json: async () => ({}) });
    assert.deepEqual(await loadFactoryPresets('x'), []);

    // 200 with unparseable body.
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.reject(new SyntaxError('bad json')),
    });
    assert.deepEqual(await loadFactoryPresets('x'), []);

    // 200 with the real file.
    const file = readFactory();
    globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => file });
    const list = await loadFactoryPresets('x');
    assert.equal(list.length, file.presets.length);
    assert.equal(list[0].name, 'Default');
  } finally {
    globalThis.fetch = original;
  }
});
