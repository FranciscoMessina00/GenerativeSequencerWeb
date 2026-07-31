/**
 * Shared numeric helpers for the controls.
 *
 * Quantisation lives in one place because a BiasSpreadSlider's range endpoints and
 * its handle round values from the same schema entries -- rounding them differently
 * would let a value nudged by one control disagree with how the other displays it.
 */

/** Decimal places implied by a step size, e.g. 0.01 -> 2, 1 -> 0. */
export function decimalsFor(step) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function quantize(raw, min, max, step) {
  const snapped = Math.round(raw / step) * step;
  const clamped = Math.min(max, Math.max(min, snapped));
  // Snapping by multiplication leaves float dust (0.30000000000000004); the
  // decimals implied by the step size are exactly enough to clean it up.
  return Number(clamped.toFixed(decimalsFor(step)));
}

export function formatNumber(value, step) {
  return value.toFixed(decimalsFor(step));
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}
