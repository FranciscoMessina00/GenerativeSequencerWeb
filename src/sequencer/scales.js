/** The ten scales offered by the instrument, plus the quantiser that snaps to them. */

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
 * Nearest element of a sorted ascending list. Ties resolve downward, which is
 * what makes chromatic quantisation of an exact half-step deterministic.
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
 * The octave is taken first and the remainder snapped inside it, so quantisation
 * deliberately does NOT wrap across the octave boundary: in major pentatonic
 * 11.6 snaps down to 9 rather than up to the next octave's 12. The asymmetry is
 * audible -- notes near the top of an octave get pulled down -- and intended.
 */
export function nearestInScale(note, degrees) {
  const octave = Math.floor(note / 12) * 12;
  const pitchClass = note - octave;
  return octave + nearestInList(pitchClass, degrees);
}
