/**
 * How far through its pattern a track's playhead is.
 *
 * The visible track has the ring, which shows the current step as a lit sector. A
 * hidden track has only its tab, so it gets a bar instead -- and a bar that jumped
 * one notch per step would read as broken at 1/4 notes, so this interpolates
 * *within* the step as well as counting steps.
 *
 * Split out of ui/TrackTabs.js because it is the only part worth testing and the
 * only part with an off-by-one in it. Pure, and unit-tested in Node rather than
 * only observed in a browser.
 *
 * Both functions work in audio-clock seconds, never wall-clock. The scheduler
 * decides steps ~100 ms before they sound, so a bar driven off the `step` event
 * directly would run visibly ahead of what you hear. promote() is what holds a step
 * back until its moment arrives -- the same gate EuclidView.frame() uses.
 */

/**
 * Hand over every queued step whose time has come, and return the last of them.
 *
 * The last one wins rather than the first: a stalled animation frame (a background
 * browser tab, a long paint) can leave several steps due at once, and the bar should
 * catch up to where the music actually is instead of replaying history.
 *
 * Mutates `queue`, which is the point -- promoted steps are done with.
 *
 * @param {Array<{audioTime: number}>} queue in ascending audioTime
 * @param {number} now audio-clock seconds
 * @returns {object | null} the newest step now audible, or null if none came due
 */
export function promote(queue, now) {
  let promoted = null;
  while (queue.length > 0 && queue[0].audioTime <= now) promoted = queue.shift();
  return promoted;
}

/**
 * Fraction of one pattern revolution completed, in 0..1.
 *
 * `current` is a promoted step: `{ stepIndex, audioTime, stepDuration, patternLength }`.
 * The fraction through the current step is added to its index, so the bar advances
 * smoothly and reaches 1 exactly as the last step ends.
 *
 * Clamped at 1 rather than allowed to overshoot: if the transport stops or a step is
 * late, `now` can run past the step's end, and a bar creeping past full would be
 * worse than one that waits.
 *
 * Anything missing or nonsensical -- no step yet, a zero-length pattern, a
 * non-finite time -- reads as 0. A progress bar is decoration; it must not be able
 * to throw inside an animation frame.
 */
export function stepProgress(current, now) {
  if (!current) return 0;
  const { stepIndex, audioTime, stepDuration, patternLength } = current;
  if (!(stepDuration > 0) || !(patternLength > 0)) return 0;
  if (!Number.isFinite(now) || !Number.isFinite(audioTime) || !Number.isFinite(stepIndex)) return 0;

  const withinStep = Math.min(1, Math.max(0, (now - audioTime) / stepDuration));
  // Modulo the index, not the sum: a stepIndex at the pattern's end plus a fraction
  // must stay inside this revolution rather than wrapping to the start of the next.
  const position = (stepIndex % patternLength) + withinStep;
  return Math.min(1, position / patternLength);
}
