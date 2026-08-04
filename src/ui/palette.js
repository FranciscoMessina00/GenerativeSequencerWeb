/**
 * One colour scheme per track page.
 *
 * The instrument used to spell its accent out by hand in about forty places -- 27
 * copies of `rgba(111, 184, 224, α)` for the one accent at various opacities, three
 * pre-blended hex constants, and a second palette living as literals inside
 * EuclidView and LfoView. Four pages need four of those, so the relationships move
 * here and each page authors only what is genuinely its own.
 *
 * Each page authors exactly three colours:
 *
 *   `accent`  the page's identity. Borders, active states, the playhead, panel tint.
 *   `alt`     the counterpart the random-pulse half of the ring is drawn in. It
 *             exists to *contrast* with `accent`, so it has to be re-chosen per
 *             page rather than pinned -- a fixed amber would collide with an amber
 *             accent and stop meaning "the other input".
 *   `pulse`   the ring's Euclid pulse, and the LFO curve. Authored rather than
 *             derived because a deeper, *more saturated* accent is not something a
 *             mix with a neutral can produce -- mixing toward the well desaturates,
 *             and the original #4a90b8 is a good deal more saturated than a
 *             darkened #6fb8e0. It is also the largest block of colour on screen,
 *             which is exactly where a formula's compromises would show.
 *
 * Everything else derives -- the bright highlights by mixing toward white, where a
 * few points of saturation are invisible. Two roles deliberately do not vary at all:
 *
 *   FIRED (the green band outside the rim, and every modulation-reach mark) is one
 *   colour on every page. It answers "did this step actually sound" and "how far
 *   can the LFO reach" -- questions about the instrument, not about which page you
 *   are on. Four greens would read as four different features.
 *
 *   The neutral whites mean "absence" -- an empty step, a zero line. Absence has
 *   no hue.
 *
 * Division of labour with the stylesheet: CSS derives what only CSS uses (the alpha
 * ladder, the panel tints) with color-mix() from `--accent`, and this module derives
 * what the canvases need and publishes it as custom properties so CSS can share
 * it -- which is also what stops `.swatch.pulse` and the ring's own pulse colour
 * from drifting apart, as they had.
 */

/**
 * Untinted bases. styles/main.css declares the same values as `--base-*`, since it
 * needs them for its own color-mix() derivations; a test pins the two copies
 * together.
 */
export const BASE = {
  bg: '#12151a',
  panel: '#191d24',
  panel2: '#1f242c',
  line: '#2b323c',
  /** The inset "well" behind sliders, scopes and the readout. Darker than bg. */
  well: '#0e1116',
};

/** The one colour that never follows the page: it fired, or the LFO reaches here. */
export const FIRED = '#82e696';

/**
 * The pages, in tab order. Page 1 is the instrument's original blue and amber, so
 * a single-track patch looks exactly as it always did.
 *
 * Hues are kept clear of FIRED's green, so no page's accent can be mistaken for a
 * fired step.
 */
export const PAGE_PALETTES = [
  { name: 'I', accent: '#6fb8e0', alt: '#e0b86f', pulse: '#4a90b8' },
  { name: 'II', accent: '#b18ee0', alt: '#cfe07a', pulse: '#7a5fa8' },
  { name: 'III', accent: '#e0819b', alt: '#6fd8c0', pulse: '#a85670' },
  { name: 'IV', accent: '#e0a865', alt: '#77b8e0', pulse: '#a87840' },
];

/** Channels of a `#rgb` or `#rrggbb` string. */
function parseHex(hex) {
  const text = String(hex).replace('#', '');
  const full = text.length === 3 ? text.replace(/./g, (c) => c + c) : text;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }) {
  const pair = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * `weight` of `a` over `b`, matching `color-mix(in srgb, a <weight>%, b)` so the
 * same recipe written here and in the stylesheet gives the same colour.
 */
export function mix(a, b, weight) {
  const x = parseHex(a);
  const y = parseHex(b);
  const t = Math.max(0, Math.min(1, weight));
  return toHex({
    r: x.r * t + y.r * (1 - t),
    g: x.g * t + y.g * (1 - t),
    b: x.b * t + y.b * (1 - t),
  });
}

/** A hex colour as `rgba()`, for the canvas paths that want transparency. */
export function alpha(hex, a) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Neutral whites: absence, on every page. */
const NEUTRAL = {
  restFill: 'rgba(255, 255, 255, 0.055)',
  restFillFaint: 'rgba(255, 255, 255, 0.05)',
  restLine: 'rgba(255, 255, 255, 0.10)',
  discEdge: 'rgba(255, 255, 255, 0.06)',
};

/** Wrap an out-of-range page index rather than handing back undefined. */
function pageIndex(page) {
  const n = Math.trunc(Number(page));
  if (!Number.isFinite(n)) return 0;
  const len = PAGE_PALETTES.length;
  return ((n % len) + len) % len;
}

/**
 * Every colour a canvas needs for one page.
 *
 * Pure and cheap, but memoised: EuclidView redraws on every animation frame while
 * the transport runs, and there is no reason to re-derive a constant.
 */
const cache = new Map();

export function paletteFor(page) {
  const index = pageIndex(page);
  const hit = cache.get(index);
  if (hit) return hit;

  const { name, accent, alt, pulse } = PAGE_PALETTES[index];
  const palette = {
    index,
    name,
    accent,
    alt,
    pulse,

    // The Euclid half of the ring: the authored pulse where the playhead is not,
    // lightened toward white where it is.
    ringPulse: pulse,
    ringPulseHead: mix(accent, '#ffffff', 0.6),
    // The playhead outline frames the whole step, so it is the brightest thing here.
    ringPlayhead: mix(accent, '#ffffff', 0.35),
    ringRest: NEUTRAL.restFill,
    ringRestHead: alpha(mix(accent, '#ffffff', 0.35), 0.3),
    ringRestLine: NEUTRAL.restLine,

    // The random half, in the page's counterpart hue.
    ringRandom: alpha(alt, 0.9),
    ringRandomHead: mix(alt, '#ffffff', 0.45),
    ringRandomOff: alpha(alt, 0.3),
    ringRandomRest: NEUTRAL.restFillFaint,

    // Shared, on purpose -- see the module comment.
    ringFired: alpha(FIRED, 0.9),

    // The disc the hub controls sit on: the same tint the stylesheet gives .group.
    hubDisc: mix(accent, BASE.panel, 0.05),
    hubDiscEdge: NEUTRAL.discEdge,

    // The LFO scope draws in the same colour as a ring pulse: both are "this is the
    // page's signal", and they were the same literal before there were pages.
    lfoCurve: pulse,
    lfoZero: NEUTRAL.restLine,
  };

  cache.set(index, palette);
  return palette;
}

/**
 * Repaint the document in a page's colours.
 *
 * Only the handful of tokens that CSS cannot derive on its own are written here;
 * everything else in the stylesheet hangs off `--accent` through color-mix(), so
 * one assignment retints every panel, border and active state at once.
 *
 * `data-page` is set too, for the rules that want to key off the page rather than
 * off a colour.
 */
export function applyPalette(page, root = document.documentElement) {
  const p = paletteFor(page);
  root.style.setProperty('--accent', p.accent);
  root.style.setProperty('--accent-alt', p.alt);
  root.style.setProperty('--ring-pulse', p.ringPulse);
  root.style.setProperty('--ring-random', p.ringRandom);
  root.dataset.page = String(p.index);
  return p;
}
