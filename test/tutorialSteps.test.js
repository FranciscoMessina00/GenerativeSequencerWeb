import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PARAM_SCHEMA, normalizeParam, paramSpec } from '../src/core/paramSchema.js';
import { TRACK_COUNT } from '../src/core/ParamStore.js';
import { INFO_TEXT } from '../src/ui/infoText.js';
import { TUTORIAL_CHAPTERS, TUTORIAL_STEPS } from '../src/ui/tutorialSteps.js';

/**
 * The shape of the guided tour.
 *
 * tutorialSteps.js is data, and the same guard rail infoText.js gets applies here for
 * the same reason: a card that points at a control which no longer exists, or
 * demonstrates a value the store would quietly clamp, is a defect nobody notices until
 * a stranger runs the tour. None of this needs a DOM, which is why the data file has
 * no imports.
 *
 * What is deliberately NOT checked here: whether a `selector` matches anything on the
 * real page. That needs a built page. The overlay's own machinery is checked in
 * test/browser/tutorial-check.html; the class and id names the shipped selectors rely
 * on are covered by the drift guard at the bottom of this file.
 */

/**
 * Everything a class or id could be written in, as one string.
 *
 * The tour's region selectors -- `.trig-row`, `.tab__head`, `#infobar` -- name classes
 * that are set in a widget's constructor, in main.js, or in index.html, and nothing
 * else in the codebase would break if one were renamed. Reading the shipped source and
 * looking for the literal name is the same trick test/workletEnvelope.test.js uses on
 * the duplicated worklet DSP, and it costs one file read.
 */
function shippedSource() {
  const root = new URL('../', import.meta.url);
  const walk = (dir) => readdirSync(new URL(dir, root), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? walk(`${dir}${entry.name}/`)
      : (entry.name.endsWith('.js') ? [`${dir}${entry.name}`] : [])));
  const files = ['index.html', 'styles/main.css', ...walk('src/')];
  return files.map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n');
}

/** Long enough for a real explanation, short enough that the card is not a wall. */
const MAX_BODY = 340;
const MAX_TITLE = 48;

test('every step is identifiable', () => {
  const ids = TUTORIAL_STEPS.map((s) => s.id);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.equal(typeof id, 'string');
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${id} is not kebab-case`);
  }
  assert.equal(new Set(ids).size, ids.length, 'two steps share an id');
});

test('chapters are contiguous', () => {
  // "Skip chapter" walks forward to the first card with a different chapter name, so a
  // chapter appearing in two separate runs would strand the reader in the second one.
  const runs = [];
  for (const step of TUTORIAL_STEPS) {
    if (runs[runs.length - 1] !== step.chapter) runs.push(step.chapter);
  }
  assert.deepEqual(runs, TUTORIAL_CHAPTERS, 'a chapter is split across the list');
  assert.equal(new Set(TUTORIAL_CHAPTERS).size, TUTORIAL_CHAPTERS.length);
});

test('the tour opens and closes on a card with nothing to point at', () => {
  // Both are deliberate: there is nothing worth spotlighting before the reader knows
  // what they are looking at, and the closing card is about the instrument as a whole.
  const first = TUTORIAL_STEPS[0];
  const last = TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1];
  for (const step of [first, last]) {
    assert.equal(step.target, undefined, `${step.id} points at something`);
    assert.equal(step.selector, undefined, `${step.id} points at something`);
  }
});

test('a step points one way or the other, never both', () => {
  for (const step of TUTORIAL_STEPS) {
    const ways = ['target', 'selector'].filter((k) => step[k] !== undefined);
    assert.ok(ways.length <= 1, `${step.id} has both target and selector`);
    if (step.target !== undefined) assert.equal(typeof step.target, 'string');
    if (step.selector !== undefined) assert.equal(typeof step.selector, 'string');
  }
});

test('a target is something the info footer also describes', () => {
  // `target` is a data-info id, which is the same id the footer looks up. Holding the
  // tour to ids that exist there means a card cannot point at a control the rest of
  // the app has forgotten about, and keeps the two bodies of copy about one control
  // from drifting apart.
  const unknown = TUTORIAL_STEPS
    .filter((s) => s.target && !INFO_TEXT[s.target])
    .map((s) => `${s.id} -> ${s.target}`);
  assert.deepEqual(unknown, [], `targets with no info text: ${unknown.join(', ')}`);
});

test('every value a card demonstrates is one the store would keep', () => {
  const keys = new Set(PARAM_SCHEMA.map((s) => s.key));
  for (const step of TUTORIAL_STEPS) {
    for (const [key, value] of Object.entries(step.set ?? {})) {
      assert.ok(keys.has(key), `${step.id} sets unknown param ${key}`);
      // The real check: normalizeParam clamps to the range and snaps to the step, so a
      // value that survives it unchanged is one the reader will actually see. A card
      // claiming "I have set decay to 5000 ms" while the store holds 4000 is a lie
      // told by the copy, and this is what catches it.
      assert.equal(
        normalizeParam(key, value),
        value,
        `${step.id}: ${key} = ${value} is outside its range or between its steps`,
      );
    }
  }
});

test('a card writes to a track that exists', () => {
  for (const step of TUTORIAL_STEPS) {
    for (const field of ['track', 'show']) {
      if (step[field] === undefined) continue;
      assert.ok(Number.isInteger(step[field]), `${step.id}.${field} is not an integer`);
      assert.ok(step[field] >= 0 && step[field] < TRACK_COUNT, `${step.id}.${field} is out of range`);
    }
  }
});

test('the transport is started once, on the card that says so', () => {
  const playing = TUTORIAL_STEPS.filter((s) => s.play);
  assert.equal(playing.length, 1, 'exactly one card starts the transport');
  assert.equal(playing[0].id, 'play');
});

test('a per-track card never writes a global parameter to a track', () => {
  // bpm and masterGain are single-valued; writing one "on track 1" would work by
  // accident (the store ignores the trackId for them) and read as a bug forever after.
  for (const step of TUTORIAL_STEPS) {
    if (!step.track) continue;
    for (const key of Object.keys(step.set ?? {})) {
      assert.notEqual(paramSpec(key).scope, 'global', `${step.id} sets global ${key} on track ${step.track}`);
    }
  }
});

test('the copy fits on a card', () => {
  for (const step of TUTORIAL_STEPS) {
    assert.equal(typeof step.chapter, 'string');
    assert.ok(step.chapter.trim().length > 0, `${step.id} has no chapter`);
    assert.equal(step.title, step.title.trim(), `${step.id} title has surrounding whitespace`);
    assert.equal(step.body, step.body.trim(), `${step.id} body has surrounding whitespace`);
    assert.ok(step.title.length <= MAX_TITLE, `${step.id} title is ${step.title.length} chars`);
    assert.ok(step.body.length <= MAX_BODY, `${step.id} body is ${step.body.length} chars`);
    // The card renders through textContent, so a line break would be collapsed to a
    // space and a tab would vanish -- either way, not what was written.
    assert.ok(!/[\n\r\t]/.test(step.body), `${step.id} body contains a line break or tab`);
  }
});

test('the tour covers the ground the issue asks for', () => {
  // Issue #13: start on the first channel in melody terms, then the other channels --
  // how to switch them on and off, and that there are other instruments to reach for.
  // Named cards rather than a count, so trimming the tour has to be a decision.
  const ids = new Set(TUTORIAL_STEPS.map((s) => s.id));
  for (const id of ['ring', 'steps', 'pulses', 'notes', 'scale', 'instrument', 'envelope', 'channels', 'switch-page']) {
    assert.ok(ids.has(id), `the tour no longer covers ${id}`);
  }
  // The melody comes before the other channels, which is the order the issue asks for.
  const at = (id) => TUTORIAL_STEPS.findIndex((s) => s.id === id);
  assert.ok(at('notes') < at('channels'), 'the melody is explained before the other channels');
  assert.ok(at('channels') < at('switch-page'), 'muting is explained before switching page');
});

test('no card overwrites a parameter an earlier card demonstrated', () => {
  // The rule that lets the reader stop and play. A card writes only the parameter it
  // introduces; nothing re-states an earlier value, and no chapter opens by dialling
  // the previous one back to a baseline. Without this the tour hands someone a control,
  // invites them to drag it, and then takes the result away four cards later.
  const seen = new Map();
  for (const step of TUTORIAL_STEPS) {
    for (const key of Object.keys(step.set ?? {})) {
      const at = `${key} on track ${step.track ?? 0}`;
      assert.ok(!seen.has(at), `${step.id} rewrites ${at}, already set by ${seen.get(at)}`);
      seen.set(at, step.id);
    }
  }
});

test('the copy carries no em dashes', () => {
  // House style for the tour, and a rule a spellcheck will not enforce. Cards are
  // written with commas, semicolons and colons instead.
  for (const step of TUTORIAL_STEPS) {
    for (const field of ['title', 'body', 'chapter']) {
      assert.ok(!step[field].includes('—'), `${step.id}: em dash in ${field}`);
    }
  }
});

test('every name a region selector relies on still exists in the source', () => {
  // A drift guard, not a proof: it cannot tell whether `.tab:nth-child(2)` finds the
  // second tab, only that something in the codebase still calls something `tab`. What
  // it does catch is the failure that would otherwise be silent -- a class renamed in
  // a widget, leaving a card spotlighting nothing with no test anywhere complaining.
  const source = shippedSource();
  for (const step of TUTORIAL_STEPS) {
    if (!step.selector) continue;
    // Class and id names...
    const names = [...step.selector.matchAll(/[.#]([A-Za-z][\w-]*)/g)].map((m) => m[1]);
    for (const name of names) {
      assert.ok(source.includes(name), `${step.id}: nothing is called "${name}" any more`);
    }
    // ...and attribute names. A `data-x` attribute is almost always written as
    // `dataset.x` in JS, so either spelling counts -- see UIController's renderGroups,
    // which is what puts data-group on an instrument panel.
    const attrs = [...step.selector.matchAll(/\[([a-z][\w-]*)[=\]]/g)].map((m) => m[1]);
    for (const attr of attrs) {
      const asDataset = `dataset.${attr.replace(/^data-/, '')}`;
      assert.ok(
        source.includes(attr) || source.includes(asDataset),
        `${step.id}: nothing sets "${attr}" any more`,
      );
    }
  }
});
