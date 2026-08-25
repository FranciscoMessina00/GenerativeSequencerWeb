/**
 * The one amplitude envelope every instrument is shaped by: attack, hold, decay.
 *
 * Same split as audio/percussion/percussionModel.js -- this file turns the user's
 * three millisecond values plus the step they land on into the numbers a hit needs,
 * and the worklet does only what needs `sampleRate` or per-sample state. So times
 * leave here in seconds and the worklet converts them to frames, exactly as it
 * already does for a decay time.
 *
 * Two reasons that split matters more here than usual:
 *
 *   - The step-boundary rules are the substance of this feature, and every one of
 *     them is closed-form. Solving them on the main thread means they are ordinary
 *     testable arithmetic rather than behaviour hidden inside an audio thread that
 *     cannot be inspected.
 *   - The visualiser draws its curve with envelopeLevel() below, which is the same
 *     function the tests assert against and the same shape the worklets run as a
 *     recursion. One definition, so the picture cannot drift from the sound -- the
 *     reasoning ui/LfoView.js gives for sampling the real lfoValue().
 *
 * Absolute times, not fractions of a step: a 30 ms attack is a 30 ms attack at any
 * tempo, which is what makes the envelope a property of the sound rather than of the
 * clock. The step only enters as the boundary the attack and hold are cut against.
 */

/** −60 dB in nepers: ln(1000). The decay convention the rest of the app uses. */
const LOG_1000 = Math.log(1000);

/**
 * What an un-normalised −60 dB curve is left with at its own endpoint, and the span
 * it actually covers. Dividing by the span is what turns "decayed to a thousandth"
 * into "reached exactly zero" -- see decayCurve.
 */
export const CURVE_FLOOR = Math.exp(-LOG_1000);
export const CURVE_SPAN = 1 - CURVE_FLOOR;

const MS_PER_SECOND = 1000;

/**
 * A decay shorter than this is a click, not a decay -- and zero would divide by zero
 * in the per-sample step the worklet derives from it. Matches percussionModel's own
 * MIN_DECAY, for the same reason.
 */
const MIN_DECAY = 0.005;

/**
 * The widest each stage may be asked for. These mirror the schema's own ranges, and a
 * test pins them together -- the schema is what the controls obey, and this is what a
 * value arriving from anywhere else (a preset, a future MIDI mapping) obeys.
 */
const MAX_ATTACK_MS = 2000;
const MAX_HOLD_MS = 1000;
const MAX_DECAY_MS = 4000;

function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * The attack's shape: 0 at x = 0, exactly 1 at x = 1, where x is the position
 * through the *requested* attack time -- not through the truncated one, which is the
 * whole reason a cut-short attack lands below full level.
 *
 * Linear is the straight ramp. Exponential is a one-pole charging toward 1 on the
 * −60 dB convention modeDecays and decayFactor already use, read upside down and
 * normalised so it lands on exactly 1 rather than asymptotically near it. Both
 * endpoints being exact is what lets a truncated attack hand its level straight to
 * the decay with no discontinuity -- the issue's "no audible pops", by construction
 * rather than by tuning.
 */
export function attackCurve(x, exponential) {
  const t = clamp(x, 0, 1);
  if (!exponential) return t;
  return (1 - Math.exp(-LOG_1000 * t)) / CURVE_SPAN;
}

/**
 * The decay's shape: 1 at x = 0, exactly 0 at x = 1.
 *
 * The exponential is the same curve mirrored, offset by the same span. An un-offset
 * exp(-kx) stops at a thousandth, and a thousandth held forever is a voice that
 * never frees and a DC term sitting under everything else on the track.
 */
export function decayCurve(x, exponential) {
  const t = clamp(x, 0, 1);
  if (!exponential) return 1 - t;
  return (Math.exp(-LOG_1000 * t) - CURVE_FLOOR) / CURVE_SPAN;
}

/**
 * One hit's envelope, with the step-boundary rules already applied.
 *
 * The rules, in the issue's own terms, with T the step's duration:
 *
 *   1. A >= T   the attack is cut at T, reaching `peak` < 1; hold is skipped
 *               entirely and the decay starts from there.
 *   2. A < T    the attack completes, `peak` is 1, and hold runs from A -- ending
 *               early at A + H when that lands inside the step, or clamped to the
 *               boundary when it would run past it.
 *   3. always   the decay is the full D and is free to run past the boundary.
 *               Nothing here clips it; a tail bleeding into the next step is the
 *               point, and the voice pool is what eventually reclaims it.
 *
 * `attackFull` comes back alongside the truncated `attack` because the curve is a
 * function of the requested time: the worklet needs both to run an attack that ends
 * mid-ramp at the same level this file says it does. `holdFull` is there for a
 * smaller reason -- nothing in the audio path reads it -- but it is what lets a
 * caller see that a hold was shortened rather than merely see how long it ended up,
 * and the display says so on screen. Returning it here keeps that comparison in the
 * one place that knows the rules, instead of re-deriving them somewhere else.
 *
 * `stepSeconds` may be absent or zero -- a hit built outside the sequencer (a check
 * page assembling a message by hand) then gets the untruncated envelope, which is
 * the honest answer when there is no step to cut it against.
 *
 * @param {object} opts
 * @param {number} opts.attackMs  0..2000
 * @param {number} opts.holdMs    0..5000; a voice with no hold stage passes 0 --
 *   see instruments.js, where only the string has one
 * @param {number} opts.decayMs   1..5000
 * @param {number} opts.stepSeconds the step this hit lands on, or 0 for none
 * @param {boolean} opts.exponential curve shape, shared by attack and decay
 * @returns {{ attack: number, attackFull: number, hold: number, holdFull: number,
 *   decay: number, peak: number, exponential: boolean }} times in seconds
 */
export function ahdEnvelope({
  attackMs, holdMs, decayMs, stepSeconds, exponential,
}) {
  const exp = Boolean(exponential);
  const attackFull = clamp(attackMs, 0, MAX_ATTACK_MS) / MS_PER_SECOND;
  const holdFull = clamp(holdMs, 0, MAX_HOLD_MS) / MS_PER_SECOND;
  const decay = Math.max(MIN_DECAY, clamp(decayMs, 0, MAX_DECAY_MS) / MS_PER_SECOND);

  // No step to cut against: nothing is truncated.
  const step = Number(stepSeconds) > 0 ? Number(stepSeconds) : Infinity;

  const attack = Math.min(attackFull, step);
  // A zero attack is at full level on its first sample -- and dividing by it would
  // be NaN rather than instant.
  const peak = attackFull > 0 ? attackCurve(attack / attackFull, exp) : 1;

  // A truncated attack skips the hold outright rather than shortening it: the level
  // never reached the peak, so there is nothing there to hold at.
  const hold = attack >= step ? 0 : Math.min(holdFull, step - attack);

  return { attack, attackFull, hold, holdFull, decay, peak, exponential: exp };
}

/** Seconds from note-on to silence -- what a voice's life should be sized against. */
export function envelopeDuration(env) {
  return env.attack + env.hold + env.decay;
}

/**
 * The two ways the step can have overruled what was asked for, as predicates rather
 * than as expressions repeated wherever they are needed.
 *
 * `peak` below 1 IS a cut attack: an attack that completed reaches full level by
 * definition, so there is nothing else to compare. And a cut attack skips the hold
 * outright rather than shortening it, which is why the second excludes the first --
 * a hold of zero out of five hundred is not a clamp, it is a stage that never ran.
 */
export function attackWasCut(env) {
  return env.peak < 1;
}

export function holdWasClamped(env) {
  return env.peak >= 1 && env.hold < env.holdFull;
}

/**
 * The envelope's level at `t` seconds after note-on.
 *
 * Reference implementation and drawing function both. The worklets run this same
 * shape as a per-sample recursion instead -- an add or a multiply, rather than a
 * Math.exp per sample -- and test/envelope.test.js is what holds the two together.
 */
export function envelopeLevel(env, t) {
  const time = Number(t);
  if (!(time > 0)) return env.attack > 0 ? 0 : env.peak;

  if (time < env.attack) return attackCurve(time / env.attackFull, env.exponential);

  const afterAttack = time - env.attack;
  if (afterAttack < env.hold) return env.peak;

  const intoDecay = afterAttack - env.hold;
  if (intoDecay >= env.decay) return 0;
  return env.peak * decayCurve(intoDecay / env.decay, env.exponential);
}
