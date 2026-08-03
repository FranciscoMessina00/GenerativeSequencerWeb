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
 * Quantise a (possibly fractional) MIDI note to the given scale, rooted at `root`.
 *
 * `root` is the note that counts as scale degree 0 -- normally the bias, so the scale
 * is always built on whichever note the bias slider is currently sitting on, rather
 * than always snapping to the same pitch classes anchored at C regardless of where
 * the bias is. That also means the bias itself is always in scale by construction:
 * dragging it never gets pulled to some other "nearest" note. Omitting `root` (or
 * passing 0) anchors the scale at C, as before.
 *
 * The octave is taken first, relative to the root rather than to C, and the
 * remainder snapped inside it, so quantisation deliberately does NOT wrap across the
 * octave boundary: in major pentatonic a note 11.6 semitones above the root snaps
 * down to 9 above it rather than up to the 12 of the next octave. The asymmetry is
 * audible -- notes near the top of an octave get pulled down -- and intended.
 */
export function nearestInScale(note, degrees, root = 0) {
  const rootPitchClass = ((Math.floor(root) % 12) + 12) % 12;
  const shifted = note - rootPitchClass;
  const octave = Math.floor(shifted / 12) * 12;
  const pitchClass = shifted - octave;
  return rootPitchClass + octave + nearestInList(pitchClass, degrees);
}
