/**
 * Deterministic indexed permutation -- a factorial-number-system (Lehmer code)
 * decode. Drives the rhythm and note permutation knobs: turning one reorders the
 * captured loop without changing its contents, so a rhythm keeps its density and
 * a melody keeps its pitch set.
 */

/**
 * Map a normalised 0..1 knob onto a permutation index for a loop of `length`,
 * scaled by the loop's own factorial so the whole space is reachable.
 *
 * A small fixed index range would be nearly inert: factorial-base decoding spends
 * its low digits on the *leading* positions, so a small index can barely do more
 * than lift one element to the front -- usually a 0 in a sparse rhythm, changing
 * nothing audible. Clipped at 12 because 13! exceeds a 32-bit integer.
 */
export function permutationIndex(normalized, length) {
  const n = Math.max(1, Math.min(12, Math.floor(length)));
  let f = 1;
  for (let i = 2; i <= n; i += 1) f *= i;
  const t = Math.max(0, Math.min(1, normalized));
  // Valid indices are 0..f-1; without the clamp a knob at exactly 1.0 lands on
  // f, which the factorial-base decode wraps straight back to the identity --
  // so the top of the knob's travel would silently do nothing.
  return Math.min(f - 1, Math.floor(t * f));
}

export function permute(array, nthPermutation = 0) {
  const size = array.length;
  if (size <= 1) return array.slice();

  let n = Math.max(0, Math.floor(nthPermutation));
  const pool = array.slice();
  const out = [];

  for (let i = 0; i < size; i += 1) {
    const remaining = size - i;
    const index = n % remaining;
    n = Math.floor(n / remaining);
    out.push(pool.splice(index, 1)[0]);
  }

  return out;
}
