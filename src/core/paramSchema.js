/**
 * Single declarative source of truth for every control.
 *
 * Ranges are cross-referenced from the Processing GUI's knob tables
 * (`Vista.pde:39-50`) against the OSC unpack that consumes them
 * (`TriggerWithGlide.scd:22-47`), since the GUI sends raw knob values and
 * SuperCollider rescales some of them on arrival.
 *
 * `target` routes a change to the right consumer: 'track' params drive pattern
 * generation, 'voice' params drive the DSP worklets, 'transport' drives the clock.
 * The UI builds itself from this list, and Track/AudioEngine take their defaults
 * from it, so a range only ever needs changing in one place.
 */

export const PARAM_SCHEMA = [
  // ---- Rhythm -------------------------------------------------------------
  // Source defaults are steps=1/pulses=1, which is a constant 16th-note pulse.
  // Defaulted to 5-in-16 instead so the instrument makes a recognisable pattern
  // on first load; every other default below is the source's.
  { key: 'steps', label: 'Euclid Steps', group: 'Rhythm', target: 'track', min: 1, max: 32, step: 1, def: 16 },
  { key: 'pulses', label: 'Euclid Triggers', group: 'Rhythm', target: 'track', min: 1, max: 32, step: 1, def: 5 },
  { key: 'rotation', label: 'Euclid Rotation', group: 'Rhythm', target: 'track', min: 0, max: 32, step: 1, def: 0 },
  { key: 'logicOp', label: 'Logic Operator', group: 'Rhythm', target: 'track', min: 1, max: 4, step: 1, def: 1, display: 'logic' },
  { key: 'probability', label: 'Trig Probability', group: 'Rhythm', target: 'track', min: 0, max: 1, step: 0.01, def: 0 },
  { key: 'trigLoop', label: 'Trig Loop', group: 'Rhythm', target: 'track', type: 'toggle', def: false },
  { key: 'trigLoopLength', label: 'Trig Loop Length', group: 'Rhythm', target: 'track', min: 1, max: 32, step: 1, def: 1 },
  // Normalised, then scaled by the loop's factorial -- see permutationIndex().
  { key: 'trigPerm', label: 'Rhythm Permutation', group: 'Rhythm', target: 'track', min: 0, max: 1, step: 0.001, def: 0 },

  // ---- Pitch --------------------------------------------------------------
  { key: 'noteBias', label: 'Note Bias', group: 'Pitch', target: 'track', min: 1, max: 127, step: 0.5, def: 51 },
  { key: 'noteSpread', label: 'Note Spread', group: 'Pitch', target: 'track', min: 0.1, max: 40, step: 0.1, def: 4 },
  { key: 'scale', label: 'Scale', group: 'Pitch', target: 'track', min: 1, max: 10, step: 1, def: 1, display: 'scale' },
  { key: 'glide', label: 'Glide (lin | exp)', group: 'Pitch', target: 'track', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'noteLoop', label: 'Notes Loop', group: 'Pitch', target: 'track', type: 'toggle', def: false },
  { key: 'noteLoopLength', label: 'Notes Loop Length', group: 'Pitch', target: 'track', min: 1, max: 32, step: 1, def: 1 },
  { key: 'notePerm', label: 'Notes Permutation', group: 'Pitch', target: 'track', min: 0, max: 1, step: 0.001, def: 0 },

  // ---- Velocity -----------------------------------------------------------
  { key: 'velBias', label: 'Velocity Bias', group: 'Velocity', target: 'track', min: 0.1, max: 1, step: 0.01, def: 0.55 },
  { key: 'velSpread', label: 'Velocity Spread', group: 'Velocity', target: 'track', min: 0.1, max: 1, step: 0.01, def: 0.2 },
  { key: 'velLoop', label: 'Velocity Loop', group: 'Velocity', target: 'track', type: 'toggle', def: false },
  { key: 'velLoopLength', label: 'Velocity Loop Length', group: 'Velocity', target: 'track', min: 1, max: 32, step: 1, def: 1 },

  // ---- Modulation (plucking position) -------------------------------------
  { key: 'modBias', label: 'Pluck Position Bias', group: 'Modulation', target: 'track', min: 2, max: 20, step: 0.1, def: 4 },
  { key: 'modSpread', label: 'Pluck Position Spread', group: 'Modulation', target: 'track', min: 0.1, max: 20, step: 0.1, def: 2 },
  // The Processing GUI only ever sent 0..1 here, but SuperCollider's handler
  // already branched on the sign (`interpol < 0` -> linear). Widened to -1..1 so
  // the negative half becomes reachable, matching the note glide control.
  { key: 'modInterp', label: 'Pluck Interp (lin | exp)', group: 'Modulation', target: 'track', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'modLoop', label: 'Modulation Loop', group: 'Modulation', target: 'track', type: 'toggle', def: false },
  { key: 'modLoopLength', label: 'Modulation Loop Length', group: 'Modulation', target: 'track', min: 1, max: 32, step: 1, def: 1 },

  // ---- Modal string voice -------------------------------------------------
  // The paper names mode count as the CPU/quality trade-off; source used 10.
  { key: 'modes', label: 'Modes', group: 'String', target: 'voice', min: 4, max: 32, step: 1, def: 16 },
  // beta = stiffness / 1000, so 11 reproduces the paper's beta = 0.011.
  { key: 'stiffness', label: 'Stiffness (β×1000)', group: 'String', target: 'voice', min: 0, max: 40, step: 0.5, def: 11 },
  { key: 'decay', label: 'Decay', group: 'String', target: 'voice', min: 0.25, max: 3, step: 0.01, def: 1 },
  { key: 'damping', label: 'Damping (mode rolloff)', group: 'String', target: 'voice', min: 0, max: 1.5, step: 0.01, def: 0.5 },
  { key: 'pluckSoftness', label: 'Pluck Softness', group: 'String', target: 'voice', min: 0, max: 1, step: 0.01, def: 0.35 },

  // ---- Granulator ---------------------------------------------------------
  { key: 'grainPitch', label: 'Grain Pitch', group: 'Granulator', target: 'voice', min: 0.5, max: 2, step: 0.01, def: 1 },
  { key: 'grainDryWet', label: 'Grain Dry/Wet', group: 'Granulator', target: 'voice', min: -1, max: 1, step: 0.01, def: -1 },

  // ---- Transport ----------------------------------------------------------
  { key: 'bpm', label: 'BPM', group: 'Transport', target: 'transport', min: 30, max: 300, step: 1, def: 120 },
  { key: 'masterGain', label: 'Master', group: 'Transport', target: 'voice', min: 0, max: 1, step: 0.01, def: 0.8 },
];

export const PARAM_GROUPS = [...new Set(PARAM_SCHEMA.map((p) => p.group))];

const byKey = new Map(PARAM_SCHEMA.map((p) => [p.key, p]));

export function paramSpec(key) {
  return byKey.get(key);
}

/** Defaults for every param whose `target` matches, as a plain object. */
export function defaultsFor(target) {
  const out = {};
  for (const p of PARAM_SCHEMA) {
    if (p.target === target) out[p.key] = p.def;
  }
  return out;
}

/** Clamp a numeric param to its declared range. Toggles pass through as booleans. */
export function clampParam(key, value) {
  const spec = byKey.get(key);
  if (!spec) return value;
  if (spec.type === 'toggle') return Boolean(value);
  return Math.min(spec.max, Math.max(spec.min, Number(value)));
}
