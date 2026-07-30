/**
 * Euclidean rhythm generation.
 *
 * Ported from `Supercollider/TriggerWithGlide.scd:228-258`. This is a
 * bucket/Bresenham accumulator, NOT the Bjorklund algorithm -- for many
 * (steps, pulses) pairs the two agree, but not all, so the accumulator is kept
 * verbatim to preserve the instrument's actual rhythmic vocabulary.
 *
 * The `rotation + 1` offset is also part of the original and is deliberate:
 * with rotation 0 the accumulator's trailing pulse is shifted to the downbeat,
 * which is why the default patch starts on beat 1.
 */

/**
 * Rotate right by `rotate` positions.
 * Port of `~rotateSeq` (`TriggerWithGlide.scd:251-258`).
 */
export function rotateRight(seq, rotate) {
  const size = seq.length;
  if (size === 0) return [];
  const out = new Array(size);
  const val = size - rotate;
  for (let i = 0; i < size; i += 1) {
    out[i] = seq[Math.abs((i + val) % size)];
  }
  return out;
}

/**
 * Distribute `pulses` beats as evenly as possible over `steps`, then rotate.
 * Returns an array of 1/0 of length `steps`.
 */
export function euclid(steps, pulses, rotation = 0) {
  const n = Math.max(1, Math.floor(steps));
  const k = Math.max(0, Math.floor(pulses));

  const rhythm = new Array(n);
  let bucket = 0;
  for (let i = 0; i < n; i += 1) {
    bucket += k;
    if (bucket >= n) {
      bucket -= n;
      rhythm[i] = 1;
    } else {
      rhythm[i] = 0;
    }
  }

  // The +1 and the modulo are both from the source.
  const rot = (Math.floor(rotation) + 1) % n;
  return rot > 0 ? rotateRight(rhythm, rot) : rhythm;
}
