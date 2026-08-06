import { instrumentById } from './instruments.js';
import { clampParam, defaultsFor } from '../core/paramSchema.js';

/**
 * One track's own signal chain, from its instrument to its contribution to the mix.
 *
 *   <instrument> -> granulator-processor -> trim -> (the engine's master clip)
 *
 * Every track gets its own, so four pages can hold four different instruments with
 * four different granular settings. What they share is the AudioContext, the
 * master limiter and the master fader -- all of which belong to AudioEngine,
 * which is why this class takes a context and a destination rather than making
 * either.
 *
 * Only the source varies. The granulator stays in the chain for every instrument
 * because it costs nothing when unused -- `grainDryWet` defaults to −1, which that
 * processor treats as a true bypass -- and it means a kick can be granulated without
 * any of this changing.
 *
 * The constructor holds params only and builds no nodes: a browser refuses to
 * start an AudioContext outside a user gesture, so a patch can be loaded and
 * every control dialled in long before there is a graph to write to. attach()
 * is where the nodes appear, and it flushes whatever accumulated meanwhile.
 *
 * Which instrument sounds, and how a step becomes a note-on, are both looked up in
 * audio/instruments.js rather than decided here -- so this class stays a router and
 * adding an instrument does not touch it.
 */

/** Every instrument is a mono source with no input. */
const SOURCE_OPTIONS = {
  numberOfInputs: 0,
  numberOfOutputs: 1,
  outputChannelCount: [1],
};

export class TrackVoice {
  constructor(trackId = 0) {
    this.trackId = trackId;
    this.params = defaultsFor('voice');
    this.context = null;
    /** The instrument's own processor node, rebuilt when the instrument changes. */
    this.source = null;
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
    this.granulatorNode = new AudioWorkletNode(context, 'granulator-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Mute and level are one node, not two: they are the same question asked
    // twice, and a muted track that still ramps its level would click on unmute.
    this.trim = context.createGain();

    // A per-track FX insert would go between the granulator and the trim.
    this.granulatorNode.connect(this.trim);
    this.trim.connect(destination);

    this.#buildSource();

    this.ready = true;
    this.#pushParams();
  }

  /** The node for whichever instrument this track currently plays. */
  #buildSource() {
    const instrument = instrumentById(this.params.instrument);
    this.source = new AudioWorkletNode(this.context, instrument.processor, SOURCE_OPTIONS);
    this.source.connect(this.granulatorNode);
  }

  /**
   * Swap the instrument.
   *
   * Panic before disconnecting: an orphaned node keeps rendering its tail into nothing,
   * and on a long string decay that is seconds of CPU spent on silence. Disconnecting
   * without it also leaves the old voice mid-ring if it is ever reconnected.
   *
   * The granulator's buffer is deliberately left alone -- it holds a moment of the
   * previous instrument, which fades out of the buffer on its own within three seconds
   * and is a far smaller artefact than a rebuilt granulator's silence would be.
   */
  #swapSource() {
    this.source.port.postMessage({ type: 'panic' });
    this.source.disconnect();
    this.#buildSource();
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
    } else if (key === 'instrument') {
      this.#swapSource();
    }
    // Every remaining voice param is latched when the next hit is built, so it needs
    // no message -- see the buildMessage functions in audio/instruments.js.
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
   * Sound one step, on whichever instrument this track plays.
   *
   * A router: the instrument's own builder turns the step into the message its
   * processor understands, so this method needs no knowledge of any of them. Each
   * builder reaches only for the params its instrument owns, which is what lets a
   * track carry settings for all four at once.
   *
   * A muted track still builds and sends its note. The trim is what silences it,
   * so unmuting mid-phrase reveals an instrument that was already ringing rather
   * than starting from nothing -- and the voice pool's behaviour does not change
   * with mute state.
   */
  noteOn(step) {
    if (!this.ready || !step.triggered) return;
    const instrument = instrumentById(this.params.instrument);
    this.source.port.postMessage(
      instrument.buildMessage(step, this.params, this.context.sampleRate),
    );
  }

  /** Silence every ringing voice on this track alone. */
  panic() {
    this.source?.port.postMessage({ type: 'panic' });
  }
}
