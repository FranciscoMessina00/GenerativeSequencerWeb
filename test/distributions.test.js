import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/core/rng.js';
import {
  MOD_DISTRIBUTION,
  NOTE_DISTRIBUTION,
  VELOCITY_DISTRIBUTION,
  fold,
  sampleDistribution,
} from '../src/sequencer/generators/distributions.js';

const N = 4000;

function draw(dist, bias, spread, seed = 12345) {
  const rng = new Rng(seed);
  return Array.from({ length: N }, () =>
    sampleDistribution(dist, rng, bias, spread),
  );
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

test('fold reflects instead of clamping', () => {
  assert.equal(fold(5, 2, 20), 5);
  assert.equal(fold(2, 2, 20), 2);
  assert.equal(fold(20, 2, 20), 20);
  assert.equal(fold(21, 2, 20), 19); // 1 past the top reflects to 1 below it
  assert.equal(fold(1, 2, 20), 3);
  // Repeated folding stays in range no matter how far out the input is.
  for (const x of [-100, -7, 0, 38, 41, 260]) {
    const f = fold(x, 2, 20);
    assert.ok(f >= 2 && f <= 20, `fold(${x}) = ${f}`);
  }
});

test('gauss is centred and scaled correctly', () => {
  const rng = new Rng(7);
  const xs = Array.from({ length: 20000 }, () => rng.gauss(10, 2));
  assert.ok(Math.abs(mean(xs) - 10) < 0.1, `mean was ${mean(xs)}`);
  assert.ok(Math.abs(stdev(xs) - 2) < 0.1, `stdev was ${stdev(xs)}`);
});

test('coin honours its probability, and is absolute at 0 and 1', () => {
  const rng = new Rng(99);
  // The manual verification checklist depends on these two being exact:
  // probability 0 with OR gives pure Euclid, probability 1 with NAND silence.
  for (let i = 0; i < 500; i += 1) {
    assert.equal(rng.coinBit(0), 0);
    assert.equal(rng.coinBit(1), 1);
  }
  const hits = Array.from({ length: 8000 }, () => rng.coinBit(0.25));
  assert.ok(Math.abs(mean(hits) - 0.25) < 0.02, `rate was ${mean(hits)}`);
});

test('note: narrow spread clusters around the bias', () => {
  const xs = draw(NOTE_DISTRIBUTION, 60, 1);
  assert.ok(Math.abs(mean(xs) - 60) < 0.5, `mean was ${mean(xs)}`);
  assert.ok(stdev(xs) < 2, `stdev was ${stdev(xs)}`);
});

test('note: widening the spread widens the distribution', () => {
  const tight = stdev(draw(NOTE_DISTRIBUTION, 64, 0.5));
  const mid = stdev(draw(NOTE_DISTRIBUTION, 64, 10));
  const wide = stdev(draw(NOTE_DISTRIBUTION, 64, 19.5));
  assert.ok(tight < mid && mid < wide, `${tight} < ${mid} < ${wide}`);
});

test('note: maximum spread collapses onto the extremes', () => {
  // At spread 40 the two wide-regime modes have spread 0.1 and sit at the
  // range ends -- the paper's "distribution that generates only extreme values".
  const xs = draw(NOTE_DISTRIBUTION, 64, 40);
  const low = xs.filter((x) => x < 10).length;
  const high = xs.filter((x) => x > 117).length;
  assert.ok(low + high > N * 0.97, `only ${low + high}/${N} were extreme`);
  // Both ends must actually be visited -- a broken coin flip would show here.
  assert.ok(low > N * 0.4 && high > N * 0.4, `split was ${low}/${high}`);
  // And the middle must be genuinely empty.
  assert.equal(xs.filter((x) => x > 40 && x < 90).length, 0);
});

test('note: stays inside 1..127 across the whole spread sweep', () => {
  for (let spread = 0.1; spread <= 40; spread += 0.5) {
    for (const bias of [1, 51, 127]) {
      for (const x of draw(NOTE_DISTRIBUTION, bias, spread, 555)) {
        // Narrow regime uses abs() rather than clipping, so it can exceed 127
        // when the bias is already at the ceiling -- guard the floor only, and
        // let the quantiser/synth handle the ceiling.
        assert.ok(x >= 0, `note ${x} at bias ${bias} spread ${spread}`);
      }
    }
  }
});

test('velocity: respects 0.1..1 across the whole sweep', () => {
  for (let spread = 0.1; spread <= 1; spread += 0.05) {
    for (const bias of [0.1, 0.55, 1]) {
      for (const x of draw(VELOCITY_DISTRIBUTION, bias, spread, 777)) {
        assert.ok(x >= 0.1 && x <= 1, `vel ${x} at bias ${bias} spread ${spread}`);
      }
    }
  }
});

test('velocity: wide spread piles onto both range ends', () => {
  const xs = draw(VELOCITY_DISTRIBUTION, 0.55, 1);
  // Each branch fires ~half the time and clips ~half of its own draws, so the
  // expected mass at each boundary is ~25%. Threshold set below that to leave
  // sampling margin while still proving both ends are genuinely loaded.
  const atFloor = xs.filter((x) => x <= 0.1 + 1e-9).length;
  const atCeil = xs.filter((x) => x >= 1 - 1e-9).length;
  assert.ok(atFloor > N * 0.2, `only ${atFloor}/${N} pinned to 0.1`);
  assert.ok(atCeil > N * 0.2, `only ${atCeil}/${N} pinned to 1.0`);
});

test('velocity: the loud mode smears downward, unlike note and mod', () => {
  // Pins the asymmetry documented in distributions.js: velocity's loud branch
  // gets sd 0.9-spread/10 (= 0.8 at maximum) while its quiet branch gets
  // 0.2-spread/10 (= 0.1). So the quiet mode is tight and the loud one is not,
  // and a meaningful slice of draws lands in the middle of the range -- which
  // never happens for note or mod at their maximum spread.
  const vel = draw(VELOCITY_DISTRIBUTION, 0.55, 1);
  const velMiddle = vel.filter((x) => x > 0.3 && x < 0.8).length;
  assert.ok(velMiddle > N * 0.05, `expected a mid-range smear, got ${velMiddle}`);

  // Contrast: note and mod leave their middles completely empty.
  const note = draw(NOTE_DISTRIBUTION, 64, 40);
  assert.equal(note.filter((x) => x > 40 && x < 90).length, 0);
  const mod = draw(MOD_DISTRIBUTION, 4, 20);
  assert.equal(mod.filter((x) => x > 6 && x < 16).length, 0);
});

test('modulation: respects the 2..20 plucking-position range', () => {
  for (let spread = 0.1; spread <= 20; spread += 0.5) {
    for (const bias of [2, 4, 20]) {
      for (const x of draw(MOD_DISTRIBUTION, bias, spread, 313)) {
        assert.ok(x >= 2 && x <= 20, `mod ${x} at bias ${bias} spread ${spread}`);
      }
    }
  }
});

test('post-processing is applied on read', () => {
  // Notes quantise; velocity passes through; modulation folds into range.
  assert.equal(NOTE_DISTRIBUTION.post(60.4, { scale: 1 }), 60);
  assert.equal(VELOCITY_DISTRIBUTION.post(0.42), 0.42);
  assert.equal(MOD_DISTRIBUTION.post(21, {}), 19);
});

test('a fixed seed reproduces a patch exactly', () => {
  assert.deepEqual(
    draw(NOTE_DISTRIBUTION, 60, 5, 42),
    draw(NOTE_DISTRIBUTION, 60, 5, 42),
  );
});
