/**
 * Seedable random source, injected rather than global, for two reasons: the
 * distribution tests need determinism, and a user-visible seed is a genuinely
 * useful control in a generative instrument -- it makes a patch reproducible.
 *
 * Note this covers the note stream only. The granulator's grain onsets run on the
 * audio thread and are not seeded, so a patch repeats its notes exactly but not
 * its grain texture.
 */

/** mulberry32: small, fast, good enough statistically for musical decisions. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = (Math.random() * 0x7fffffff) | 0) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
    this.spare = null; // Box-Muller second value, see gauss()
  }

  /** Uniform in [0, 1). */
  random() {
    return this.next();
  }

  /** True with probability `prob`; absolute at 0 and 1. */
  coin(prob) {
    return this.next() < prob;
  }

  /** Same as coin() but returns 1/0, for the trigger bit stream. */
  coinBit(prob) {
    return this.next() < prob ? 1 : 0;
  }

  /**
   * Normal deviate, mean `mu`, standard deviation `sigma`.
   * Box-Muller generates two values per pass; the second is cached so the
   * per-call cost averages out to one trig pair per two draws.
   */
  gauss(mu, sigma) {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return mu + sigma * value;
    }
    let u = 0;
    // Guard against log(0); the probability is vanishing but not zero.
    while (u === 0) u = this.next();
    const v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spare = mag * Math.sin(2 * Math.PI * v);
    return mu + sigma * mag * Math.cos(2 * Math.PI * v);
  }

  /** Uniform in [lo, hi). */
  randRange(lo, hi) {
    return lo + this.next() * (hi - lo);
  }
}

/** Shared instance used by the app; tests construct their own seeded Rng. */
export const rng = new Rng();
