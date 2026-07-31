import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNote,
  midiToHz,
  modeDecays,
  modeGains,
  modeRatios,
} from '../src/audio/modal/modalModel.js';

// The model writes into Float32Array, so ~7 significant digits is the ceiling.
// Anything tighter would be testing float32 rounding, not the physics.
const close = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `expected ${a} ~= ${b}`);

test('midiToHz anchors on A440', () => {
  close(midiToHz(69), 440, 1e-9);
  close(midiToHz(81), 880, 1e-9);
  close(midiToHz(57), 220, 1e-9);
  close(midiToHz(60), 261.6255653005986, 1e-9);
});

test('zero stiffness gives a perfectly harmonic series', () => {
  const r = modeRatios(16, 0);
  for (let i = 0; i < 16; i += 1) close(r[i], i + 1);
});

test('the fundamental is pinned to exactly f0', () => {
  // Without this, stiffness would drag the perceived pitch sharp instead of only
  // stretching the partials above it.
  for (const stiffness of [0, 11, 40]) {
    assert.equal(modeRatios(16, stiffness)[0], 1);
  }
});

test('mode ratios follow the stiff-string formula term by term', () => {
  // f_n = n*f1*[1 + beta + beta^2 + (n^2 * pi^2 / 8) * beta^2], beta = 0.011.
  const beta = 0.011;
  const r = modeRatios(20, 11);
  for (let n = 2; n <= 20; n += 1) {
    const expected =
      n * (1 + beta + beta * beta + ((n * n * Math.PI * Math.PI) / 8) * beta * beta);
    close(r[n - 1], expected, 1e-6);
  }
});

test('stiffness stretches the partials progressively sharp', () => {
  const stiff = modeRatios(16, 11);
  const ideal = modeRatios(16, 0);
  // Every partial above the fundamental is sharp...
  for (let i = 1; i < 16; i += 1) {
    assert.ok(stiff[i] > ideal[i], `mode ${i + 1}`);
  }
  // ...and increasingly so, which is what makes a stiff string sound metallic.
  const cents = (i) => 1200 * Math.log2(stiff[i] / ideal[i]);
  for (let i = 2; i < 16; i += 1) {
    assert.ok(cents(i) > cents(i - 1), `mode ${i + 1} stretch should exceed mode ${i}`);
  }
  // beta = 0.011 should be a musically subtle amount on the low partials.
  assert.ok(cents(1) < 40, `2nd partial stretched ${cents(1).toFixed(1)} cents`);
});

test('gains sum to 0.5, leaving 6 dB of headroom', () => {
  for (const m of [2, 3, 4.5, 10, 20]) {
    const g = modeGains(24, m);
    close(g.reduce((a, b) => a + b, 0), 0.5, 1e-6);
  }
});

test('a centre pluck nulls the even modes', () => {
  // m = 2 plucks at L/2, which is a node for every even mode: sin(n*pi/2) = 0.
  const g = modeGains(16, 2);
  for (let i = 1; i < 16; i += 2) {
    assert.ok(Math.abs(g[i]) < 1e-9, `even mode ${i + 1} should be silent, got ${g[i]}`);
  }
  for (let i = 0; i < 16; i += 2) {
    assert.ok(Math.abs(g[i]) > 1e-9, `odd mode ${i + 1} should sound`);
  }
});

test('mode gains carry a sign, which is mode phase not an error', () => {
  // B_n are the Fourier coefficients of the string's triangular initial
  // displacement, so they alternate in sign as sin(n*pi/m) changes quadrant.
  // At m = 2 the surviving odd modes run +,-,+,-. Rectifying them would be
  // wrong: the sign sets each mode's starting phase, and losing it changes the
  // shape of the attack transient.
  const g = modeGains(12, 2);
  assert.ok(g[0] > 0, 'mode 1 positive');
  assert.ok(g[2] < 0, 'mode 3 negative');
  assert.ok(g[4] > 0, 'mode 5 positive');
  assert.ok(g[6] < 0, 'mode 7 negative');
  // The fundamental still dominates by a wide margin.
  assert.ok(Math.abs(g[0]) > 5 * Math.abs(g[2]));
});

test('normalisation stays well conditioned across the pluck range', () => {
  // Normalisation divides by a *signed* sum, so cancellation could in principle
  // blow the scale factor up. It does not: the fundamental dominates everywhere
  // in 2..20, so no plucking position produces a runaway note level.
  for (let m = 2; m <= 20; m += 0.1) {
    const g = modeGains(24, m);
    const maxAbs = Math.max(...[...g].map(Math.abs));
    assert.ok(maxAbs > 0.1 && maxAbs < 1, `m=${m.toFixed(1)} peak gain ${maxAbs}`);
  }
});

test('gains follow the pluck-position formula up to the normalising factor', () => {
  const m = 5;
  const count = 12;
  const g = modeGains(count, m);
  const raw = [];
  for (let n = 1; n <= count; n += 1) {
    raw.push(
      ((2 * m * m) / (n * n * Math.PI * Math.PI * (m - 1))) * Math.sin((n * Math.PI) / m),
    );
  }
  const scale = 0.5 / raw.reduce((a, b) => a + b, 0);
  for (let i = 0; i < count; i += 1) close(g[i], raw[i] * scale);
});

test('plucking nearer the bridge brightens the spectrum', () => {
  // Energy above the 4th mode, as a share of total absolute energy.
  const brightness = (m) => {
    const g = modeGains(20, m);
    let high = 0;
    let all = 0;
    for (let i = 0; i < 20; i += 1) {
      all += Math.abs(g[i]);
      if (i >= 4) high += Math.abs(g[i]);
    }
    return high / all;
  };
  assert.ok(brightness(2) < brightness(6), 'm=6 should be brighter than m=2');
  assert.ok(brightness(6) < brightness(16), 'm=16 should be brighter than m=6');
});

test('gains stay finite across the whole plucking-position range', () => {
  for (let m = 2; m <= 20; m += 0.05) {
    for (const g of modeGains(32, m)) {
      assert.ok(Number.isFinite(g), `m=${m} produced ${g}`);
    }
  }
  // m = 1 is the formula's singularity; it must be guarded, not fatal.
  for (const g of modeGains(8, 1)) assert.ok(Number.isFinite(g));
});

test('decays follow 0.2 + velocity, scaled', () => {
  // Base decay is 0.2 + velocity; damping 0 makes every mode share it, so the
  // whole voice decays as one envelope.
  const flat = modeDecays(8, 0.5, 0, 1);
  for (const d of flat) close(d, 0.7);
  const scaled = modeDecays(8, 0.5, 0, 2);
  for (const d of scaled) close(d, 1.4);
});

test('damping makes higher modes decay faster', () => {
  const d = modeDecays(16, 1, 0.5, 1);
  close(d[0], 1.2); // 0.2 + vel(1)
  for (let i = 1; i < 16; i += 1) {
    assert.ok(d[i] < d[i - 1], `mode ${i + 1} should decay faster than mode ${i}`);
  }
  close(d[3], 1.2 * Math.pow(4, -0.5)); // mode 4 at damping 0.5 -> half
});

test('buildNote drops modes that would alias past Nyquist', () => {
  const sampleRate = 48000;
  // A high note with many modes: the 16th partial of C7 is ~33 kHz.
  const high = buildNote({
    midinote: 96, // ~2093 Hz
    velocity: 0.8,
    pluckPosition: 4,
    modes: 32,
    stiffness: 11,
    damping: 0.5,
    decayScale: 1,
    sampleRate,
  });
  assert.ok(high.count < 32, `kept ${high.count} modes`);
  const f0 = midiToHz(96);
  for (let i = 0; i < high.count; i += 1) {
    assert.ok(f0 * high.ratios[i] < sampleRate * 0.5, `mode ${i + 1} above Nyquist`);
  }

  // A low note keeps everything.
  const low = buildNote({
    midinote: 36,
    velocity: 0.8,
    pluckPosition: 4,
    modes: 32,
    stiffness: 11,
    damping: 0.5,
    decayScale: 1,
    sampleRate,
  });
  assert.equal(low.count, 32);
});

test('buildNote always keeps at least the fundamental', () => {
  // Even an absurdly high note must produce a playable voice rather than nothing.
  const n = buildNote({
    midinote: 127,
    velocity: 1,
    pluckPosition: 4,
    modes: 32,
    stiffness: 11,
    damping: 0.5,
    decayScale: 1,
    sampleRate: 44100,
  });
  assert.ok(n.count >= 1);
  assert.equal(n.ratios.length, n.count);
  assert.equal(n.gains.length, n.count);
  assert.equal(n.decays.length, n.count);
});
