import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BASE,
  FIRED,
  PAGE_PALETTES,
  alpha,
  mix,
  paletteFor,
} from '../src/ui/palette.js';

const CSS = new URL('../styles/main.css', import.meta.url);

/** Every role paletteFor() promises, so a missing one fails here not on a canvas. */
const ROLES = [
  'accent', 'alt', 'pulse',
  'ringPulse', 'ringPulseHead', 'ringPlayhead', 'ringRest', 'ringRestHead', 'ringRestLine',
  'ringRandom', 'ringRandomHead', 'ringRandomOff', 'ringRandomRest', 'ringFired',
  'hubDisc', 'hubDiscEdge', 'lfoCurve', 'lfoZero',
];

const isColour = (v) => /^#[0-9a-f]{6}$/i.test(v) || /^rgba\(\d+, \d+, \d+, [\d.]+\)$/.test(v);

test('mix matches color-mix(in srgb, a <weight>%, b)', () => {
  // The weight is the FIRST colour's share, so the stylesheet and this module can
  // spell the same recipe and get the same colour.
  assert.equal(mix('#000000', '#ffffff', 1), '#000000');
  assert.equal(mix('#000000', '#ffffff', 0), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  // Shorthand hex expands.
  assert.equal(mix('#fff', '#000', 1), '#ffffff');
  // Out-of-range weights clamp rather than overshooting into a broken colour.
  assert.equal(mix('#000000', '#ffffff', 5), '#000000');
  assert.equal(mix('#000000', '#ffffff', -5), '#ffffff');
});

test('alpha turns a hex into a canvas-usable rgba', () => {
  assert.equal(alpha('#6fb8e0', 0.9), 'rgba(111, 184, 224, 0.9)');
});

test('there are four pages, each with its own accent', () => {
  assert.equal(PAGE_PALETTES.length, 4);
  const accents = PAGE_PALETTES.map((p) => p.accent);
  assert.equal(new Set(accents).size, 4, 'two pages share an accent');
  for (const p of PAGE_PALETTES) {
    for (const role of ['accent', 'alt', 'pulse']) {
      assert.ok(/^#[0-9a-f]{6}$/i.test(p[role]), `${p.name}: ${role} must be full hex`);
    }
    assert.notEqual(p.accent, p.alt, `${p.name}: alt exists to contrast with accent`);
  }
});

test('page 1 keeps the instrument\'s original colours exactly', () => {
  // Every authored colour, so a patch made before there were pages looks as it did.
  assert.deepEqual(PAGE_PALETTES[0], {
    name: 'I', accent: '#6fb8e0', alt: '#e0b86f', pulse: '#4a90b8',
  });
  assert.equal(paletteFor(0).ringPulse, '#4a90b8');
  assert.equal(paletteFor(0).ringRandom, 'rgba(224, 184, 111, 0.9)');
  assert.equal(paletteFor(0).lfoCurve, '#4a90b8');
});

test('a page\'s pulse is a deeper version of its accent, not a different hue', () => {
  // It is the largest block of colour on screen; if it drifts off the accent's hue
  // the ring stops belonging to the page.
  const channels = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  for (const p of PAGE_PALETTES) {
    const a = channels(p.accent);
    const d = channels(p.pulse);
    assert.ok(d.every((v, i) => v < a[i]), `${p.name}: pulse must be darker than accent`);
    // Same channel ordering means the same hue family -- brightest channel stays
    // brightest, dimmest stays dimmest.
    const order = (c) => [...c.keys()].sort((x, y) => c[y] - c[x]).join('');
    assert.equal(order(d), order(a), `${p.name}: pulse shifts the hue away from accent`);
  }
});

test('every role resolves to a real colour on every page', () => {
  for (let page = 0; page < PAGE_PALETTES.length; page += 1) {
    const p = paletteFor(page);
    for (const role of ROLES) {
      assert.ok(role in p, `page ${page} is missing ${role}`);
      assert.ok(isColour(p[role]), `page ${page} ${role} = ${p[role]} is not a colour`);
    }
  }
});

test('paletteFor is deterministic and hands back the same object', () => {
  // Memoised on purpose: EuclidView reads it on every animation frame.
  assert.equal(paletteFor(2), paletteFor(2));
  assert.deepEqual(paletteFor(1), paletteFor(1));
});

test('an out-of-range or junk page wraps instead of returning undefined', () => {
  assert.equal(paletteFor(4).index, 0);
  assert.equal(paletteFor(-1).index, 3);
  assert.equal(paletteFor(Number.NaN).index, 0);
  assert.equal(paletteFor(undefined).index, 0);
});

test('the fired green is the same on every page', () => {
  // It answers "did this step sound", which is not a question about the page. Four
  // greens would read as four different features.
  const fired = [0, 1, 2, 3].map((p) => paletteFor(p).ringFired);
  assert.equal(new Set(fired).size, 1);
  assert.equal(fired[0], alpha(FIRED, 0.9));
});

test('no page\'s accent could be mistaken for the fired green', () => {
  // Hue distance is what matters, and the crude proxy is enough here: the fired
  // green is the only colour on the ring whose meaning is fixed, so an accent that
  // lands in the same place would make a pulse look like a trigger.
  const channels = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [fr, fg, fb] = channels(FIRED);
  for (const p of PAGE_PALETTES) {
    const [r, g, b] = channels(p.accent);
    const distance = Math.abs(r - fr) + Math.abs(g - fg) + Math.abs(b - fb);
    assert.ok(distance > 120, `${p.name} (${p.accent}) sits too close to the fired green`);
  }
});

test('the neutral whites do not follow the page', () => {
  // They mean "absence" -- an empty step, a zero line -- and absence has no hue.
  for (const role of ['ringRest', 'ringRestLine', 'hubDiscEdge', 'lfoZero', 'ringRandomRest']) {
    const values = [0, 1, 2, 3].map((p) => paletteFor(p)[role]);
    assert.equal(new Set(values).size, 1, `${role} varies by page`);
    assert.match(values[0], /^rgba\(255, 255, 255/, `${role} is not neutral`);
  }
});

test('the base colours in the stylesheet match the ones this module derives from', () => {
  // The canvases derive their colours here, the rules derive theirs with
  // color-mix(); both start from these five, so the two copies have to agree.
  const css = readFileSync(CSS, 'utf8');
  const declared = (name) => {
    const found = new RegExp(`^\\s*--base-${name}:\\s*(#[0-9a-f]{6});`, 'mi').exec(css);
    assert.ok(found, `styles/main.css declares no --base-${name}`);
    return found[1].toLowerCase();
  };
  assert.equal(declared('bg'), BASE.bg);
  assert.equal(declared('panel'), BASE.panel);
  assert.equal(declared('panel-2'), BASE.panel2);
  assert.equal(declared('line'), BASE.line);
  assert.equal(declared('well'), BASE.well);
});

test('the stylesheet no longer spells the accent out by hand', () => {
  // The reason a second page was impossible. If this fails, a literal crept back in
  // and that rule will not follow the page.
  const css = readFileSync(CSS, 'utf8');
  // Everything after the :root block, where the tokens themselves are defined.
  const body = css.slice(css.indexOf('* { box-sizing'));
  for (const literal of ['rgba(111, 184, 224', 'rgba(130, 230, 150', '#4a90b8', '#29404f', '#3a5c71', '#2c4a3a']) {
    assert.ok(!body.includes(literal), `${literal} is still written out by hand`);
  }
});

test('the page-1 fallbacks in :root match what palette.js derives', () => {
  // A browser that never runs applyPalette keeps the authored values, so they have
  // to be page 1's actual colours rather than an approximation.
  const css = readFileSync(CSS, 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('* { box-sizing'));
  const declared = (name) => {
    const found = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'mi').exec(root);
    assert.ok(found, `:root declares no --${name}`);
    return found[1].trim();
  };
  const page1 = paletteFor(0);
  assert.equal(declared('accent'), page1.accent);
  assert.equal(declared('accent-alt'), page1.alt);
  assert.equal(declared('ring-pulse'), page1.ringPulse);
  assert.equal(declared('ring-random'), page1.ringRandom);
  assert.equal(declared('accent-2'), FIRED);
});
