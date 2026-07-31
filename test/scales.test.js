import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALES,
  nearestInList,
  nearestInScale,
  scaleById,
} from '../src/sequencer/scales.js';

test('ten scales, ascending degrees inside one octave', () => {
  assert.equal(SCALES.length, 10);
  for (const scale of SCALES) {
    assert.ok(scale.degrees.length > 0, scale.name);
    assert.equal(scale.degrees[0], 0, `${scale.name} starts on the root`);
    for (let i = 1; i < scale.degrees.length; i += 1) {
      assert.ok(scale.degrees[i] > scale.degrees[i - 1], `${scale.name} ascends`);
      assert.ok(scale.degrees[i] < 12, `${scale.name} stays within an octave`);
    }
  }
});

test('scaleById is 1-based and clamps to chromatic on bad input', () => {
  assert.equal(scaleById(1).name, 'Chromatic');
  assert.equal(scaleById(10).name, 'Iwato');
  assert.equal(scaleById(99).name, 'Chromatic');
});

test('nearestInList picks the closest element', () => {
  const major = [0, 2, 4, 5, 7, 9, 11];
  assert.equal(nearestInList(0, major), 0);
  assert.equal(nearestInList(2.4, major), 2);
  assert.equal(nearestInList(3.4, major), 4);
  assert.equal(nearestInList(11.9, major), 11); // above the top -> last
  assert.equal(nearestInList(-3, major), 0); // below the bottom -> first
});

test('nearestInList resolves exact ties downward', () => {
  const pent = [0, 2, 4, 7, 9];
  assert.equal(nearestInList(1, pent), 0); // equidistant from 0 and 2
  assert.equal(nearestInList(3, pent), 2); // equidistant from 2 and 4
});

test('quantisation keeps notes in the chosen scale', () => {
  const pent = scaleById(4).degrees; // major pentatonic
  for (let note = 0; note < 96; note += 0.25) {
    const q = nearestInScale(note, pent);
    assert.ok(pent.includes(((q % 12) + 12) % 12), `${note} -> ${q}`);
  }
});

test('chromatic quantisation is plain rounding (ties down)', () => {
  const chrom = scaleById(1).degrees;
  assert.equal(nearestInScale(60.2, chrom), 60);
  assert.equal(nearestInScale(60.8, chrom), 61);
  assert.equal(nearestInScale(60.5, chrom), 60);
});

test('quantisation does NOT wrap across the octave boundary', () => {
  // The octave is taken first, then the remainder snapped inside it. In major
  // pentatonic [0,2,4,7,9] the top degree is 9, so 11.6 snaps DOWN to 9 rather
  // than up to the 12 of the next octave -- a 2.6-semitone pull.
  //
  // This biases notes near the top of each octave downward. It is audible and
  // intended, so it is asserted deliberately: "fixing" it would change the
  // instrument's character.
  const pent = scaleById(4).degrees;
  assert.equal(nearestInScale(11.6, pent), 9);
  assert.equal(nearestInScale(71.6, pent), 69);

  // Same effect in Iwato, whose top degree is 10.
  const iwato = scaleById(10).degrees;
  assert.equal(nearestInScale(11.9, iwato), 10);
});

test('octave placement is preserved', () => {
  const major = scaleById(2).degrees;
  assert.equal(nearestInScale(60, major), 60);
  assert.equal(nearestInScale(72, major), 72);
  assert.equal(nearestInScale(48.1, major), 48);
});
