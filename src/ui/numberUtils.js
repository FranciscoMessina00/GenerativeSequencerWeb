/**
 * Shared numeric helpers for the controls.
 *
 * Quantisation lives in one place because a BiasSpreadSlider's range endpoints and
 * its handle round values from the same schema entries -- rounding them differently
 * would let a value nudged by one control disagree with how the other displays it.
 *
 * `decimalsFor`/`quantize` themselves live in `core/numberUtils.js` -- `paramSchema.js`
 * needs the exact same recipe to normalise a value on its way into the store, and
 * `core` never imports from `ui`, so that's the lower, shared home. Re-exported here
 * so every `ui/*.js` file that already imports from this module keeps working unchanged.
 */
import { decimalsFor, quantize } from '../core/numberUtils.js';

export { decimalsFor, quantize };

export function formatNumber(value, step) {
  return value.toFixed(decimalsFor(step));
}

/**
 * A duration in milliseconds, written so it stays short at both ends of a range that
 * spans five thousand of them: `240ms` below a second, `1.24s` above it.
 *
 * Shared rather than local to the envelope panel because UIController renders the
 * same params as plain sliders on any surface that does not use the panel, and a
 * readout that disagreed with the one beside it would be worse than either.
 */
export function formatMilliseconds(ms) {
  const value = Number(ms) || 0;
  if (Math.abs(value) < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}
