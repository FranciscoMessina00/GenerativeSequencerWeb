import { clampParam, paramSpec } from '../core/paramSchema.js';

/**
 * The full excursion an LFO at this depth could sweep a parameter across, centred
 * on its current base value -- the same ±amount·span/2 offset Modulation#drive
 * applies at the LFO's ±1 peak, without needing a live phase to evaluate it at.
 *
 * Pure and DOM-free, so the control widgets that draw it and the wiring in
 * main.js that feeds it can both be tested without a browser.
 *
 * @param {string} key schema key of the modulated param
 * @param {number} base its current (unmodulated) value, from the store
 * @param {number} amount the LFO's depth, 0..1
 * @returns {{ lo: number, hi: number, base: number } | null} null when there is
 *   nothing to show -- no depth, or a base that hasn't arrived yet
 */
export function modSweepRange(key, base, amount) {
  const spec = paramSpec(key);
  if (!spec || !(amount > 0) || !Number.isFinite(base)) return null;
  const span = spec.max - spec.min;
  const excursion = amount * span * 0.5;
  return {
    lo: clampParam(key, base - excursion),
    hi: clampParam(key, base + excursion),
    base,
  };
}
