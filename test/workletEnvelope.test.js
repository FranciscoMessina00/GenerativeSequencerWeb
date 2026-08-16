import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ahdEnvelope, envelopeDuration, envelopeLevel } from '../src/audio/envelope.js';

/**
 * The AHD envelope as the audio thread actually runs it.
 *
 * AudioWorkletGlobalScope has no module loader, so both worklets carry their own copy
 * of the envelope's state machine and neither can be imported here. Same problem
 * test/masterClip.test.js already solves for the limiter curve, solved the same way:
 * lift the block out of the source text, so the drift check is exact and the behaviour
 * checks run the code that actually ships rather than a paraphrase of it.
 *
 * What this buys, beyond catching a copy-paste slip: audio/envelope.js is what the
 * visualiser draws and what test/envelope.test.js asserts against, and it is a closed
 * form. The worklets run a recursion instead, for the cost. Nothing but this file
 * stops the picture and the sound drifting apart.
 */

const WORKLETS = new URL('../src/audio/worklets/', import.meta.url);

/** The whole envelope block, verbatim, from one worklet's source. */
function extractEnvelope(file) {
  // Newlines normalised: a checkout can legitimately give the two files different
  // line endings, and a CRLF is not a difference in the envelope.
  const src = readFileSync(new URL(file, WORKLETS), 'utf8').replace(/\r\n/g, '\n');
  const block = /^const ENV_LOG_1000 = [\s\S]*?\n {2}return level;\n\}$/m.exec(src);
  assert.ok(block, `${file}: no envelope block found`);
  return block[0];
}

const modal = extractEnvelope('modal-processor.js');
const percussion = extractEnvelope('percussion-processors.js');

test('the two copies of the envelope have not drifted apart', () => {
  // One envelope for the whole instrument is the entire point of the feature. If the
  // string's copy is tuned, the drums' has to move with it.
  assert.equal(modal, percussion, 'the envelope block differs between the worklets');
});

/**
 * The shipped block, compiled. `sampleRate` is an AudioWorkletGlobalScope global, so
 * it is passed in as a parameter here -- the one concession to running this outside an
 * audio thread.
 */
function compile(sampleRate) {
  const factory = new Function(
    'sampleRate',
    `${modal}\nreturn { makeEnvelope, startEnvelope, envelopeSample };`,
  );
  return factory(sampleRate);
}

/** Render one envelope's gain, frame by frame, exactly as a voice would. */
function render(worklet, spec, frames) {
  const e = worklet.makeEnvelope();
  worklet.startEnvelope(e, spec);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = worklet.envelopeSample(e);
  return out;
}

const SAMPLE_RATE = 48000;
const STEP = 0.125;

const spec = (over = {}) => ahdEnvelope({
  attackMs: 10, holdMs: 60, decayMs: 180, stepSeconds: STEP, exponential: false, ...over,
});

for (const exponential of [false, true]) {
  const name = exponential ? 'exponential' : 'linear';

  test(`the shipped ${name} recursion tracks the closed form it is drawn from`, () => {
    const worklet = compile(SAMPLE_RATE);
    // 0 (no attack stage at all), a short one, one filling most of the step, and one
    // that cannot fit and gets truncated mid-ramp.
    for (const attackMs of [0, 10, 120, 500]) {
      const env = spec({ attackMs, exponential });
      const frames = Math.ceil((envelopeDuration(env) + 0.02) * SAMPLE_RATE);
      const rendered = render(worklet, env, frames);

      for (let i = 0; i < frames; i += 64) {
        const expected = envelopeLevel(env, i / SAMPLE_RATE);
        // A frame of slack at the stage boundaries: the recursion emits its level and
        // then advances, so it sits at most one sample behind the closed form there.
        assert.ok(
          Math.abs(rendered[i] - expected) < 2e-3,
          `attackMs ${attackMs}, frame ${i}: shipped ${rendered[i]} vs ${expected}`,
        );
      }
    }
  });
}

test('every envelope reaches exact silence and stays there', () => {
  // Not "near zero": a voice is reclaimed on its life running out, and a floor left
  // ringing under it would be DC beneath the whole mix.
  const worklet = compile(SAMPLE_RATE);
  for (const exponential of [false, true]) {
    for (const attackMs of [0, 40, 600]) {
      const env = spec({ attackMs, exponential });
      const frames = Math.ceil((envelopeDuration(env) + 0.01) * SAMPLE_RATE);
      const rendered = render(worklet, env, frames);
      assert.equal(rendered[frames - 1], 0, `attackMs ${attackMs}, ${exponential}`);
    }
  }
});

test('the gain never overshoots the peak, and never goes negative', () => {
  const worklet = compile(44100);
  for (const exponential of [false, true]) {
    const env = spec({ attackMs: 40, exponential });
    const frames = Math.ceil((envelopeDuration(env) + 0.01) * 44100);
    for (const level of render(worklet, env, frames)) {
      assert.ok(level >= 0 && level <= env.peak + 1e-9, `level ${level}`);
    }
  }
});

test('a truncated attack hands its own level straight to the decay', () => {
  // The no-pop guarantee, checked on the shipped recursion rather than on the maths:
  // no single frame anywhere in the envelope may jump by more than a hair.
  const worklet = compile(SAMPLE_RATE);
  const env = spec({ attackMs: 500, holdMs: 5000 });
  assert.ok(env.peak < 1, 'this case is only interesting when the attack was cut');
  const frames = Math.ceil((envelopeDuration(env) + 0.01) * SAMPLE_RATE);
  const rendered = render(worklet, env, frames);

  let biggest = 0;
  for (let i = 1; i < frames; i += 1) {
    biggest = Math.max(biggest, Math.abs(rendered[i] - rendered[i - 1]));
  }
  assert.ok(biggest < 1e-3, `a ${biggest} jump between frames would be an audible click`);
});

test('a hit with no envelope renders as a constant 1', () => {
  // The check pages under test/browser assemble note-ons by hand. A voice that fell
  // silent on a field they never knew to send would make every one of them a false
  // failure -- and would silence the Pluck button too.
  const worklet = compile(SAMPLE_RATE);
  const rendered = render(worklet, null, 256);
  for (const level of rendered) assert.equal(level, 1);
});

test('a voice reset back to silence forgets the envelope it was running', () => {
  const worklet = compile(SAMPLE_RATE);
  const e = worklet.makeEnvelope();
  worklet.startEnvelope(e, spec({ attackMs: 400 }));
  worklet.envelopeSample(e);
  // What percussion-processors.js's resetVoice does, and what a fresh voice looks
  // like: no envelope, so it cannot leak a stale stage into the next hit.
  worklet.startEnvelope(e, null);
  assert.equal(e.active, false);
  assert.equal(e.totalFrames, 0);
  assert.equal(worklet.envelopeSample(e), 1);
});

test('the total frame count matches the envelope it was built from', () => {
  // startVoice sizes lifeRemaining from this, so a voice that stops too early clips
  // its own tail and one that stops too late holds a pool slot doing nothing.
  const worklet = compile(SAMPLE_RATE);
  const env = spec({ attackMs: 40, holdMs: 60, decayMs: 180 });
  const e = worklet.makeEnvelope();
  worklet.startEnvelope(e, env);
  const expected = Math.round(envelopeDuration(env) * SAMPLE_RATE);
  assert.ok(Math.abs(e.totalFrames - expected) <= 2, `${e.totalFrames} vs ${expected}`);
});
