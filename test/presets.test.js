import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/EventBus.js';
import { Rng } from '../src/core/rng.js';
import { ParamStore, SNAPSHOT_VERSION, TRACK_COUNT } from '../src/core/ParamStore.js';
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

test('a snapshot carries the version, one seed per track, and every scope', () => {
  const { store } = harness({ trackCount: 2 });
  store.set('steps', 12, 0);
  store.set('bpm', 145);

  const snap = store.snapshot([4242, 99]);
  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.deepEqual(snap.seeds, [4242, 99]);
  assert.equal(snap.global.bpm, 145);
  assert.equal(snap.tracks.length, 2);
  assert.equal(snap.tracks[0].steps, 12);
});

test('the seeds array is always one per track, however many were handed in', () => {
  const { store } = harness({ trackCount: 3 });
  // Short: the missing tails are undefined rather than absent, so the array's
  // length always names the track it belongs to.
  assert.deepEqual(store.snapshot([7]).seeds, [7, undefined, undefined]);
  // Long: extras are dropped rather than describing tracks that do not exist.
  assert.deepEqual(store.snapshot([1, 2, 3, 4, 5]).seeds, [1, 2, 3]);
  assert.deepEqual(store.snapshot().seeds, [undefined, undefined, undefined]);
});

test('only bpm and masterGain are global; everything else is per-track', () => {
  // The scope cut this whole feature rests on. If a param drifts out of the
  // per-track bag, four pages silently start sharing it.
  const { store } = harness();
  assert.deepEqual(Object.keys(store.globalValues).sort(), ['bpm', 'masterGain']);
  for (const key of ['lfoShape', 'lfoAmount', 'stiffness', 'grainDryWet', 'mute', 'level']) {
    assert.ok(key in store.trackValues[0], `${key} must be per-track`);
    assert.ok(!(key in store.globalValues), `${key} must not be global`);
  }
});

test('a snapshot is a copy, not a live view of the store', () => {
  const { store } = harness();
  const snap = store.snapshot([1]);
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
  const before = store.snapshot([777, 778]);

  // A fresh store, as if the page had just been reloaded.
  const { store: restored } = harness({ trackCount: 2 });
  const seeds = restored.load(fromJSON(toJSON(before)));

  assert.deepEqual(seeds, [777, 778]);
  assert.deepEqual(restored.snapshot([777, 778]), before);
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

  target.load(source.store.snapshot([5]));

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
  store.set('pulses', 9, 0);

  const seeds = store.load({
    version: 1,
    seed: 8,
    global: { bpm: 123, somethingRemovedLater: 42 },
    tracks: [{ steps: 5, alsoGone: 'x' }],
  });

  // A version-1 patch held one scalar seed for its one track.
  assert.deepEqual(seeds, [8]);
  assert.equal(store.get('bpm'), 123);
  assert.equal(store.get('steps'), 5);
  // Absent from a bag that IS present, so it survives untouched -- unlike a whole
  // missing bag, which resets. See the next test.
  assert.equal(store.get('pulses'), 9);
  assert.equal(store.get('somethingRemovedLater'), undefined);
});

test('a track the snapshot says nothing about is reset, not left playing', () => {
  // Otherwise loading a one-track patch would leave three tracks sounding
  // whatever was last dialled in, and the patch would not describe what you hear.
  const { store } = harness({ trackCount: 3 });
  for (const t of [0, 1, 2]) {
    store.set('steps', 7, t);
    store.set('mute', false, t);
  }

  store.load({ version: 2, seeds: [1], global: {}, tracks: [{ steps: 5 }] });

  assert.equal(store.get('steps', 0), 5, 'the mentioned track takes the patch');
  for (const t of [1, 2]) {
    assert.equal(store.get('steps', t), paramSpec('steps').def, `track ${t} reset`);
    // The reset is only safe because silence is the default -- an unmentioned
    // track must not come back audible.
    assert.equal(store.get('mute', t), true, `track ${t} went quiet`);
  }
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
  // The point of storing the seeds: same settings AND same performance.
  const play = (snapshot, trackId = 0) => {
    const track = new Track(trackId, new Rng(snapshot.seeds[trackId]));
    const store = new ParamStore({
      trackCount: snapshot.tracks.length,
      route: (key, value, id, spec) => {
        if (spec.target === 'track' && id === trackId) track.setParam(key, value);
      },
    });
    store.load(snapshot);
    return Array.from({ length: 48 }, () => {
      const s = track.step(0.125);
      return `${s.triggered ? 1 : 0}:${s.note}:${s.velocity.toFixed(3)}`;
    }).join(',');
  };

  const authoring = new ParamStore({ trackCount: 2 });
  for (const t of [0, 1]) {
    authoring.set('steps', 16, t);
    authoring.set('pulses', 7, t);
    authoring.set('probability', 0.4, t);
    authoring.set('noteSpread', 9, t);
  }
  const patch = authoring.snapshot([20240731, 20240732]);

  assert.equal(play(patch), play(patch), 'same patch must perform identically');

  const other = { ...patch, seeds: [patch.seeds[0] + 1, patch.seeds[1]] };
  assert.notEqual(play(patch), play(other), 'a different seed must perform differently');

  // Identical settings, different seeds: two tracks of the same patch must not
  // play in lockstep, which is the whole reason each one owns its own Rng.
  assert.notEqual(play(patch, 0), play(patch, 1), 'per-track seeds must decouple the tracks');
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
  assert.equal(shipped.patch.tracks.length, TRACK_COUNT, 'one bag per track, or tracks go stale');
  assert.equal(shipped.patch.seeds.length, TRACK_COUNT, 'one seed per track');
  for (const seed of shipped.patch.seeds) {
    assert.equal(typeof seed, 'number', 'a factory patch needs fixed seeds');
  }

  // Defaults, with the one deliberate exception: track 0 is audible. A patch whose
  // every track was muted would load as silence, since `mute` defaults to true.
  const defaults = new ParamStore({ trackCount: TRACK_COUNT });
  defaults.set('mute', false, 0);
  assert.deepEqual(
    shipped.patch,
    defaults.snapshot(shipped.patch.seeds),
    'presets/factory.json no longer matches the schema defaults -- regenerate it',
  );
});

test('loading the shipped Default patch returns the instrument to its defaults', () => {
  const { store } = harness({ trackCount: TRACK_COUNT });
  store.set('bpm', 210);
  store.set('steps', 3, 0);
  store.set('trigLoop', true, 0);
  store.set('mute', false, 3);

  const shipped = validateFactoryPresets(readFactory()).find((p) => p.name === 'Default');
  const seeds = store.load(shipped.patch);

  assert.deepEqual(seeds, shipped.patch.seeds);
  assert.equal(store.get('bpm'), paramSpec('bpm').def);
  assert.equal(store.get('steps'), paramSpec('steps').def);
  assert.equal(store.get('trigLoop'), paramSpec('trigLoop').def);
  // Exactly one track audible, and it is the first one.
  assert.deepEqual([0, 1, 2, 3].map((t) => store.get('mute', t)), [false, true, true, true]);
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
