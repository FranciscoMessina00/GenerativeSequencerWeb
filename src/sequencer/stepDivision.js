/**
 * How long one step lasts, expressed the way a musician would say it.
 *
 * `stepDivision` is the note's denominator -- how many of them fit in a bar -- so 16 is a
 * sixteenth note and 4 is a quarter. Storing the denominator rather than a duration
 * means bigger number = shorter step, which lines the list's numeric order up with
 * "drag up for faster".
 *
 *   stepDuration = barSeconds / stepDivision * modFactor
 *
 * The modifier is a single tri-state value rather than two independent flags. Triplet
 * is x2/3 and dotted is x3/2, so both at once is x1 -- indistinguishable from straight.
 * Two booleans would make that contradictory state reachable, and a patch could sit in
 * it showing both letters lit while sounding plain; one value makes it unrepresentable.
 */

/** The note values offered, as denominators: 1/1 down to 1/32. */
export const STEP_DIVISIONS = [1, 2, 4, 8, 16, 32];

export const STEP_MODS = [
  { id: 0, name: 'straight', factor: 1, letter: '' },
  { id: 1, name: 'triplet', factor: 2 / 3, letter: 'T' },
  { id: 2, name: 'dotted', factor: 3 / 2, letter: 'D' },
];

export const STEP_MOD_STRAIGHT = 0;
export const STEP_MOD_TRIPLET = 1;
export const STEP_MOD_DOTTED = 2;

/** Anything unrecognised -- including NaN, since `STEP_MODS[NaN]` is undefined. */
export function stepModById(id) {
  return STEP_MODS[Math.trunc(Number(id))] ?? STEP_MODS[0];
}

/**
 * Duration multiplier for a modifier id.
 *
 * Never returns NaN. A NaN step duration would leave the scheduler's
 * `while (nextStepTime < horizon)` loop unable to advance, so it would spin forever
 * rather than merely sound wrong -- worth the guard.
 */
export function stepModFactor(id) {
  return stepModById(id).factor;
}

/** 16 -> "1/16". The label the hub shows. */
export function noteValueLabel(division) {
  const denominator = Number(division);
  return Number.isFinite(denominator) && denominator > 0 ? `1/${denominator}` : '1/16';
}

/** "1/16 triplet" -- spoken form, for aria-valuetext. */
export function noteValueDescription(division, modId) {
  const mod = stepModById(modId);
  return mod.id === STEP_MOD_STRAIGHT
    ? noteValueLabel(division)
    : `${noteValueLabel(division)} ${mod.name}`;
}
