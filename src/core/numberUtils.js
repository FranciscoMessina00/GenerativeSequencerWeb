/**
 * Shared numeric primitives for parameter values.
 *
 * Lives in `core` rather than `ui` because both layers need it: `paramSchema.js`
 * uses it to normalise a value on its way into the store, and the UI controls use
 * it to render/quantise the same value on the way back out. `core` never imports
 * from `ui`, so this is the lowest common home -- `ui/numberUtils.js` re-exports
 * these two rather than each layer keeping its own copy, which is what used to
 * happen (a byte-identical `decimalsFor` and a hand-inlined re-implementation of
 * `quantize` both lived in paramSchema.js).
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
