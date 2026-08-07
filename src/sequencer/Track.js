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

    // What glide ramps from. Not the note generator's own `previous` -- that is
    // whatever the last STEP produced, triggered or not, and the generators advance
    // on every step (see step()'s comment) so most of those values were never heard.
    // Gliding from one of them would be a glide from nowhere real. `null` until the
    // first note actually plays, at which point there is nothing to glide from yet
    // either, so step() falls back to that note itself.
    this.lastPlayedNote = null;

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

  /**
   * Rewind to the start on transport stop. Only the Euclidean cursor
   * actually resets to 0; every loop (trigger's own included) has its phase
   * shifted by the same amount instead, so its alignment to the pattern
   * carries over seamlessly rather than jumping by however long playback
   * ran before this stop -- see TriggerGenerator.resetPlayhead(). Read
   * before the trigger's cursor gets zeroed. `lastPlayedNote` resets too, so
   * the first note after resuming never glides in from a note that sounded
   * before the stop.
   */
  resetPlayhead() {
    const shift = -this.trigger.stepIndex;
    this.trigger.resetPlayhead();
    this.note.resetPlayhead(shift);
    this.velocity.resetPlayhead(shift);
    this.mod.resetPlayhead(shift);
    this.lastPlayedNote = null;
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

  /** The Euclidean cursor's current ring position -- see resetPlayhead(). */
  get stepIndex() {
    return this.trigger.stepIndex;
  }

  /**
   * The rhythm loop's next `count` random bits -- for the ring's buffer
   * overlay, painted directly onto ring positions 0..count-1 with no
   * rotation. Only correct when the Euclidean cursor is ALSO at position 0
   * right now: main.js's one wrap-triggered caller reaches this exactly
   * when the cursor has just landed back there, which is also why it needs
   * no +1 lag correction -- the value for position 0 was already consumed
   * (this step's own advanceLoop() already ran) by the time it calls this.
   * Every other caller reads mid-cycle and wants getTrigLoopProjection()
   * instead.
   */
  getTrigLoopWindow(count) {
    return this.trigger.getLoopWindow(count);
  }

  /**
   * The rhythm loop's upcoming content, one value per ring position, for a
   * snapshot taken *before* any step has consumed a value under the current
   * loop state -- activating the loop, changing its length/permutation
   * while armed, or switching to a different track. `fromRingPosition`
   * (pass `this.stepIndex`) is where result[0] lands; result[1] the ring
   * position after that, wrapping.
   *
   * Two things getTrigLoopWindow's raw, phase-0-first result doesn't
   * account for on its own, both handled here:
   *
   *  - Rotation: the cursor generally isn't at position 0 for these
   *    callers, so painting the raw window directly would line result[0]
   *    up with the wrong ring sector.
   *  - The one-step lag: getLoopWindow's own k=0 is "whatever the loop
   *    would read right now, with no further advance" -- but every
   *    generator's step() always advances before it reads (that latency is
   *    part of the feel; see HistoryBuffer), so the value that will
   *    actually land on `fromRingPosition` is getLoopWindow's k=1, not
   *    k=0. One extra raw value is requested to cover it.
   *
   * @param {number} count
   * @param {number} fromRingPosition
   */
  getTrigLoopProjection(count, fromRingPosition) {
    const window = this.trigger.getLoopWindow(count + 1);
    const aligned = new Array(count);
    for (let k = 0; k < count; k += 1) {
      aligned[(fromRingPosition + k) % count] = window[k + 1];
    }
    return aligned;
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
   * How much to delay one step for swing, given whether the scheduler has decided
   * it falls on the off-beat.
   *
   * Capped at half a step, not an arbitrary choice: unswung positions are
   * `0, D, 2D, 3D, ...`, so an off-beat step's swung position is always `< (i +
   * 0.5)D` while the next (on-beat) step sits at `(i + 1)D` with no delay of its
   * own -- ordering can never cross, for any swing amount, at any tempo or
   * division. Delay-only rather than pulling the on-beat earlier, so a swung
   * step's time is never earlier than the scheduler already promised elsewhere.
   *
   * Public, like stepDuration, because the scheduler is the one deciding parity
   * (see Scheduler.pump()) and calls this once it has.
   */
  swingDelay(offBeat, stepDuration) {
    return offBeat ? this.params.swing * 0.5 * stepDuration : 0;
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

    // The note this step actually glides from: the last one that sounded, however
    // many silent steps ago that was -- not last step's generator value, which is
    // frequently a note nobody heard. this.lastPlayedNote is still last step's
    // value at this point; it only becomes this step's below, once it can no
    // longer be needed as "before this step."
    const prevNote = this.lastPlayedNote ?? note.value;
    if (trig.triggered) this.lastPlayedNote = note.value;

    return {
      trackId: this.trackId,
      stepIndex: trig.stepIndex,
      triggered: trig.triggered,
      euclidBit: trig.euclidBit,
      randomBit: trig.randomBit,
      note: note.value,
      prevNote,
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
