import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The master limiter's curve.
 *
 * AudioWorkletGlobalScope has no module loader, so both worklets carry their own
 * copy of softClip and neither can be imported here. Rather than trust the
 * duplication, this lifts the function out of the source text: the drift check is
 * exact, and the behaviour checks run the code that actually ships.
 */

const WORKLETS = new URL('../src/audio/worklets/', import.meta.url);

/** The KNEE constant and softClip body as written in a worklet file. */
function extractSoftClip(file) {
  // Newlines normalised: the drift check compares two files that a checkout could
  // legitimately have given different line endings, and a CRLF is not a difference
  // in the curve.
  const src = readFileSync(new URL(file, WORKLETS), 'utf8').replace(/\r\n/g, '\n');
  const knee = /^const KNEE = ([\d.]+);$/m.exec(src);
  const body = /^function softClip\(x\) \{\n([\s\S]*?)\n\}$/m.exec(src);
  assert.ok(knee, `${file}: no KNEE constant found`);
  assert.ok(body, `${file}: no softClip function found`);
  return { knee: knee[1], body: body[1] };
}

const granulator = extractSoftClip('granulator-processor.js');
const master = extractSoftClip('master-clip-processor.js');

/** The shipped curve, compiled from the shipped text. */
const KNEE = Number(master.knee);
const softClip = new Function('x', `const KNEE = ${master.knee};\n${master.body}`);

test('the two copies of softClip have not drifted apart', () => {
  // The master limiter is deliberately the same curve as the granulator's, not a
  // second character. If one is tuned, the other has to move with it.
  assert.equal(master.knee, granulator.knee, 'KNEE differs between the worklets');
  assert.equal(master.body, granulator.body, 'softClip body differs between the worklets');
});

test('it is exact identity below the knee', () => {
  // This is the property the whole no-regression argument rests on: one track at
  // the default level 0.8 peaks at exactly KNEE, so an existing single-track patch
  // passes through the new node untouched.
  assert.equal(KNEE, 0.8);
  for (const x of [0, 0.1, 0.25, 0.5, 0.79, 0.8, -0.5, -0.8]) {
    assert.equal(softClip(x), x, `${x} must pass through unchanged`);
  }
});

test('it bounds four tracks summing well past full scale', () => {
  // Four granulator outputs at level 0.8 is the worst realistic case.
  for (const x of [0.81, 1, 1.6, 3.2, 100]) {
    const y = softClip(x);
    assert.ok(y > KNEE, `${x} -> ${y} should stay above the knee`);
    assert.ok(y < 1, `${x} -> ${y} must stay inside full scale`);
  }
  assert.ok(softClip(3.2) < 1);
});

test('it is odd-symmetric, so it adds no even harmonics or DC', () => {
  for (const x of [0.3, 0.9, 1.5, 4]) {
    assert.equal(softClip(-x), -softClip(x), `asymmetric at ${x}`);
  }
});

test('it is monotonic and continuous across the knee', () => {
  let previous = softClip(0);
  for (let x = 0.001; x <= 4; x += 0.001) {
    const y = softClip(x);
    assert.ok(y >= previous, `not monotonic at ${x}`);
    // C1 across the knee means no step: consecutive samples stay close.
    assert.ok(y - previous < 0.002, `discontinuity at ${x}`);
    previous = y;
  }
});
