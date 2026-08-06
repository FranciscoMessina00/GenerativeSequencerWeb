import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HAT_OSC_RATIOS, hatHit, kickHit, noiseTilt, snareHit,
} from '../src/audio/percussion/percussionModel.js';
import { midiToHz } from '../src/audio/modal/modalModel.js';

const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

/** Schema defaults, so a test can vary one thing at a time. */
const KICK = { note: 36, velocity: 0.8, decay: 0.4, sweep: 3, sweepTime: 0.05, noise: 0.15, noiseColor: 0.6 };
const SNARE = { note: 48, velocity: 0.8, decay: 0.25, noise: 0.7, noiseColor: 0.55, tone: 0.4, bodyDecay: 0.12 };
const HAT = { note: 60, velocity: 0.8, decay: 0.08, noise: 0.9, noiseColor: 0.8 };

// ---------------------------------------------------------------------------
// The colour tilt
// ---------------------------------------------------------------------------

test('the colour tilt is an equal-power crossfade', () => {
  // Equal-power, so sweeping the colour changes the timbre and not the level. Same
  // treatment the granulator gives its dry/wet.
  for (const color of [0, 0.25, 0.5, 0.75, 1]) {
    const { dark, bright } = noiseTilt(color);
    assert.ok(close(dark * dark + bright * bright, 1), `power is not unity at ${color}`);
  }
});

test('the tilt ends are fully dark and fully bright', () => {
  assert.deepEqual(noiseTilt(0), { dark: 1, bright: 0 });
  const one = noiseTilt(1);
  assert.ok(close(one.dark, 0) && close(one.bright, 1));
  const half = noiseTilt(0.5);
  assert.ok(close(half.dark, half.bright), 'halfway must be an even blend');
});

test('a colour outside 0..1 clamps rather than inverting the crossfade', () => {
  assert.deepEqual(noiseTilt(-3), noiseTilt(0));
  assert.deepEqual(noiseTilt(9), noiseTilt(1));
  // A junk value reads as dark rather than as NaN, which would poison the node.
  assert.deepEqual(noiseTilt(Number.NaN), noiseTilt(0));
  assert.deepEqual(noiseTilt(undefined), noiseTilt(0));
});

// ---------------------------------------------------------------------------
// Kick
// ---------------------------------------------------------------------------

test('the kick sweeps down to the note it was given', () => {
  const hit = kickHit(KICK);
  assert.ok(close(hit.fEnd, midiToHz(36)), 'it must land on the note');
  assert.ok(close(hit.fStart, midiToHz(36) * 3), 'and start `sweep` times above it');
  assert.ok(hit.fStart > hit.fEnd, 'the sweep falls, never rises');
});

test('the sweep depth is a ratio, so it survives retuning', () => {
  // The whole reason sweep is a multiplier rather than an interval: two drums tuned an
  // octave apart should have the same character, not the same absolute drop.
  const low = kickHit({ ...KICK, note: 24 });
  const high = kickHit({ ...KICK, note: 48 });
  assert.ok(close(low.fStart / low.fEnd, high.fStart / high.fEnd));
});

test('sweep 1 is no sweep at all', () => {
  const hit = kickHit({ ...KICK, sweep: 1 });
  assert.ok(close(hit.fStart, hit.fEnd));
});

test('velocity scales the kick amplitude and leaves the decay alone', () => {
  // Unlike a plucked string, where a light touch genuinely rings less: a soft kick is
  // a quieter kick, not a shorter one.
  const soft = kickHit({ ...KICK, velocity: 0.2 });
  const hard = kickHit({ ...KICK, velocity: 1 });
  assert.equal(soft.amp, 0.2);
  assert.equal(hard.amp, 1);
  assert.equal(soft.decay, hard.decay);
});

test('the kick noise burst is shorter than the sweep it punctuates', () => {
  const hit = kickHit(KICK);
  assert.ok(hit.noiseDecay < hit.sweepTime, 'it belongs to the attack, not the body');
  assert.ok(hit.noiseDecay > 0);
  // Even at the shortest sweep it stays long enough to be a burst rather than a click.
  const fast = kickHit({ ...KICK, sweepTime: 0.005 });
  assert.ok(fast.noiseDecay >= 0.005);
});

test('a deep sweep on a high note cannot land above Nyquist', () => {
  // note 127 is ~12.5 kHz; times 8 would be 100 kHz, which is not a frequency.
  const hit = kickHit({ ...KICK, note: 127, sweep: 8 });
  assert.ok(hit.fStart <= 20000, `fStart was ${hit.fStart}`);
  assert.ok(Number.isFinite(hit.fStart));
});

// ---------------------------------------------------------------------------
// Snare
// ---------------------------------------------------------------------------

test('the snare body is two inharmonic modes, not a pitched tom', () => {
  const hit = snareHit(SNARE);
  assert.equal(hit.bodyHz.length, 2);
  assert.ok(close(hit.bodyHz[0], midiToHz(48)));
  // Not a musical interval on purpose -- a fifth (1.5) would read as a pitched tom
  // underneath the rattle.
  assert.ok(close(hit.bodyHz[1] / hit.bodyHz[0], 1.7));
});

test('the snare\'s two layers are independent, so either can be soloed', () => {
  const noiseOnly = snareHit({ ...SNARE, tone: 0 });
  assert.equal(noiseOnly.bodyAmp, 0);
  assert.equal(noiseOnly.noiseAmp, 0.7, 'silencing the body must not touch the rattle');

  const bodyOnly = snareHit({ ...SNARE, noise: 0 });
  assert.equal(bodyOnly.noiseAmp, 0);
  assert.equal(bodyOnly.bodyAmp, 0.4);
});

test('the snare\'s two decays are separate', () => {
  const hit = snareHit({ ...SNARE, decay: 0.9, bodyDecay: 0.05 });
  assert.equal(hit.noiseDecay, 0.9);
  assert.equal(hit.bodyDecay, 0.05);
});

// ---------------------------------------------------------------------------
// Hi-hat
// ---------------------------------------------------------------------------

test('the hat band hinges inside the oscillator cluster, not above it', () => {
  const hit = hatHit(HAT);
  // One octave above the cluster's own base: a hinge above the whole cluster would
  // put every partial in the filter's stopband regardless of the colour setting.
  assert.ok(close(hit.bandHz, midiToHz(60) * 8));
  assert.ok(hit.bandHz > hit.oscHz[0], 'the hinge sits above the fundamental');
  assert.ok(hit.bandHz < hit.oscHz[hit.oscHz.length - 1], 'and below the top partial');
});

test('the hat band still tracks the note, so the Pitch panel does something', () => {
  const low = hatHit({ ...HAT, note: 48 });
  const high = hatHit({ ...HAT, note: 72 });
  assert.ok(high.bandHz > low.bandHz);
  assert.ok(close(high.bandHz / low.bandHz, 4), 'two octaves of note is two of band');
});

test('a high note cannot push the hat band past Nyquist', () => {
  const hit = hatHit({ ...HAT, note: 120 });
  assert.ok(hit.bandHz <= 20000, `band was ${hit.bandHz}`);
  assert.ok(Number.isFinite(hit.bandHz));
});

test('the hat oscillator cluster has six inharmonic ratios, tracking the note', () => {
  const hit = hatHit(HAT);
  assert.equal(hit.oscHz.length, 6);
  // Two octaves up, not the noise band's four -- six audible partials that high would
  // be sizzle with no perceivable pitch under them.
  assert.ok(close(hit.oscHz[0], midiToHz(60) * 4));
  for (let i = 0; i < HAT_OSC_RATIOS.length; i += 1) {
    assert.ok(close(hit.oscHz[i] / hit.oscHz[0], HAT_OSC_RATIOS[i]));
  }
});

test('a high note cannot push the hat cluster past Nyquist', () => {
  const hit = hatHit({ ...HAT, note: 120 });
  for (const hz of hit.oscHz) {
    assert.ok(hz <= 20000, `oscHz had ${hz}`);
    assert.ok(Number.isFinite(hz));
  }
});

test('the hat noise knob is now a blend, not a gain', () => {
  // 0 is the oscillator cluster alone, 1 is noise alone. The schema default (0.9) is
  // mostly noise with a light dusting of cluster.
  assert.equal(hatHit(HAT).mix, 0.9);
  assert.equal(hatHit({ ...HAT, noise: 0 }).mix, 0);
  assert.equal(hatHit({ ...HAT, noise: 1 }).mix, 1);
});

// ---------------------------------------------------------------------------
// Guards: nothing non-finite may reach an audio thread
// ---------------------------------------------------------------------------

test('every hit is finite, whatever it is handed', () => {
  // A NaN reaching an AudioWorklet poisons the node for the lifetime of the graph, and
  // gives no clue where it came from -- so the guard belongs here, at the boundary.
  const junk = [Number.NaN, Infinity, -Infinity, undefined, null, 'x', {}];
  const numbers = (hit) => Object.values(hit).flatMap((v) => {
    if (typeof v === 'number') return [v];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return Object.values(v);
    return [];
  });

  for (const bad of junk) {
    for (const [name, build, base] of [['kick', kickHit, KICK], ['snare', snareHit, SNARE], ['hat', hatHit, HAT]]) {
      for (const key of Object.keys(base)) {
        const hit = build({ ...base, [key]: bad });
        for (const n of numbers(hit)) {
          assert.ok(Number.isFinite(n), `${name} with ${key}=${String(bad)} produced ${n}`);
        }
      }
    }
  }
});

test('no decay is ever zero, however low it is asked to go', () => {
  // A zero decay is a click with no body, and in the worklet it would divide by zero.
  for (const value of [0, -1, Number.NaN]) {
    assert.ok(kickHit({ ...KICK, decay: value }).decay > 0);
    assert.ok(snareHit({ ...SNARE, decay: value, bodyDecay: value }).noiseDecay > 0);
    assert.ok(snareHit({ ...SNARE, decay: value, bodyDecay: value }).bodyDecay > 0);
    assert.ok(hatHit({ ...HAT, decay: value }).decay > 0);
  }
});
