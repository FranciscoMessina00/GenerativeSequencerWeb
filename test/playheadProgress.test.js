import test from 'node:test';
import assert from 'node:assert/strict';
import { promote, stepProgress } from '../src/ui/playheadProgress.js';

const step = (stepIndex, audioTime, stepDuration = 0.125, patternLength = 8) =>
  ({ stepIndex, audioTime, stepDuration, patternLength });

test('progress counts steps and interpolates within one', () => {
  const s = step(0, 1);
  assert.equal(stepProgress(s, 1), 0, 'at the step\'s own time, nothing of it has passed');
  assert.equal(stepProgress(s, 1.0625), 0.0625, 'half of step 0 of 8 is 1/16 of the pattern');
  assert.equal(stepProgress(s, 1.125), 0.125, 'a whole step of 8 is 1/8');
});

test('a later step starts from its own position', () => {
  assert.equal(stepProgress(step(4, 2), 2), 0.5);
  assert.equal(stepProgress(step(4, 2), 2.0625), 0.5625);
});

test('the last step of a pattern fills to exactly 1', () => {
  const last = step(7, 3);
  assert.equal(stepProgress(last, 3), 0.875);
  assert.equal(stepProgress(last, 3.125), 1);
});

test('it clamps rather than overshooting when a step runs long', () => {
  // The transport stopping, or a late tick, can leave `now` well past the step's end.
  assert.equal(stepProgress(step(7, 3), 99), 1);
  assert.equal(stepProgress(step(0, 3), 3.5), 0.125, 'a mid-pattern step still stops at its own end');
});

test('a time before the step reads as the step\'s start, not as negative', () => {
  assert.equal(stepProgress(step(2, 5), 4), 0.25);
});

test('an index past the pattern length wraps inside this revolution', () => {
  // Track.getPattern() can shrink under a stepIndex that was captured against the
  // old length. Wrapping the index keeps the bar inside 0..1 either way.
  assert.equal(stepProgress(step(9, 0, 0.125, 8), 0), 0.125);
  assert.equal(stepProgress(step(8, 0, 0.125, 8), 0), 0);
});

test('nothing to show reads as zero rather than throwing', () => {
  // This runs inside an animation frame; a progress bar must not be able to break
  // the loop that paints it.
  assert.equal(stepProgress(null, 1), 0);
  assert.equal(stepProgress(undefined, 1), 0);
  assert.equal(stepProgress(step(0, 0, 0, 8), 1), 0, 'zero-length step');
  assert.equal(stepProgress(step(0, 0, 0.125, 0), 1), 0, 'zero-length pattern');
  assert.equal(stepProgress(step(0, 0, 0.125, 8), Number.NaN), 0);
  assert.equal(stepProgress(step(Number.NaN, 0), 1), 0);
  assert.equal(stepProgress(step(0, Number.NaN), 1), 0);
});

test('promote hands over only what has become audible', () => {
  const queue = [step(0, 1), step(1, 2), step(2, 3)];
  assert.equal(promote(queue, 0.5), null, 'nothing due yet');
  assert.equal(queue.length, 3, 'and nothing consumed');

  assert.equal(promote(queue, 1).stepIndex, 0);
  assert.equal(queue.length, 2);
  assert.equal(promote(queue, 1.5), null, 'the next one is still in the future');
});

test('promote catches up to the newest step after a stalled frame', () => {
  // A hidden browser tab throttles requestAnimationFrame while the scheduler's
  // Worker timer keeps going, so several steps come due at once.
  const queue = [step(0, 1), step(1, 2), step(2, 3), step(3, 4)];
  const promoted = promote(queue, 3.5);
  assert.equal(promoted.stepIndex, 2, 'the newest audible one, not the oldest');
  assert.deepEqual(queue.map((s) => s.stepIndex), [3], 'the future one is left alone');
});

test('promote on an empty queue is a safe no-op', () => {
  const queue = [];
  assert.equal(promote(queue, 10), null);
  assert.deepEqual(queue, []);
});
