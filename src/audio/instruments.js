import { buildNote, midiToHz, modeGains } from './modal/modalModel.js';
import { hatHit, kickHit, snareHit } from './percussion/percussionModel.js';

/**
 * What a track can play.
 *
 * One entry per instrument, and each one carries everything the rest of the app needs
 * to know about it: what to call it, which worklet processor sounds it, which control
 * group holds its parameters, and how a step becomes a note-on. That last field is the
 * point -- `TrackVoice.noteOn` is a one-line router, so adding an instrument means
 * adding an entry here and a processor, not editing a switch in three places.
 *
 * Modelled on sequencer/scales.js: an array whose **index is the stored value** of the
 * `instrument` param, plus a lookup. So, like MOD_TARGETS: **append only.** Inserting
 * or reordering silently repoints every saved patch at a different instrument.
 *
 * `params` is not read by the audio path -- the group is what the UI renders from. It
 * is here so a test can assert that every parameter an instrument claims actually
 * exists in the schema with voice scope, which is the sort of thing that rots quietly.
 */
export const INSTRUMENTS = [
  {
    id: 0,
    key: 'string',
    name: 'Modal String',
    group: 'String',
    processor: 'modal-processor',
    params: ['modes', 'stiffness', 'decay', 'damping', 'pluckSoftness'],
    buildMessage: buildStringMessage,
  },
  {
    id: 1,
    key: 'kick',
    name: 'Kick',
    group: 'Kick',
    processor: 'kick-processor',
    params: ['kickDecay', 'kickSweep', 'kickSweepTime', 'kickNoise', 'kickNoiseColor'],
    buildMessage: buildKickMessage,
  },
  {
    id: 2,
    key: 'snare',
    name: 'Snare',
    group: 'Snare',
    processor: 'snare-processor',
    params: ['snareDecay', 'snareNoise', 'snareNoiseColor', 'snareTone', 'snareBodyDecay'],
    buildMessage: buildSnareMessage,
  },
  {
    id: 3,
    key: 'hihat',
    name: 'Hi-hat',
    group: 'Hi-hat',
    processor: 'hihat-processor',
    params: ['hatDecay', 'hatNoise', 'hatNoiseColor'],
    buildMessage: buildHatMessage,
  },
];

/** The control-panel groups the instruments own, in instrument order. */
export const INSTRUMENT_GROUPS = INSTRUMENTS.map((i) => i.group);

/**
 * The instrument a stored `instrument` value names.
 *
 * Falls back to the first rather than to undefined: a patch from a future version
 * naming an instrument this build does not have should play something.
 */
export function instrumentById(id) {
  return INSTRUMENTS[Math.trunc(Number(id)) || 0] ?? INSTRUMENTS[0];
}

// ---------------------------------------------------------------------------
// Note-on builders
//
// One per instrument, each returning the message its own processor expects. They take
// the step and the track's whole voice-param bag, and reach only for the keys their
// instrument owns -- so a track carrying settings for all four instruments hands each
// processor exactly what it understands and nothing else.
// ---------------------------------------------------------------------------

/**
 * The string.
 *
 * The mode tables are built here on the main thread and handed over finished, so the
 * physics lives in one testable place and a note-on is a few hundred bytes rather than
 * a parameter negotiation. Both glides ramp *from the previous value into the current
 * one* across the step, which is why the step carries both ends.
 */
function buildStringMessage(step, p, sampleRate) {
  const note = buildNote({
    midinote: step.note,
    velocity: step.velocity,
    pluckPosition: step.mod,
    modes: p.modes,
    stiffness: p.stiffness,
    damping: p.damping,
    decayScale: p.decay,
    sampleRate,
  });

  // Gains at both ends of the plucking-position ramp. With no ramp the two are
  // identical and the worklet's blend is a no-op.
  const gainsTo = note.gains;
  const gainsFrom = step.modTime > 0 ? modeGains(note.count, step.prevMod) : gainsTo;

  return {
    type: 'noteOn',
    startTime: step.audioTime,
    count: note.count,
    ratios: note.ratios,
    decays: note.decays,
    gainsFrom,
    gainsTo,

    f0From: step.glideTime > 0 ? midiToHz(step.prevNote) : midiToHz(step.note),
    f0To: midiToHz(step.note),
    glideTime: step.glideTime,
    glideExponential: step.glideExponential,

    mFrom: step.prevMod,
    mTo: step.mod,
    modTime: step.modTime,
    modExponential: step.modExponential,

    velocity: step.velocity,
    pluckSoftness: p.pluckSoftness,
  };
}

function buildKickMessage(step, p) {
  return {
    type: 'noteOn',
    startTime: step.audioTime,
    ...kickHit({
      note: step.note,
      velocity: step.velocity,
      decay: p.kickDecay,
      sweep: p.kickSweep,
      sweepTime: p.kickSweepTime,
      noise: p.kickNoise,
      noiseColor: p.kickNoiseColor,
    }),
  };
}

function buildSnareMessage(step, p) {
  return {
    type: 'noteOn',
    startTime: step.audioTime,
    ...snareHit({
      note: step.note,
      velocity: step.velocity,
      decay: p.snareDecay,
      noise: p.snareNoise,
      noiseColor: p.snareNoiseColor,
      tone: p.snareTone,
      bodyDecay: p.snareBodyDecay,
    }),
  };
}

function buildHatMessage(step, p) {
  return {
    type: 'noteOn',
    startTime: step.audioTime,
    ...hatHit({
      note: step.note,
      velocity: step.velocity,
      decay: p.hatDecay,
      noise: p.hatNoise,
      noiseColor: p.hatNoiseColor,
    }),
  };
}
