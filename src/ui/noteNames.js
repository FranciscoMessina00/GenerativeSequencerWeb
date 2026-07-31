/**
 * MIDI note number -> scientific pitch notation name, e.g. 60 -> "C4".
 *
 * Middle C (MIDI 60) is C4, as Scientific Pitch Notation defines and as most DAWs
 * display. Some gear calls MIDI 60 "C3" instead -- to match that, subtract one more
 * from `octave` below.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiNoteName(midiNote) {
  const n = Math.round(midiNote);
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return `${name}${octave}`;
}
