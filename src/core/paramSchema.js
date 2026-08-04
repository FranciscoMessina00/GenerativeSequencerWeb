/**
 * Single declarative source of truth for every control.
 *
 * Two orthogonal fields decide what happens to a value, and conflating them is a
 * mistake worth naming:
 *
 *   `target`  WHO receives it. 'track' params drive pattern generation, 'voice'
 *             params drive one track's DSP chain, 'transport' drives the clock,
 *             'master' the output fader, 'modulation' the LFO itself. Track,
 *             Scheduler, TrackVoice and Modulation each take their defaults from
 *             defaultsFor(<their target>).
 *
 *   `scope`   HOW MANY copies exist. Omitted means one per track -- the common
 *             case, since four pages want four of nearly everything. Only
 *             `scope: 'global'` params are single-valued, and there are exactly
 *             two: the tempo and the master fader. ParamStore is the only reader.
 *
 * The UI builds itself from this list, so a range only ever needs changing here.
 */

export const PARAM_SCHEMA = [
  // ---- Rhythm -------------------------------------------------------------
  // 5-in-16 by default, so the instrument makes a recognisable pattern on first
  // load rather than a flat 16th-note pulse.
  // `short` is the compact caption, for slots where the surrounding context already
  // supplies the noun -- inside the step ring the panel already says "Euclid", so
  // repeating it three times only costs space.
  { key: 'steps', label: 'Euclid Steps', short: 'Steps', group: 'Rhythm', target: 'track', min: 1, max: 32, step: 1, def: 16 },
  { key: 'pulses', label: 'Euclid Triggers', short: 'Pulses', group: 'Rhythm', target: 'track', min: 1, max: 32, step: 1, def: 5 },
  { key: 'rotation', label: 'Euclid Rotation', short: 'Rotation', group: 'Rhythm', target: 'track', min: 0, max: 32, step: 1, def: 0 },
  // How long one step lasts, as a note value -- see sequencer/stepDivision.js.
  //
  // `values` marks a param whose allowed set is enumerated rather than a uniform
  // range. min/max/step are carried alongside on purpose: drag maths, aria bounds and
  // the range-input path all read them, so only quantisation has to know about
  // `values`. Stored as the note's denominator, so a bigger number is a shorter step.
  { key: 'stepDivision', label: 'Step Division', short: 'Division', group: 'Rhythm', target: 'track', values: [1, 2, 4, 8, 16, 32], min: 1, max: 32, step: 1, def: 16, display: 'noteValue' },
  // 0 straight, 1 triplet, 2 dotted. One tri-state value rather than two toggles,
  // because triplet and dotted together cancel to straight -- see stepDivision.js.
  { key: 'stepMod', label: 'Step Modifier', group: 'Rhythm', target: 'track', values: [0, 1, 2], min: 0, max: 2, step: 1, def: 0, display: 'stepMod' },
  // These five are drawn as glyphs rather than sliders -- see ui/LogicOpControl.js and
  // ui/TrigLoopControl.js -- so `display` and `short` reach aria text and captions only.
  // logicOp needs no `display`: its control takes the operator names from LOGIC_OPS.
  { key: 'logicOp', label: 'Logic Operator', group: 'Rhythm', target: 'track', min: 1, max: 4, step: 1, def: 1 },
  { key: 'probability', label: 'Trig Probability', group: 'Rhythm', target: 'track', min: 0, max: 1, step: 0.01, def: 0, display: 'percent' },
  { key: 'trigLoop', label: 'Trig Loop', group: 'Rhythm', target: 'track', type: 'toggle', def: false },
  { key: 'trigLoopLength', label: 'Trig Loop Length', group: 'Rhythm', short: 'Len', target: 'track', min: 1, max: 32, step: 1, def: 1 },
  // Normalised, then scaled by the loop's factorial -- see permutationIndex().
  { key: 'trigPerm', label: 'Rhythm Permutation', group: 'Rhythm', target: 'track', min: 0, max: 1, step: 0.001, def: 0, display: 'percent' },

  // ---- Pitch --------------------------------------------------------------
  // Note bias/spread are integer-only and shown as note names / semitone counts
  // (`display`, read by BiasSpreadSlider) rather than raw MIDI numbers: a
  // fractional pitch centre or a fractional semitone count isn't meaningful the
  // way it is for, say, velocity. Spread reaches 0 so a fully deterministic
  // pitch is available.
  { key: 'noteBias', label: 'Note Bias', group: 'Pitch', target: 'track', min: 1, max: 127, step: 1, def: 51, display: 'note' },
  { key: 'noteSpread', label: 'Note Spread', group: 'Pitch', target: 'track', min: 0, max: 40, step: 1, def: 4, display: 'semitones' },
  { key: 'scale', label: 'Scale', group: 'Pitch', target: 'track', min: 1, max: 10, step: 1, def: 1, display: 'scale' },
  // Amount and curve are separate params, rendered as one control by
  // GlideControl.js -- see Track.js's #ramp for how they combine.
  { key: 'glideAmount', label: 'Glide', group: 'Pitch', target: 'track', min: 0, max: 1, step: 0.01, def: 0, display: 'percent' },
  // false = linear, true = exponential.
  { key: 'glideMode', label: 'Glide Mode', group: 'Pitch', target: 'track', type: 'toggle', def: false },
  { key: 'noteLoop', label: 'Notes Loop', group: 'Pitch', target: 'track', type: 'toggle', def: false },
  { key: 'noteLoopLength', label: 'Notes Loop Length', group: 'Pitch', short: 'Len', target: 'track', min: 1, max: 32, step: 1, def: 1 },
  { key: 'notePerm', label: 'Notes Permutation', group: 'Pitch', target: 'track', min: 0, max: 1, step: 0.001, def: 0, display: 'percent' },

  // ---- Velocity -----------------------------------------------------------
  // Stored as 0.1..1, which is what VELOCITY_DISTRIBUTION's formulas are
  // calibrated against. `display: 'percent'` only changes what BiasSpreadSlider
  // shows (55% rather than 0.55); the step is already 1 percentage point.
  { key: 'velBias', label: 'Velocity Bias', group: 'Velocity', target: 'track', min: 0.1, max: 1, step: 0.01, def: 0.55, display: 'percent' },
  { key: 'velSpread', label: 'Velocity Spread', group: 'Velocity', target: 'track', min: 0.1, max: 1, step: 0.01, def: 0.2, display: 'percent' },
  { key: 'velLoop', label: 'Velocity Loop', group: 'Velocity', target: 'track', type: 'toggle', def: false },
  { key: 'velLoopLength', label: 'Velocity Loop Length', group: 'Velocity', short: 'Len', target: 'track', min: 1, max: 32, step: 1, def: 1 },

  // ---- Modulation: one LFO source -----------------------------------------
  // `target: 'modulation'` is not an engine -- these configure the LFO itself, so
  // the routing closure hands them to the Modulation object rather than to a Track,
  // the AudioEngine or the Scheduler. All eight are drawn by ui/LfoPanel.js, so
  // `display` and `short` here reach aria text and readouts only.
  //
  // Amount and target both default to 0, which means the LFO ships inert: adding it
  // changes no existing patch until something is mapped.
  { key: 'lfoShape', label: 'LFO Shape', group: 'Modulation', target: 'modulation', min: 0, max: 1, step: 0.01, def: 0, display: 'lfoShape' },
  { key: 'lfoRate', label: 'LFO Rate', group: 'Modulation', target: 'modulation', min: 0.1, max: 10, step: 0.01, def: 1 },
  { key: 'lfoSync', label: 'LFO Sync', group: 'Modulation', target: 'modulation', type: 'toggle', def: false },
  // Same division set and tri-state modifier as the Euclid step, so one synced cycle
  // spans exactly what one step would -- see lfoPeriod().
  { key: 'lfoDivision', label: 'LFO Division', short: 'Div', group: 'Modulation', target: 'modulation', values: [1, 2, 4, 8, 16, 32], min: 1, max: 32, step: 1, def: 4, display: 'noteValue' },
  { key: 'lfoSyncMod', label: 'LFO Sync Modifier', group: 'Modulation', target: 'modulation', values: [0, 1, 2], min: 0, max: 2, step: 1, def: 0, display: 'stepMod' },
  { key: 'lfoFold', label: 'LFO Fold', group: 'Modulation', target: 'modulation', min: 0, max: 1, step: 0.01, def: 0, display: 'percent' },
  { key: 'lfoAmount', label: 'LFO Amount', group: 'Modulation', target: 'modulation', min: 0, max: 1, step: 0.01, def: 0, display: 'percent' },
  // An index into MOD_TARGETS, where 0 is "not mapped". Stored as a number so it
  // rides the normal snapshot path; `max` is written literally to keep this file
  // import-free, and a test pins it to MOD_TARGETS.length - 1 so the two cannot drift.
  { key: 'lfoTarget', label: 'LFO Target', group: 'Modulation', target: 'modulation', min: 0, max: 12, step: 1, def: 0 },

  // ---- Modal string voice -------------------------------------------------
  // Pluck position lives here, not under Modulation -- it is a property of *where*
  // the string is plucked, the same as decay or damping are properties of how it
  // rings. Still target: 'track' (it drives the per-step generator in Track.js),
  // unlike the voice-level params below it.
  { key: 'modBias', label: 'Pluck Position Bias', group: 'String', target: 'track', min: 2, max: 20, step: 0.1, def: 4 },
  { key: 'modSpread', label: 'Pluck Position Spread', group: 'String', target: 'track', min: 0.1, max: 20, step: 0.1, def: 2 },
  // Mode count is the CPU/quality trade-off: more modes, brighter and costlier.
  { key: 'modes', label: 'Modes', group: 'String', target: 'voice', min: 4, max: 32, step: 1, def: 16 },
  // beta = stiffness / 1000, so 11 gives beta = 0.011 -- a realistic steel string.
  { key: 'stiffness', label: 'Stiffness (β×1000)', group: 'String', target: 'voice', min: 0, max: 40, step: 0.5, def: 11 },
  { key: 'decay', label: 'Decay', group: 'String', target: 'voice', min: 0.25, max: 3, step: 0.01, def: 1 },
  { key: 'damping', label: 'Damping (mode rolloff)', group: 'String', target: 'voice', min: 0, max: 1.5, step: 0.01, def: 0.5 },
  { key: 'pluckSoftness', label: 'Pluck Softness', group: 'String', target: 'voice', min: 0, max: 1, step: 0.01, def: 0.35 },

  // ---- Granulator ---------------------------------------------------------
  { key: 'grainPitch', label: 'Grain Pitch', group: 'Granulator', target: 'voice', min: 0.5, max: 2, step: 0.01, def: 1 },
  { key: 'grainDryWet', label: 'Grain Dry/Wet', group: 'Granulator', target: 'voice', min: -1, max: 1, step: 0.01, def: -1 },

  // ---- Mixer: one track's contribution to the sum --------------------------
  // Drawn on the track tab strip rather than as sliders, which is why 'Mixer' is
  // absent from main.js's CONTROL_GROUPS -- see ui/TrackTabs.js.
  //
  // Muted by default, deliberately. "A track is silent unless something says
  // otherwise" is what makes resetting a track to its defaults safe: four tracks
  // booting audible would stack four copies of the same Euclid pattern. main.js
  // unmutes track 0 once at boot, and every saved patch carries the rest.
  { key: 'mute', label: 'Mute', group: 'Mixer', target: 'voice', type: 'toggle', def: true },
  { key: 'level', label: 'Level', group: 'Mixer', target: 'voice', min: 0, max: 1, step: 0.01, def: 0.8, display: 'percent' },

  // ---- Transport ----------------------------------------------------------
  // The only two global params in the schema. Everything above is per-track.
  { key: 'bpm', label: 'BPM', group: 'Transport', target: 'transport', scope: 'global', min: 30, max: 300, step: 1, def: 120 },
  // target 'master' rather than 'voice': it is the one fader after the sum of all
  // four tracks, so it belongs to the AudioEngine itself and not to any TrackVoice.
  // That split is also what keeps defaultsFor('voice') equal to exactly one
  // track's voice bag.
  { key: 'masterGain', label: 'Master', group: 'Transport', target: 'master', scope: 'global', min: 0, max: 1, step: 0.01, def: 0.8 },
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

/**
 * Nearest member of an enumerated `values` list. Ties resolve downward, matching the
 * convention in scales.js's nearestInList.
 */
function nearestValue(numeric, values) {
  let best = values[0];
  let bestDistance = Infinity;
  for (const candidate of values) {
    const distance = Math.abs(candidate - numeric);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Clamp a numeric param to its declared range. Toggles pass through as booleans. */
export function clampParam(key, value) {
  const spec = byKey.get(key);
  if (!spec) return value;
  if (spec.type === 'toggle') return Boolean(value);
  const numeric = Number(value);
  // Enumerated params snap here too, so a value that somehow reaches an engine without
  // passing through the store still cannot land between allowed settings.
  if (spec.values) {
    return Number.isFinite(numeric) ? nearestValue(numeric, spec.values) : spec.def;
  }
  return Math.min(spec.max, Math.max(spec.min, numeric));
}

/** Decimal places implied by a step size, e.g. 0.01 -> 2, 1 -> 0. */
function decimalsFor(step) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Clamp *and* snap to the param's step -- the canonical form of a value.
 *
 * Stricter than clampParam, which only clamps. A value arriving from outside the
 * UI (a preset, a MIDI controller) can sit between steps, and then the engine
 * would run 0.5537 while a control displaying two decimals showed 0.55. Snapping
 * here means the stored value is exactly what every control can render.
 *
 * Unknown keys pass through untouched so a stale preset key cannot become NaN.
 */
export function normalizeParam(key, value) {
  const spec = byKey.get(key);
  if (!spec) return value;
  if (spec.type === 'toggle') return Boolean(value);

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return spec.def;

  if (spec.values) return nearestValue(numeric, spec.values);

  const step = spec.step > 0 ? spec.step : 1;
  const snapped = Math.round(numeric / step) * step;
  const clamped = Math.min(spec.max, Math.max(spec.min, snapped));
  // Snapping by multiplication leaves float dust (0.30000000000000004); the
  // decimals implied by the step are exactly enough to clear it.
  return Number(clamped.toFixed(decimalsFor(step)));
}
