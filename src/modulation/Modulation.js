import { clampParam, defaultsFor, paramSpec } from '../core/paramSchema.js';
import { stepModFactor } from '../sequencer/stepDivision.js';
import { lfoPeriod, lfoValue } from './lfo.js';
import { modTargetKey } from './modTargets.js';

/**
 * One track's modulation source: an LFO, and the parameter it is pointed at.
 *
 * There is one of these per track, each pointed at its own track's copy of
 * whatever it targets -- which is why every modulatable param is per-track in the
 * schema. Two tracks sweeping "stiffness" sweep two different strings.
 *
 * Two decisions shape everything here.
 *
 * **It is sampled once per step, not per animation frame.** The scheduler runs on a
 * Worker timer precisely because browsers throttle main-thread timers in hidden tabs
 * (see sequencer/Ticker.js), so an LFO on requestAnimationFrame would stall while the
 * sequencer kept playing. Stepping it from the step pipeline is throttle-proof and
 * arrives with a sample-accurate time in hand. Nothing is lost: no target is read
 * more often than once a step anyway -- the string params latch when a note is built,
 * the rest are read inside Track.step(), and the two granulator params are AudioParams
 * already smoothed over 10 ms, so a per-step write lands as a short ramp.
 *
 * **It writes past the store, straight to the engines.** ParamStore.set() would
 * snap the value to the param's step (stalling the LFO for any excursion smaller than
 * one step), overwrite the value the user dialled in, and announce param:changed --
 * which repaints that control, so the knobs would visibly shake. Writing directly
 * leaves the store the sole owner of base values, keeps modulated values out of every
 * snapshot, and leaves the UI still.
 *
 * The cost of going around the store is that this class owns putting things back:
 * once it has written to an engine, `store.set(key, base)` sees an unchanged bag and
 * routes nothing, so a stale modulated value would otherwise stick forever. Hence
 * #restore, and the care about calling it whenever the LFO stops driving something.
 */
export class Modulation {
  /**
   * @param {object} opts
   * @param {{ get: (key: string, trackId?: number) => any }} opts.store base values
   * @param {(key: string, value: number, trackId: number, spec: object) => void} opts.write
   *   engine writer. Injected rather than reached for, so the engine references stay
   *   in the bootstrap and this class can be tested against a fake.
   * @param {() => number} opts.getBarSeconds seconds per bar, for synced rates
   * @param {number} [opts.trackId] which track's params are modulated
   */
  constructor({ store, write, getBarSeconds, trackId = 0 }) {
    this.store = store;
    this.write = write;
    this.getBarSeconds = getBarSeconds;
    this.trackId = trackId;

    this.params = defaultsFor('modulation');
    this.running = false;
    this.phase = 0;
    /**
     * The time `phase` belongs to -- one step *ahead* of what is currently audible,
     * because each step's write lands on the following step (see onStep). null until
     * the first step, so the first advance has nothing to integrate from.
     */
    this.anchorTime = null;
    /** What is currently driven, so it can be put back when that changes. */
    this.activeKey = null;
  }

  /** The eight schema keys this owns -- everything with target: 'modulation'. */
  keys() {
    return Object.keys(this.params);
  }

  /**
   * Apply an LFO setting. Changing what is modulated, or muting the depth, releases
   * whatever was being driven before the new setting takes effect.
   */
  setParam(key, value) {
    if (!(key in this.params)) return;
    this.params[key] = clampParam(key, value);

    if (key === 'lfoTarget' || key === 'lfoAmount') {
      const next = this.#drivenKey();
      if (next !== this.activeKey) this.#restore();
    }
  }

  /** Seconds per LFO cycle, at the current settings. */
  period() {
    return lfoPeriod({
      sync: this.params.lfoSync,
      rate: this.params.lfoRate,
      division: this.params.lfoDivision,
      modFactor: stepModFactor(this.params.lfoSyncMod),
      barSeconds: this.getBarSeconds(),
    });
  }

  /** The LFO's output right now, in -1..1. */
  value() {
    return lfoValue(this.params.lfoShape, this.params.lfoFold, this.phase);
  }

  /**
   * Advance and write, once per step.
   *
   * The value is evaluated at `audioTime + stepDuration` rather than at `audioTime`.
   * The step being announced was already generated inside the scheduler's pump before
   * this fired, so anything written now takes effect on the *following* step -- and
   * evaluating at that step's own time is what keeps the modulation heard at a step
   * matched to the LFO's phase there.
   */
  onStep({ audioTime, stepDuration }) {
    // Advanced unconditionally, before anything is checked: the LFO keeps running
    // whenever the transport does, whether or not it is currently pointed at a
    // parameter. That way mapping a target or raising the depth drops the LFO into
    // wherever its cycle already is, rather than restarting it cold from phase 0.
    this.#advance(audioTime, stepDuration);

    const key = this.#drivenKey();
    if (!key) {
      // Nothing to drive. If something was being driven a moment ago, put it back.
      if (this.activeKey) this.#restore();
      return;
    }
    this.#drive(key);
  }

  /** Move the phase on by one step's worth of time. */
  #advance(audioTime, stepDuration) {
    const period = this.period();
    const target = Number(audioTime) + Number(stepDuration);
    if (!Number.isFinite(target) || !Number.isFinite(period) || period <= 0) return;

    // Accumulate rather than recompute from an origin, exactly as the scheduler
    // accumulates nextStepTime: a rate, division or tempo change then takes effect
    // from here on without retiming or jumping what came before.
    const elapsed = this.anchorTime === null ? Number(stepDuration) : target - this.anchorTime;
    if (Number.isFinite(elapsed)) {
      const next = (this.phase + elapsed / period) % 1;
      this.phase = next < 0 ? next + 1 : next;
    }
    this.anchorTime = target;
  }

  /** Reset on start so a synced LFO is locked to the bar; release on stop. */
  setRunning(running) {
    this.running = Boolean(running);
    if (this.running) {
      this.phase = 0;
      this.anchorTime = null;
    } else {
      // Otherwise the last modulated value stays latched in the engine, and a manual
      // pluck would use it instead of what the controls show.
      this.#restore();
    }
  }

  /** The param being modulated, or null -- depth of zero counts as nothing. */
  #drivenKey() {
    if (!(this.params.lfoAmount > 0)) return null;
    return modTargetKey(this.params.lfoTarget);
  }

  /**
   * Base plus offset, straight to the engine.
   *
   * Bipolar around the stored value and scaled by half the param's range, so amount 1
   * sweeps the whole range and the user's setting stays the centre of the movement.
   */
  #drive(key) {
    const spec = paramSpec(key);
    const base = Number(this.store.get(key, this.trackId));
    if (!spec || !Number.isFinite(base)) return;

    const span = spec.max - spec.min;
    const offset = this.params.lfoAmount * this.value() * span * 0.5;
    const next = clampParam(key, base + offset);
    // clampParam does not guard its numeric path against NaN, and a NaN reaching an
    // AudioParam poisons it for the lifetime of the graph -- so check here.
    if (!Number.isFinite(next)) return;

    this.activeKey = key;
    this.write(key, next, this.trackId, spec);
  }

  /** Hand the parameter back to whatever the store says it should be. */
  #restore() {
    const key = this.activeKey;
    this.activeKey = null;
    if (!key) return;

    const spec = paramSpec(key);
    const base = Number(this.store.get(key, this.trackId));
    if (!spec || !Number.isFinite(base)) return;
    this.write(key, base, this.trackId, spec);
  }
}
