/**
 * MIDI note number -> scientific pitch notation name, e.g. 60 -> "C4".
 *
 * Uses the convention where middle C (MIDI 60) is C4 and concert pitch A440
 * (MIDI 69) is A4 -- the mapping Scientific Pitch Notation itself defines, and
 * the one most DAWs (Ableton Live, Logic, FL Studio) show by default. A
 * minority of tools (some older Yamaha/Roland gear, some Cubase
 * configurations) instead call MIDI 60 "C3" -- if this needs to match one of
 * those, subtract one more from `octave` below.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiNoteName(midiNote) {
  const n = Math.round(midiNote);
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return `${name}${octave}`;
}
