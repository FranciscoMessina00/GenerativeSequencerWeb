import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAM_SCHEMA } from '../src/core/paramSchema.js';
import { INFO_HINT, INFO_TEXT } from '../src/ui/infoText.js';

/**
 * The ids in infoText.js that are not param keys: controls with no schema entry,
 * plus the two generic fallbacks for BiasSpreadSlider's generated `<key>.min` /
 * `<key>.max` range edges. Listed here rather than inferred so that a typo'd key
 * fails the orphan check below instead of quietly never being displayed.
 */
const NON_PARAM_IDS = new Set([
  'axisLock',
  'lfoScope',
  'lfoMap',
  'lfoClear',
  'range.min',
  'range.max',
  'play',
  'pluck',
  'reseed',
  'presetSlots',
  'presetLoad',
  'ring',
]);

/** Long enough for a clause, short enough that the footer stays glanceable. */
const MAX_LENGTH = 140;

test('every parameter has a description', () => {
  // The guard that makes the info footer scale: a new param cannot ship without
  // one line of copy, because this fails until it has one.
  const missing = PARAM_SCHEMA.map((s) => s.key).filter((key) => !INFO_TEXT[key]);
  assert.deepEqual(missing, [], `params with no info text: ${missing.join(', ')}`);
});

test('no description is orphaned', () => {
  // The other direction: an id that matches neither a param key nor a declared
  // non-param control would never be shown, which is almost always a typo.
  const keys = new Set(PARAM_SCHEMA.map((s) => s.key));
  const orphans = Object.keys(INFO_TEXT).filter(
    (id) => !keys.has(id) && !NON_PARAM_IDS.has(id),
  );
  assert.deepEqual(orphans, [], `info text nothing can reach: ${orphans.join(', ')}`);
});

test('descriptions are single-line and stay within the footer budget', () => {
  for (const [id, text] of Object.entries(INFO_TEXT)) {
    assert.equal(typeof text, 'string', id);
    assert.ok(text.trim().length > 0, `${id} is empty`);
    assert.equal(text, text.trim(), `${id} has surrounding whitespace`);
    // A newline would be silently swallowed by the bar's `white-space: nowrap`.
    assert.ok(!/[\n\r\t]/.test(text), `${id} contains a line break or tab`);
    assert.ok(text.length <= MAX_LENGTH, `${id} is ${text.length} chars, over ${MAX_LENGTH}`);
  }
});

test('the idle hint is present, so the bar never sits empty', () => {
  assert.equal(typeof INFO_HINT, 'string');
  assert.ok(INFO_HINT.trim().length > 0);
  assert.ok(INFO_HINT.length <= MAX_LENGTH);
});

test('the dotted-id convention is respected', () => {
  // A dot means "generated sub-key, resolved through range.<suffix>". Hand-written
  // ids must not use one, or the fallback rule stops being unambiguous.
  const dotted = Object.keys(INFO_TEXT).filter((id) => id.includes('.'));
  assert.deepEqual(dotted.sort(), ['range.max', 'range.min']);
});
