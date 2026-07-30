import test from 'node:test';
import assert from 'node:assert/strict';
import { midiNoteName } from '../src/ui/noteNames.js';

test('middle C and concert pitch A land on the expected octave', () => {
  assert.equal(midiNoteName(60), 'C4');
  assert.equal(midiNoteName(69), 'A4');
});

test('sharps are named with #', () => {
  assert.equal(midiNoteName(61), 'C#4');
  assert.equal(midiNoteName(66), 'F#4');
});

test('octave boundaries land correctly', () => {
  assert.equal(midiNoteName(59), 'B3');
  assert.equal(midiNoteName(72), 'C5');
});

test('rounds fractional input before naming', () => {
  assert.equal(midiNoteName(60.4), 'C4');
  assert.equal(midiNoteName(60.6), 'C#4'); // rounds up to 61, not up an octave
});

test('schema extremes (MIDI 1..127) produce valid, non-throwing names', () => {
  assert.equal(midiNoteName(1), 'C#-1');
  assert.equal(midiNoteName(127), 'G9');
});
