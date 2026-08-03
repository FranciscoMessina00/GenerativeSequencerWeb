import { TriggerGenerator } from './generators/TriggerGenerator.js';
import { ValueGenerator } from './generators/ValueGenerator.js';
import {
  NOTE_DISTRIBUTION,
  VELOCITY_DISTRIBUTION,
  MOD_DISTRIBUTION,
} from './generators/distributions.js';
import { clampParam, defaultsFor } from '../core/paramSchema.js';
import { stepModFactor } from './stepDivision.js';

/**
 * One sequencer channel: its parameters plus the four generators that read them.
 *
 * Nothing here is a singleton -- adding channels means constructing more Tracks
 * with their own `trackId`. The Scheduler already iterates a list and tags every
 * event with the track that produced it.
 */
export class Track {
  constructor(trackId, rng) {
    this.trackId = trackId;
    this.rng = rng;
    this.params = defaultsFor('track');

    this.trigger = new TriggerGenerator(rng);
    this.note = new ValueGenerator(NOTE_DISTRIBUTION, rng);
    this.velocity = new ValueGenerator(VELOCITY_DISTRIBUTION, rng);
    this.mod = new ValueGenerator(MOD_DISTRIBUTION, rng);

    // Push the defaults through the same side-effect paths a UI change uses,
    // so initial state and post-interaction state are produced identically.
    this.#rebuildPattern();
    this.#recaptureAllLoops();
  }

  /**
   * Apply a parameter change. Unknown keys are ignored so a Track can safely
   * receive the whole param stream off the bus.
   */
  setParam(key, value) {
    if (!(key in this.params)) return;
    this.params[key] = clampParam(key, value);

    switch (key) {
      case 'steps':
      case 'pulses':
      case 'rotation':
        this.#rebuildPattern();
        break;

      case 'trigLoop':
      case 'trigLoopLength':
      case 'trigPerm':
        this.trigger.setLoopEnabled(
          this.params.trigLoop,
          this.params.trigLoopLength,
          this.params.trigPerm,
        );
        break;

      case 'noteLoop':
      case 'noteLoopLength':
      case 'notePerm':
        this.note.setLoopEnabled(
          this.params.noteLoop,
          this.params.noteLoopLength,
          this.params.notePerm,
        );
        break;

      case 'velLoop':
      case 'velLoopLength':
        this.velocity.setLoopEnabled(this.params.velLoop, this.params.velLoopLength);
        break;

      default:
        break;
    }
  }

  #rebuildPattern() {
    const { steps, pulses, rotation } = this.params;
    // Both reach 32 independently, but pulses > steps degenerates to every step
    // active, so it is capped here instead.
    this.trigger.setPattern(steps, Math.min(pulses, steps), rotation);
  }

  #recaptureAllLoops() {
    const p = this.params;
    this.trigger.setLoopEnabled(p.trigLoop, p.trigLoopLength, p.trigPerm);
    this.note.setLoopEnabled(p.noteLoop, p.noteLoopLength, p.notePerm);
    this.velocity.setLoopEnabled(p.velLoop, p.velLoopLength);
  }

  getPattern() {
    return this.trigger.getPattern();
  }

  /**
   * Seconds per step, given the length of one bar.
   *
   * The track owns this rather than the scheduler because the division is a track
   * parameter: the scheduler knows the tempo, each track decides how it subdivides it.
   * That is what lets two tracks run at different speeds off one clock.
   *
   * Note this is the duration of *one step*, not of the cycle -- so changing `steps`
   * lengthens or shortens the cycle while leaving the step division alone.
   */
  stepDuration(barSeconds) {
    return (barSeconds / this.params.stepDivision) * stepModFactor(this.params.stepMod);
  }

  /**
   * Ramp-time formula for glide. The ramp lasts one step minus 30 ms scaled by
   * magnitude, and the mode picks the curve: exponential in frequency (linear in
   * pitch-space) or plain linear. Zero magnitude skips the ramp, which also makes
   * the mode moot -- there is nothing to shape.
   */
  #ramp(magnitude, exponential, stepDuration) {
    if (magnitude === 0) return { time: 0, exponential: false };
    return {
      time: Math.max(0, (stepDuration - 0.03) * magnitude),
      exponential,
    };
  }

  /**
   * Advance one step and describe it.
   *
   * All four generators advance on every step, including untriggered ones, so the
   * random walks keep moving through silence rather than freezing until the next
   * note fires.
   *
   * @param {number} stepDuration seconds per step, for glide timing
   */
  step(stepDuration) {
    const p = this.params;

    const trig = this.trigger.step({
      probability: p.probability,
      logicOp: p.logicOp,
    });

    const note = this.note.step({
      bias: p.noteBias,
      spread: p.noteSpread,
      scale: p.scale,
    });

    const velocity = this.velocity.step({
      bias: p.velBias,
      spread: p.velSpread,
    });

    const mod = this.mod.step({
      bias: p.modBias,
      spread: p.modSpread,
    });

    const glide = this.#ramp(p.glideAmount, p.glideMode, stepDuration);
    // Pluck-position interpolation was removed; this stays fixed at what its
    // default (modInterp: 0) already produced -- an instant, un-ramped change.
    const modRamp = { time: 0, exponential: false };

    return {
      trackId: this.trackId,
      stepIndex: trig.stepIndex,
      triggered: trig.triggered,
      euclidBit: trig.euclidBit,
      randomBit: trig.randomBit,
      note: note.value,
      prevNote: note.previous,
      velocity: velocity.value,
      mod: mod.value,
      prevMod: mod.previous,
      glideTime: glide.time,
      glideExponential: glide.exponential,
      modTime: modRamp.time,
      modExponential: modRamp.exponential,
    };
  }
}
