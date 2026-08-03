/**
 * What every control does, in one line -- the copy the info footer displays.
 *
 * Pure data, no imports: this file exists to be edited freely without reading any
 * other, and staying import-free is also what lets a Node test check its coverage
 * without a DOM.
 *
 * Keys are the ids named by a control's `data-info` attribute, and for anything
 * with a parameter behind it that id *is* the schema key from core/paramSchema.js.
 * That is the whole mapping: a control passes its own `spec.key` to `data-info`,
 * the key finds the text here. A test asserts every schema key has an entry, so a
 * new parameter cannot ship without one.
 *
 * Two conventions worth knowing before editing:
 *
 *   - A dotted id is generated rather than hand-written -- BiasSpreadSlider builds
 *     its range-edge drag-numbers with pseudo-keys like `noteBias.min`. Those fall
 *     back to the generic `range.min` / `range.max` below, so the six of them need
 *     no entries of their own. Adding the exact dotted id here overrides that for
 *     one edge. Hand-written ids never use a dot, which keeps the rule unambiguous.
 *   - `data-info` may name several ids, space-separated. The bias/spread track is
 *     one element driving two parameters, so it names both and the bar joins their
 *     texts. Keep those two lines short enough that the pair still reads.
 *
 * House style: `Label -- what it does`, one clause, no trailing detail nobody needs
 * mid-gesture. The label is written out rather than pulled from `spec.label` so the
 * wording here is entirely yours to change.
 */

/** Shown whenever the pointer is not on a control -- also what names the bar's purpose. */
export const INFO_HINT = 'Hover or use any control for a short description.';

export const INFO_TEXT = {
  // ---- Rhythm -------------------------------------------------------------
  steps: 'Euclid Steps — how many slots the cycle is divided into.',
  pulses: 'Euclid Triggers — how many slots carry a pulse, spread as evenly as possible.',
  rotation: 'Euclid Rotation — shifts the whole pulse pattern around the cycle.',
  stepDivision: 'Step Division — how long one step lasts, as a note value. Bigger number, shorter step.',
  stepMod: 'Step Modifier — T bends the step to a triplet (×2/3), D to a dotted note (×3/2).',
  logicOp: 'Logic Operator — how the Euclid pulse and the random bit combine: OR, AND, XOR or NAND.',
  probability: 'Trig Probability — how often the random bit is set, before the logic operator sees it.',
  trigLoop: 'Trig Loop — freeze the recent random bits and repeat them instead of rolling new ones.',
  trigLoopLength: 'Trig Loop Length — how many steps of random bits the frozen loop holds.',
  trigPerm: 'Rhythm Permutation — reorders the frozen loop. No effect until the loop is on.',

  // ---- Pitch --------------------------------------------------------------
  noteBias: 'Note Bias — the pitch the notes centre on. Drag across the track to move it.',
  noteSpread: 'Note Spread — how far notes wander from that centre, in semitones. Drag up and down.',
  scale: 'Scale — snaps every note to this scale, rooted on the note the bias is set to.',
  glideAmount: 'Glide — how much of the step each note spends sliding from the previous pitch.',
  glideMode: 'Glide Mode — whether that slide is linear or exponential.',
  noteLoop: 'Notes Loop — freeze the recent pitches and repeat them instead of drawing new ones.',
  noteLoopLength: 'Notes Loop Length — how many steps of pitches the frozen loop holds.',
  notePerm: 'Notes Permutation — reorders the frozen pitch loop. No effect until the loop is on.',

  // ---- Velocity -----------------------------------------------------------
  velBias: 'Velocity Bias — how hard notes are struck on average. Drag across the track.',
  velSpread: 'Velocity Spread — how much that strength varies note to note. Drag up and down.',
  velLoop: 'Velocity Loop — freeze the recent velocities and repeat them.',
  velLoopLength: 'Velocity Loop Length — how many steps of velocities the frozen loop holds.',

  // ---- Modal string voice -------------------------------------------------
  modBias: 'Pluck Position — where along the string it is plucked. Low is dead centre, high is near the bridge.',
  modSpread: 'Pluck Position Spread — how much that plucking point moves note to note.',
  modes: 'Modes — how many vibrating modes the string is built from. More is brighter and costlier.',
  stiffness: 'Stiffness — string inharmonicity. Higher stretches the overtones sharp, like a thick steel string.',
  decay: 'Decay — how long the string rings after it is plucked.',
  damping: 'Damping — how much faster the high modes fade than the low ones. Higher is duller.',
  pluckSoftness: 'Pluck Softness — a hard pick excites the high modes, a soft one leaves them out.',

  // ---- Granulator ---------------------------------------------------------
  grainPitch: 'Grain Pitch — playback rate of the granular layer. 1 is the original pitch.',
  grainDryWet: 'Grain Dry/Wet — balance between the plain string and its granular echo.',

  // ---- Transport ----------------------------------------------------------
  bpm: 'BPM — tempo, in beats per minute.',
  masterGain: 'Master — output level for the whole instrument.',

  // ---- Controls with no parameter behind them ------------------------------
  // The bias/spread axis-lock toggle: a view preference, deliberately not a schema
  // param and not persisted -- see BiasSpreadSlider.js.
  axisLock: 'Axis Lock — when off, a drag moves only the axis it starts along, instead of both at once.',
  // Fallbacks for the generated `<key>.min` / `<key>.max` range-edge drag-numbers.
  'range.min': 'Range Low — the lowest value this slider can reach. Drag to change it.',
  'range.max': 'Range High — the highest value this slider can reach. Drag to change it.',
  // Header chrome, tagged by hand in index.html since none of it has a spec.
  play: 'Play / Stop — start or stop the sequencer. Space does the same.',
  pluck: 'Pluck Once — play a single note without running the sequence.',
  reseed: 'Reseed — new random seed, so the generators take a different path.',
  presetSlots: 'Patch — pick one of the factory patches to load.',
  presetLoad: 'Load — apply the selected patch, including its random seed.',
  ring: 'Step Ring — the Euclid pattern, the playhead, and which steps actually triggered.',
};
