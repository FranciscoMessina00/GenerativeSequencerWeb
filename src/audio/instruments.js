import { buildNote, midiToHz, modeGains } from './modal/modalModel.js';
import { hatHit, kickHit, snareHit } from './percussion/percussionModel.js';
import { ahdEnvelope } from './envelope.js';

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
    // The only instrument claiming envHold -- which is what makes the "each builder
    // reaches only for its own instrument's params" test in test/instruments.test.js
    // prove the three percussion builders never read it.
    params: [
      'modes', 'stiffness', 'damping', 'pluckSoftness',
      'envAttack', 'envHold', 'envDecay', 'envCurve',
    ],
    buildMessage: buildStringMessage,
  },
  {
    id: 1,
    key: 'kick',
    name: 'Kick',
    group: 'Kick',
    processor: 'kick-processor',
    params: [
      'kickSweep', 'kickSweepTime', 'kickNoise', 'kickNoiseColor',
      'envAttack', 'envDecay', 'envCurve',
    ],
    buildMessage: buildKickMessage,
  },
  {
    id: 2,
    key: 'snare',
    name: 'Snare',
    group: 'Snare',
    processor: 'snare-processor',
    params: [
      'snareNoise', 'snareNoiseColor', 'snareTone', 'snareBodyDecay',
      'envAttack', 'envDecay', 'envCurve',
    ],
    buildMessage: buildSnareMessage,
  },
  {
    id: 3,
    key: 'hihat',
    name: 'Hi-hat',
    group: 'Hi-hat',
    processor: 'hihat-processor',
    params: ['hatNoise', 'hatNoiseColor', 'envAttack', 'envDecay', 'envCurve'],
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
 * How many milliseconds of `envDecay` make one unit of the string's decayScale.
 *
 * The string is the one instrument whose decay is physics rather than a gain ramp:
 * modeDecays() turns this into a per-mode T60, so damping and velocity keep shaping
 * the ring exactly as they always did. 1000 is the identity with the `decay` param
 * this replaced -- the old `decay: 1` is `envDecay: 1000 ms` -- which is what keeps
 * every patch authored against the old knob sounding like itself.
 *
 * One named number rather than an inline divide, because it is the single thing to
 * turn if the string's tail should sit longer or shorter against the same dial.
 */
const MS_PER_DECAY_UNIT = 1000;

/**
 * The amplitude envelope for one hit, cut against the step it lands on.
 *
 * `holdMs` is passed by the caller rather than read from `p` here: only the string
 * has a hold stage, and the three percussion builders pass 0 so that a drum stays a
 * strike instead of a tone gated open for a whole step.
 */
function envelopeFor(step, p, holdMs) {
  return ahdEnvelope({
    attackMs: p.envAttack,
    holdMs,
    decayMs: p.envDecay,
    // Scheduler.pump() puts this on every step; a hit built outside the sequencer
    // has none, and audio/envelope.js then truncates nothing.
    stepSeconds: step.stepDuration,
    exponential: p.envCurve,
  });
}

/**
 * The string.
 *
 * The mode tables are built here on the main thread and handed over finished, so the
 * physics lives in one testable place and a note-on is a few hundred bytes rather than
 * a parameter negotiation. Both glides ramp *from the previous value into the current
 * one* across the step, which is why the step carries both ends.
 *
 * The only instrument that uses `envDecay` twice: once as the ring the modes are
 * given (decayScale, below) and once as the envelope's own decay stage over the top.
 * That is deliberate -- it is one dial meaning one thing, "how long is this note",
 * expressed in the two places a struck string's length actually lives.
 */
function buildStringMessage(step, p, sampleRate) {
  const note = buildNote({
    midinote: step.note,
    // Only when actually gliding -- see buildNote's header. Otherwise prevNote is
    // just whatever the generator produced last step, triggered or not, and has no
    // bearing on this note's own Nyquist safety.
    glideFromMidinote: step.glideTime > 0 ? step.prevNote : undefined,
    velocity: step.velocity,
    pluckPosition: step.mod,
    modes: p.modes,
    stiffness: p.stiffness,
    damping: p.damping,
    decayScale: p.envDecay / MS_PER_DECAY_UNIT,
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

    env: envelopeFor(step, p, p.envHold),
  };
}

// The three percussion builders pass a zero hold, which is the whole of "hold is the
// string's alone": the panel hides the control for them (ui/EnvelopePanel.js), and
// none of these three reads p.envHold, so the hidden value cannot leak into a hit.

function buildKickMessage(step, p) {
  return {
    type: 'noteOn',
    startTime: step.audioTime,
    env: envelopeFor(step, p, 0),
    ...kickHit({
      note: step.note,
      velocity: step.velocity,
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
    env: envelopeFor(step, p, 0),
    ...snareHit({
      note: step.note,
      velocity: step.velocity,
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
    env: envelopeFor(step, p, 0),
    ...hatHit({
      note: step.note,
      velocity: step.velocity,
      noise: p.hatNoise,
      noiseColor: p.hatNoiseColor,
    }),
  };
}
