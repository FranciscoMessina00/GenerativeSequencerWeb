/**
 * Euclidean rhythm generation.
 *
 * A bucket/Bresenham accumulator, deliberately NOT the Bjorklund algorithm --
 * for many (steps, pulses) pairs the two agree, but not all, and where they
 * differ the accumulator's rotation is the more syncopated of the two. That is
 * this instrument's rhythmic vocabulary, so don't "correct" it into Bjorklund.
 *
 * The `rotation + 1` offset is likewise intentional: at rotation 0 it shifts the
 * accumulator's trailing pulse onto the downbeat, so patterns start on beat 1.
 */

/** Rotate right by `rotate` positions. */
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

  const rot = (Math.floor(rotation) + 1) % n;
  return rot > 0 ? rotateRight(rhythm, rot) : rhythm;
}
