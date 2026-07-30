/**
 * Deterministic indexed permutation, standing in for SuperCollider's
 * `SequenceableCollection.permute(nthPermutation)`.
 *
 * Used by the "Rhythm permutations" and "Notes permutation" knobs
 * (`TriggerWithGlide.scd:581-585`, `:609-613`), where turning the knob walks
 * through permutations of the captured loop -- reordering it without changing
 * its contents, so a rhythm keeps its density and a melody keeps its pitch set.
 *
 * This is the canonical factorial-number-system (Lehmer code) decode. It is
 * functionally equivalent to the original, but not guaranteed bit-identical:
 * a given knob value may select a different permutation than SC would. The
 * properties that matter musically -- index 0 is the identity, the mapping is
 * stable across calls, and every index yields a true permutation -- hold.
 */
/**
 * Map a normalised 0..1 knob onto a permutation index for a loop of `length`.
 *
 * The two GUIs in the original disagreed about this control, and the difference
 * matters. The SuperCollider-native GUI scales the knob by the loop's factorial
 * (`TriggerWithGlide.scd:581`, `:609`), so the full permutation space is
 * reachable. The Processing GUI -- the one the paper documents -- instead sent a
 * raw 0..20 (`Vista.pde:44-49`).
 *
 * A raw 0..20 index is very nearly inert, because factorial-base decoding spends
 * its low digits on the *leading* positions: for a 32-slot loop only
 * `n % 32` is ever non-zero, so the knob can do no more than lift one element to
 * the front -- and for a sparse binary rhythm that element is usually a 0, so
 * nothing audible changes at all.
 *
 * Since the paper describes this control as one that "generates new sequences",
 * the SC-native scaling is the reading that actually delivers that. Clipped at
 * 12 as the source does, because 13! exceeds a 32-bit integer.
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
