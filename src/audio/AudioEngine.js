import { buildNote, midiToHz, modeGains } from './modal/modalModel.js';
import { clampParam, defaultsFor } from '../core/paramSchema.js';

/**
 * Owns the AudioContext and node graph, and turns step events into note-ons.
 *
 * Graph:  modal-processor -> granulator-processor -> [FX insert] -> master -> out
 *
 * Physics happens here on the main thread and the worklets receive finished mode
 * tables, so the model stays in one testable place and a note-on is a few hundred
 * bytes rather than a parameter negotiation.
 */
export class AudioEngine {
  constructor(bus) {
    this.bus = bus;
    this.params = defaultsFor('voice');
    this.context = null;
    this.modalNode = null;
    this.granulatorNode = null;
    this.masterGain = null;
    this.ready = false;
  }

  /**
   * Build the graph. Must be called from a user gesture -- browsers refuse to
   * start an AudioContext otherwise.
   */
  async init() {
    if (this.ready) return;

    this.context = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
    });

    await Promise.all([
      this.context.audioWorklet.addModule('./src/audio/worklets/modal-processor.js'),
      this.context.audioWorklet.addModule('./src/audio/worklets/granulator-processor.js'),
    ]);

    // Mono throughout; the destination node up-mixes to stereo.
    this.modalNode = new AudioWorkletNode(this.context, 'modal-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.granulatorNode = new AudioWorkletNode(this.context, 'granulator-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.params.masterGain;

    // An FX insert would go between the granulator and the master gain; nothing
    // else needs to move to add one.
    this.modalNode.connect(this.granulatorNode);
    this.granulatorNode.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);

    this.#pushVoiceParams();
    this.ready = true;
  }

  async resume() {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  get currentTime() {
    return this.context ? this.context.currentTime : 0;
  }

  setParam(key, value) {
    if (!(key in this.params)) return;
    this.params[key] = clampParam(key, value);
    if (!this.ready) return;

    if (key === 'masterGain') {
      // Short ramp rather than a jump, so dragging the fader does not click.
      this.masterGain.gain.setTargetAtTime(this.params.masterGain, this.currentTime, 0.01);
    } else if (key === 'grainPitch' || key === 'grainDryWet') {
      this.#pushGranulatorParams();
    }
    // The remaining voice params (modes, stiffness, decay, damping, softness) are
    // read when the next note is built, so they need no message.
  }

  #pushVoiceParams() {
    this.#pushGranulatorParams();
    this.masterGain.gain.value = this.params.masterGain;
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

  /** Silence every ringing voice -- used when the transport stops. */
  panic() {
    this.modalNode?.port.postMessage({ type: 'panic' });
  }
}
