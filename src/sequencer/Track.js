import { TriggerGenerator } from './generators/TriggerGenerator.js';
import { ValueGenerator } from './generators/ValueGenerator.js';
import {
  NOTE_DISTRIBUTION,
  VELOCITY_DISTRIBUTION,
  MOD_DISTRIBUTION,
} from './generators/distributions.js';
import { clampParam, defaultsFor } from '../core/paramSchema.js';

/**
 * One sequencer channel: its parameters plus the four generators that read them.
 *
 * Phase 1 constructs exactly one Track, but nothing here is a singleton --
 * adding channels means constructing more Tracks and giving each its own
 * `trackId`. The Scheduler already iterates a list and tags every event.
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

      case 'modLoop':
      case 'modLoopLength':
        this.mod.setLoopEnabled(this.params.modLoop, this.params.modLoopLength);
        break;

      default:
        break;
    }
  }

  #rebuildPattern() {
    const { steps, pulses, rotation } = this.params;
    // Triggers cannot exceed steps; the Processing GUI allowed both to reach 32
    // independently, and pulses > steps degenerates to every step active.
    this.trigger.setPattern(steps, Math.min(pulses, steps), rotation);
  }

  #recaptureAllLoops() {
    const p = this.params;
    this.trigger.setLoopEnabled(p.trigLoop, p.trigLoopLength, p.trigPerm);
    this.note.setLoopEnabled(p.noteLoop, p.noteLoopLength, p.notePerm);
    this.velocity.setLoopEnabled(p.velLoop, p.velLoopLength);
    this.mod.setLoopEnabled(p.modLoop, p.modLoopLength);
  }

  getPattern() {
    return this.trigger.getPattern();
  }

  /**
   * Convert a -1..1 glide/interp knob into a ramp spec.
   *
   * From `TriggerWithGlide.scd:387-393`: the ramp lasts one step minus 30 ms
   * scaled by the knob magnitude, and the sign chooses the curve -- negative
   * uses `Line.kr` (linear in pitch), positive uses `XLine.kr` (exponential in
   * frequency, i.e. linear in pitch-space). Zero skips the ramp entirely, which
   * the original did to dodge a glitch with zero-length lines.
   */
  #rampFor(amount, stepDuration) {
    if (amount === 0) return { time: 0, exponential: false };
    return {
      time: Math.max(0, (stepDuration - 0.03) * Math.abs(amount)),
      exponential: amount > 0,
    };
  }

  /**
   * Advance one step and describe it.
   *
   * All four generators advance on every step, including untriggered ones. That
   * matches Pbind, which pulls every key's stream per event and only afterwards
   * turns the event into a `Rest` -- so the random walks keep moving through
   * silence rather than freezing.
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

    const glide = this.#rampFor(p.glide, stepDuration);
    const modRamp = this.#rampFor(p.modInterp, stepDuration);

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
