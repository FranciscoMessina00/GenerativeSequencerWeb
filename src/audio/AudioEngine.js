import { TrackVoice } from './TrackVoice.js';
import { clampParam, defaultsFor } from '../core/paramSchema.js';

/**
 * Owns the AudioContext and everything the tracks share, and hands each step to
 * the track that produced it.
 *
 * Graph:  N x TrackVoice -> master clip -> master gain -> out
 *
 * What is shared and what is not was a deliberate cut. Shared: one context (four
 * would mean four hardware clocks with no way to align them), one limiter, one
 * fader. Per track: the string and the granulator, because that is what makes a
 * page sound like its own instrument -- see TrackVoice.js.
 *
 * The master limiter exists because four already-limited tracks still sum past
 * full scale; it is exact identity for one track at the default level, so it
 * changes nothing about how existing patches sound. See master-clip-processor.js.
 */
export class AudioEngine {
  constructor(bus, { trackCount = 1 } = {}) {
    this.bus = bus;
    this.master = defaultsFor('master');
    /** One chain per track, holding params from the start and nodes from init(). */
    this.voices = Array.from({ length: trackCount }, (_, i) => new TrackVoice(i));
    this.context = null;
    this.masterClip = null;
    this.masterGain = null;
    this.ready = false;
  }

  /**
   * Build the graph. Must be called from a user gesture -- browsers refuse to
   * start an AudioContext otherwise.
   */
  async init() {
    if (this.ready) return;

    // webkitAudioContext is the legacy Safari spelling, absent from the standard
    // Window type; the cast keeps the fallback without pretending it is standard.
    const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    this.context = new Ctor({ latencyHint: 'interactive' });

    // Per context, not per node: every TrackVoice instantiates the same two
    // processors, so registering them once here is all four of them need.
    await Promise.all([
      this.context.audioWorklet.addModule('./src/audio/worklets/modal-processor.js'),
      this.context.audioWorklet.addModule('./src/audio/worklets/granulator-processor.js'),
      this.context.audioWorklet.addModule('./src/audio/worklets/master-clip-processor.js'),
    ]);

    this.masterClip = new AudioWorkletNode(this.context, 'master-clip-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.master.masterGain;

    // A global FX insert would go between the clip and the master gain.
    this.masterClip.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);

    // The tracks sum by fanning into the limiter's single input.
    for (const voice of this.voices) {
      voice.attach({ context: this.context, destination: this.masterClip });
    }

    this.ready = true;
  }

  async resume() {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  get currentTime() {
    return this.context ? this.context.currentTime : 0;
  }

  /** Route a `target: 'voice'` param to the one track that owns it. */
  setVoiceParam(key, value, trackId) {
    this.voices[trackId]?.setParam(key, value);
  }

  /** Route a `target: 'master'` param, which belongs to no single track. */
  setMasterParam(key, value) {
    if (!(key in this.master)) return;
    this.master[key] = clampParam(key, value);
    if (!this.ready) return;

    if (key === 'masterGain') {
      // Short ramp rather than a jump, so dragging the fader does not click.
      this.masterGain.gain.setTargetAtTime(this.master.masterGain, this.currentTime, 0.01);
    }
  }

  /** Sound one step, on whichever track decided it. */
  noteOn(step) {
    this.voices[step.trackId]?.noteOn(step);
  }

  /**
   * Silence every ringing voice on every track -- used when the transport stops.
   * Each track has its own 16-voice pool, so this has to reach all of them.
   */
  panic() {
    for (const voice of this.voices) voice.panic();
  }
}
