import { Ticker } from './Ticker.js';
import { clampParam, defaultsFor } from '../core/paramSchema.js';

/**
 * Lookahead clock.
 *
 * Web Audio has no callback-per-note, so: wake often on a coarse timer, and each
 * time push every step falling inside a short window ahead of the audio clock.
 * Notes get decided ~100 ms early carrying an explicit `audioTime`, which the
 * audio engine turns into a sample-accurate start -- so timer jitter shifts *when
 * we decide*, never *when it sounds*.
 *
 * One step is a 16th note, so a step lasts `60 / (bpm * 4)` seconds.
 */
export class Scheduler {
  /**
   * @param {object} opts
   * @param {Ticker} [opts.ticker] wake-up source; injectable so tests can drive
   *   `pump()` from a fake clock instead of waiting on real timers.
   */
  constructor({ bus, getCurrentTime, tracks, lookahead = 0.1, tickMs = 25, ticker }) {
    this.bus = bus;
    this.getCurrentTime = getCurrentTime;
    this.tracks = tracks;
    this.lookahead = lookahead;

    this.params = defaultsFor('transport');
    this.ticker = ticker ?? new Ticker(tickMs);
    this.running = false;
    this.nextStepTime = 0;
    this.stepCount = 0;
  }

  get stepDuration() {
    return 60 / (this.params.bpm * 4);
  }

  setParam(key, value) {
    if (!(key in this.params)) return;
    this.params[key] = clampParam(key, value);
    // A tempo change is picked up by the next scheduled step; steps already
    // handed to the audio engine keep the timing they were promised.
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Small offset so the first step is comfortably in the future even if the
    // audio thread is still warming up.
    this.nextStepTime = this.getCurrentTime() + 0.06;
    this.ticker.start(() => this.pump());
    this.bus.emit('transport:change', { running: true });
    this.pump();
  }

  /** Pause, keeping the playhead where it is. */
  stop() {
    if (!this.running) return;
    this.running = false;
    this.ticker.stop();
    this.bus.emit('transport:change', { running: false });
  }

  toggle() {
    if (this.running) this.stop();
    else this.start();
  }

  /**
   * Emit every step that falls inside the lookahead window. Driven by the Ticker;
   * public so tests can pump a fake clock deterministically.
   *
   * `nextStepTime` accumulates rather than being recomputed from a step counter,
   * which is what makes the grid immune to timer jitter: a late tick emits two
   * steps at their correct original times instead of sliding the grid.
   */
  pump() {
    if (!this.running) return;
    const horizon = this.getCurrentTime() + this.lookahead;

    while (this.nextStepTime < horizon) {
      const duration = this.stepDuration;
      const audioTime = this.nextStepTime;

      for (const track of this.tracks) {
        const event = track.step(duration);
        this.bus.emit('step', {
          ...event,
          audioTime,
          stepDuration: duration,
          globalStep: this.stepCount,
        });
      }

      this.stepCount += 1;
      this.nextStepTime += duration;
    }
  }

  dispose() {
    this.ticker.dispose();
  }
}
