/**
 * The ten scales offered by the instrument, in the source's knob order
 * (`TriggerWithGlide.scd:50-61`, labels from `Vista.pde:315-346`), plus a port
 * of SuperCollider's `nearestInScale` quantisation.
 */

export const SCALES = [
  { id: 1, name: 'Chromatic', degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 2, name: 'Major', degrees: [0, 2, 4, 5, 7, 9, 11] },
  { id: 3, name: 'Minor', degrees: [0, 2, 3, 5, 7, 8, 10] },
  { id: 4, name: 'Major Pentatonic', degrees: [0, 2, 4, 7, 9] },
  { id: 5, name: 'Minor Pentatonic', degrees: [0, 3, 5, 7, 10] },
  { id: 6, name: 'Dorian', degrees: [0, 2, 3, 5, 7, 9, 10] },
  { id: 7, name: 'Lydian', degrees: [0, 2, 4, 6, 7, 9, 11] },
  { id: 8, name: 'Phrygian', degrees: [0, 1, 3, 5, 7, 8, 10] },
  { id: 9, name: 'Mixolydian', degrees: [0, 2, 4, 5, 7, 9, 10] },
  { id: 10, name: 'Iwato', degrees: [0, 1, 5, 6, 10] },
];

export const SCALE_NAMES = SCALES.map((s) => s.name);

export function scaleById(id) {
  return SCALES[Math.floor(id) - 1] ?? SCALES[0];
}

/**
 * Port of SC's `nearestInList`: nearest element of a sorted ascending list.
 * Ties resolve downward (SC uses `<=` when comparing the two neighbours), which
 * matters for chromatic quantisation of exact half-steps.
 */
export function nearestInList(value, list) {
  // Index of the first element strictly greater than `value`.
  let i = -1;
  for (let k = 0; k < list.length; k += 1) {
    if (list[k] > value) {
      i = k;
      break;
    }
  }
  if (i === -1) return list[list.length - 1];
  if (i === 0) return list[0];
  return Math.abs(list[i - 1] - value) <= Math.abs(list[i] - value)
    ? list[i - 1]
    : list[i];
}

/**
 * Quantise a (possibly fractional) MIDI note to the given scale.
 *
 * Faithful to SC: the octave is taken first and the remainder is snapped within
 * that octave, so quantisation deliberately does NOT wrap across the octave
 * boundary. In major pentatonic, 11.6 snaps down to 9 rather than up to the 12
 * of the next octave. This asymmetry is audible -- it biases notes near the top
 * of an octave downward -- and is kept because it is part of how the original
 * instrument sounds.
 */
export function nearestInScale(note, degrees) {
  const octave = Math.floor(note / 12) * 12;
  const pitchClass = note - octave;
  return octave + nearestInList(pitchClass, degrees);
}
