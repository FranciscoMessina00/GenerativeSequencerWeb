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
 * One tempo, several timelines. The bar length is global, but each track decides how it
 * subdivides that bar (see Track.stepDuration), so every track carries its own
 * accumulator and they advance at their own rates off the one clock.
 */
export class Scheduler {
  /**
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {() => number} opts.getCurrentTime the audio clock, in seconds
   * @param {import('./Track.js').Track[]} opts.tracks
   * @param {number} [opts.lookahead] seconds of steps to decide ahead of the clock
   * @param {number} [opts.tickMs] wake-up interval
   * @param {{start: Function, stop: Function, dispose: Function}} [opts.ticker]
   *   wake-up source; injectable so tests can drive `pump()` from a fake clock
   *   instead of waiting on real timers.
   */
  constructor({ bus, getCurrentTime, tracks, lookahead = 0.1, tickMs = 25, ticker }) {
    this.bus = bus;
    this.getCurrentTime = getCurrentTime;
    this.tracks = tracks;
    this.lookahead = lookahead;

    this.params = defaultsFor('transport');
    this.ticker = ticker ?? new Ticker(tickMs);
    this.running = false;
    /**
     * One accumulator per track. Parallel to `tracks` by index, so adding a track
     * means adding a clock at the same time.
     */
    this.trackClocks = tracks.map(() => ({ nextStepTime: 0, stepCount: 0 }));
  }

  /** Seconds per bar, in 4/4. The one thing every track shares. */
  get barDuration() {
    return 240 / this.params.bpm;
  }

  /** What one step of `trackId` currently lasts -- its rate against the bar. */
  stepDurationFor(trackId) {
    return this.tracks[trackId]?.stepDuration(this.barDuration) ?? 0;
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
    // audio thread is still warming up. Every track gets the same start time, so
    // however their rates differ they begin phase-aligned.
    const firstStep = this.getCurrentTime() + 0.06;
    for (const clock of this.trackClocks) clock.nextStepTime = firstStep;
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
   * Each track advances on its own accumulator, so a slow track simply emits fewer
   * steps per window than a fast one.
   *
   * Two properties to preserve when touching this. `nextStepTime` accumulates rather
   * than being recomputed from a step counter, which is what makes each grid immune to
   * timer jitter: a late tick emits the missed steps at their correct original times
   * instead of sliding the grid. And `duration` is read fresh every step, so a rate or
   * tempo change takes effect from the next step and never retimes a step already
   * handed to the audio engine. Swing below follows the same two rules: it perturbs
   * only the local `audioTime` handed out this iteration, never `nextStepTime` itself
   * (or the offset would compound onto every later step), and it is recomputed from
   * `track.params.swing` fresh every step, same as duration.
   */
  pump() {
    if (!this.running) return;
    const horizon = this.getCurrentTime() + this.lookahead;
    const barSeconds = this.barDuration;

    this.tracks.forEach((track, trackId) => {
      const clock = this.trackClocks[trackId];
      if (!clock) return;

      while (clock.nextStepTime < horizon) {
        const duration = track.stepDuration(barSeconds);
        // trackStep, not the Euclidean stepIndex: it alternates cleanly forever
        // regardless of pattern length (stepIndex glitches parity once per cycle
        // when `steps` is odd) -- see Track.swingDelay for the offset itself.
        const offBeat = clock.stepCount % 2 === 1;
        const audioTime = clock.nextStepTime + track.swingDelay(offBeat, duration);

        const event = track.step(duration);
        this.bus.emit('step', {
          ...event,
          audioTime,
          stepDuration: duration,
          trackStep: clock.stepCount,
        });

        clock.stepCount += 1;
        clock.nextStepTime += duration;
      }
    });
  }

  dispose() {
    this.ticker.dispose();
  }
}
