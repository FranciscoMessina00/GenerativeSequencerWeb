import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENTS, INSTRUMENT_GROUPS, instrumentById } from '../src/audio/instruments.js';
import { PARAM_SCHEMA, defaultsFor, paramSpec } from '../src/core/paramSchema.js';
import { midiToHz } from '../src/audio/modal/modalModel.js';

/** A step of the shape Track.step() returns, spread with what Scheduler adds. */
const STEP = {
  trackId: 0, stepIndex: 0, triggered: true, euclidBit: 1, randomBit: 0,
  note: 51, prevNote: 48, velocity: 0.55, mod: 4, prevMod: 4,
  glideTime: 0, glideExponential: false, modTime: 0, modExponential: false,
  audioTime: 1.25, stepDuration: 0.125, trackStep: 0,
};

const VOICE = defaultsFor('voice');
const SAMPLE_RATE = 48000;

// ---------------------------------------------------------------------------
// The registry is a lookup table keyed by a stored value, so its shape matters
// ---------------------------------------------------------------------------

test('each instrument\'s id is its own index', () => {
  // The index IS the stored `instrument` value, which is what lets it ride the normal
  // snapshot path. If the two ever disagree, every saved patch names the wrong voice.
  INSTRUMENTS.forEach((instrument, index) => {
    assert.equal(instrument.id, index, `${instrument.key} claims id ${instrument.id}`);
  });
});

test('the instrument param\'s range covers exactly the registry', () => {
  const spec = paramSpec('instrument');
  assert.equal(spec.min, 0);
  assert.equal(spec.max, INSTRUMENTS.length - 1, 'schema max has drifted from the registry');
  assert.deepEqual(spec.values, INSTRUMENTS.map((i) => i.id));
  assert.equal(spec.target, 'voice');
  assert.equal(spec.scope, undefined, 'each track picks its own instrument');
});

test('keys, names, groups and processors are all unique', () => {
  for (const field of ['key', 'name', 'group', 'processor']) {
    const values = INSTRUMENTS.map((i) => i[field]);
    assert.equal(new Set(values).size, values.length, `two instruments share a ${field}`);
  }
});

test('every instrument\'s group is a real schema group with controls in it', () => {
  const groups = new Set(PARAM_SCHEMA.map((s) => s.group));
  for (const instrument of INSTRUMENTS) {
    assert.ok(groups.has(instrument.group), `${instrument.key}: no such group ${instrument.group}`);
    const inGroup = PARAM_SCHEMA.filter((s) => s.group === instrument.group);
    assert.ok(inGroup.length > 0, `${instrument.group} would render as an empty panel`);
  }
  assert.deepEqual(INSTRUMENT_GROUPS, INSTRUMENTS.map((i) => i.group));
});

test('every param an instrument claims exists, is per-track, and reaches the voice', () => {
  // The list is not read by the audio path -- this test is the only reason it is
  // there, and it is the sort of thing that rots silently without one.
  for (const instrument of INSTRUMENTS) {
    for (const key of instrument.params) {
      const spec = paramSpec(key);
      assert.ok(spec, `${instrument.key} claims ${key}, which is not in the schema`);
      assert.equal(spec.target, 'voice', `${key} must reach a TrackVoice`);
      assert.equal(spec.scope, undefined, `${key} must be per-track`);
      assert.ok(key in VOICE, `${key} is missing from defaultsFor('voice')`);
    }
  }
});

test('a group\'s params belong to the instrument that claims it', () => {
  // Guards against a param landing in the Kick panel that the kick never reads.
  for (const instrument of INSTRUMENTS) {
    const inGroup = PARAM_SCHEMA
      .filter((s) => s.group === instrument.group)
      .map((s) => s.key);
    // The String group also holds modBias/modSpread, which are target:'track' -- the
    // per-step pluck-position axis, not voice settings. Everything else must be claimed.
    const unclaimed = inGroup.filter(
      (key) => paramSpec(key).target === 'voice' && !instrument.params.includes(key),
    );
    assert.deepEqual(unclaimed, [], `${instrument.group} has voice params ${instrument.key} ignores`);
  }
});

test('instrumentById falls back to something playable', () => {
  assert.equal(instrumentById(0).key, 'string');
  assert.equal(instrumentById(2).key, 'snare');
  // A patch from a future build naming an instrument this one lacks should still make
  // a sound rather than throwing on every step.
  assert.equal(instrumentById(99).key, 'string');
  assert.equal(instrumentById(-1).key, 'string');
  assert.equal(instrumentById(Number.NaN).key, 'string');
  assert.equal(instrumentById(undefined).key, 'string');
});

// ---------------------------------------------------------------------------
// Note-on builders
// ---------------------------------------------------------------------------

test('every instrument turns a step into a note-on at the step\'s own time', () => {
  for (const instrument of INSTRUMENTS) {
    const message = instrument.buildMessage(STEP, VOICE, SAMPLE_RATE);
    assert.equal(message.type, 'noteOn', instrument.key);
    // The scheduler decides steps ~100 ms early; the audio time is the whole contract
    // that makes the hit land when it was promised rather than when it was decided.
    assert.equal(message.startTime, STEP.audioTime, instrument.key);
  }
});

test('no note-on carries a non-finite number', () => {
  const walk = (value, path, seen) => {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${path} is ${value}`);
    } else if (value instanceof Float32Array || Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, seen));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, seen);
    }
  };
  for (const instrument of INSTRUMENTS) {
    walk(instrument.buildMessage(STEP, VOICE, SAMPLE_RATE), instrument.key, new Set());
  }
});

test('the string builder still sends exactly what it always did', () => {
  // It was lifted out of TrackVoice.noteOn when instruments became pluggable, so this
  // pins the message contract the modal processor reads.
  const message = INSTRUMENTS[0].buildMessage(STEP, VOICE, SAMPLE_RATE);
  assert.deepEqual(Object.keys(message).sort(), [
    'count', 'decays', 'f0From', 'f0To', 'gainsFrom', 'gainsTo',
    'glideExponential', 'glideTime', 'mFrom', 'mTo', 'modExponential', 'modTime',
    'pluckSoftness', 'ratios', 'startTime', 'type', 'velocity',
  ]);
  assert.equal(message.count, VOICE.modes);
  assert.equal(message.velocity, STEP.velocity);
  assert.equal(message.pluckSoftness, VOICE.pluckSoftness);
  // No glide on this step, so both ends are the current note rather than the previous.
  assert.equal(message.f0From, midiToHz(STEP.note));
  assert.equal(message.f0To, midiToHz(STEP.note));
  // And no mod ramp, so the two gain vectors are the same object -- the worklet's
  // blend is then a no-op rather than a wasted interpolation.
  assert.equal(message.gainsFrom, message.gainsTo);
});

test('the string builder glides from the previous note when asked', () => {
  const gliding = { ...STEP, glideTime: 0.05, prevNote: 40 };
  const message = INSTRUMENTS[0].buildMessage(gliding, VOICE, SAMPLE_RATE);
  assert.equal(message.f0From, midiToHz(40), 'a glide starts where the last note was');
  assert.equal(message.f0To, midiToHz(STEP.note));
});

test('each builder reaches only for its own instrument\'s params', () => {
  // A track's bag carries every instrument's settings. Handing a processor a key it
  // does not understand is harmless, but it means the panel and the sound can
  // disagree -- so each message must be built from the claimed params only.
  const others = (instrument) => INSTRUMENTS
    .filter((i) => i !== instrument)
    .flatMap((i) => i.params)
    .filter((key) => !instrument.params.includes(key));

  for (const instrument of INSTRUMENTS) {
    const sabotaged = { ...VOICE };
    for (const key of others(instrument)) sabotaged[key] = Number.NaN;
    const message = instrument.buildMessage(STEP, sabotaged, SAMPLE_RATE);
    const flat = JSON.stringify(message, (_k, v) => (Number.isFinite(v) || typeof v !== 'number' ? v : 'NaN'));
    assert.ok(!flat.includes('NaN'), `${instrument.key} read another instrument's param`);
  }
});
