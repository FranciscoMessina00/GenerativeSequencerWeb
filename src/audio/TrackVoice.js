import { buildNote, midiToHz, modeGains } from './modal/modalModel.js';
import { clampParam, defaultsFor } from '../core/paramSchema.js';

/**
 * One track's own signal chain, from its string to its contribution to the mix.
 *
 *   modal-processor -> granulator-processor -> trim -> (the engine's master clip)
 *
 * Every track gets its own, so four pages can hold four different timbres and
 * four different granular settings. What they share is the AudioContext, the
 * master limiter and the master fader -- all of which belong to AudioEngine,
 * which is why this class takes a context and a destination rather than making
 * either.
 *
 * The constructor holds params only and builds no nodes: a browser refuses to
 * start an AudioContext outside a user gesture, so a patch can be loaded and
 * every control dialled in long before there is a graph to write to. attach()
 * is where the nodes appear, and it flushes whatever accumulated meanwhile.
 *
 * Physics happens on the main thread and the worklet receives finished mode
 * tables, so the model stays in one testable place and a note-on is a few hundred
 * bytes rather than a parameter negotiation.
 */
export class TrackVoice {
  constructor(trackId = 0) {
    this.trackId = trackId;
    this.params = defaultsFor('voice');
    this.context = null;
    this.modalNode = null;
    this.granulatorNode = null;
    this.trim = null;
    this.ready = false;
  }

  /**
   * Build this track's nodes and join the mix. The worklet modules must already
   * be registered on `context` -- AudioEngine.init() does that once for all
   * tracks, since addModule is per-context, not per-node.
   */
  attach({ context, destination }) {
    if (this.ready) return;
    this.context = context;

    // Mono throughout; the destination node up-mixes to stereo.
    this.modalNode = new AudioWorkletNode(context, 'modal-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.granulatorNode = new AudioWorkletNode(context, 'granulator-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Mute and level are one node, not two: they are the same question asked
    // twice, and a muted track that still ramps its level would click on unmute.
    this.trim = context.createGain();

    // A per-track FX insert would go between the granulator and the trim.
    this.modalNode.connect(this.granulatorNode);
    this.granulatorNode.connect(this.trim);
    this.trim.connect(destination);

    this.ready = true;
    this.#pushParams();
  }

  get currentTime() {
    return this.context ? this.context.currentTime : 0;
  }

  /** Silent when muted, otherwise the level the user set. */
  #trimGain() {
    return this.params.mute ? 0 : this.params.level;
  }

  setParam(key, value) {
    if (!(key in this.params)) return;
    this.params[key] = clampParam(key, value);
    if (!this.ready) return;

    if (key === 'mute' || key === 'level') {
      this.#pushTrim();
    } else if (key === 'grainPitch' || key === 'grainDryWet') {
      this.#pushGranulatorParams();
    }
    // The remaining voice params (modes, stiffness, decay, damping, softness) are
    // read when the next note is built, so they need no message.
  }

  #pushParams() {
    this.#pushGranulatorParams();
    this.trim.gain.value = this.#trimGain();
  }

  #pushTrim() {
    // Short ramp rather than a jump, so muting or dragging the level does not click.
    this.trim.gain.setTargetAtTime(this.#trimGain(), this.currentTime, 0.01);
  }

  #pushGranulatorParams() {
    const t = this.currentTime;
    this.granulatorNode.parameters.get('grainPitch').setTargetAtTime(this.params.grainPitch, t, 0.01);
    this.granulatorNode.parameters.get('dryWet').setTargetAtTime(this.params.grainDryWet, t, 0.01);
  }

  /**
   * Sound one step.
   *
   * The step carries the note it decided on plus the note before it, because both
   * glides in this instrument ramp *from the previous value into the current one*
   * across the step.
   *
   * A muted track still builds and sends its note. The trim is what silences it,
   * so unmuting mid-phrase reveals a string that was already ringing rather than
   * starting from nothing -- and the voice pool's behaviour does not change with
   * mute state.
   */
  noteOn(step) {
    if (!this.ready || !step.triggered) return;

    const p = this.params;
    const note = buildNote({
      midinote: step.note,
      velocity: step.velocity,
      pluckPosition: step.mod,
      modes: p.modes,
      stiffness: p.stiffness,
      damping: p.damping,
      decayScale: p.decay,
      sampleRate: this.context.sampleRate,
    });

    // Gains at both ends of the plucking-position ramp. With no ramp the two are
    // identical and the worklet's blend is a no-op.
    const gainsTo = note.gains;
    const gainsFrom =
      step.modTime > 0 ? modeGains(note.count, step.prevMod) : gainsTo;

    this.modalNode.port.postMessage({
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
    });
  }

  /** Silence every ringing voice on this track alone. */
  panic() {
    this.modalNode?.port.postMessage({ type: 'panic' });
  }
}
