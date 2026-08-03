/**
 * The instrument's line-art glyphs.
 *
 * Every icon is a 24x24 `<svg>` of unfilled strokes that take their colour from the
 * host's `color` through `currentColor`, so a button hovering from --muted to --accent
 * repaints its icon with it and no glyph carries a palette of its own.
 *
 * Geometry is written directly rather than pulled from an icon font or a sprite sheet:
 * these are a handful of shapes, and a dependency-free project pays for a font in bytes
 * and a flash of unstyled text.
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} tag
 * @param {Record<string, string | number>} attrs
 * @returns {Element}
 */
export function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A 24x24 icon root holding `children`. */
function icon(...children) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'icon' });
  for (const child of children) svg.appendChild(child);
  return svg;
}

const path = (d) => svgEl('path', { d });
const points = (list) => svgEl('polyline', { points: list });

/**
 * The ANSI distinctive shapes, keyed by the operator ids in sequencer/logic.js.
 *
 * Bodies only, no input or output leads: at 24px the leads cost more legibility than the
 * extra recognition they buy. What separates the pairs is deliberately small, exactly as
 * it is on a real schematic -- XOR is OR with a second arc behind the back, NAND is AND
 * with a bubble at the nose -- so the control names the operator in text as well.
 */
const LOGIC_GATES = {
  // Concave back, curving to a point at the nose.
  1: () => icon(path('M5 4 Q9 12 5 20 Q15 20 20 12 Q15 4 5 4 Z')),
  // Flat back, semicircular nose.
  2: () => icon(path('M6 4 H12 A8 8 0 0 1 12 20 H6 Z')),
  // The OR body, moved right to make room for the exclusive-or arc.
  3: () => icon(
    path('M8 4 Q12 12 8 20 Q16 20 20 12 Q16 4 8 4 Z'),
    path('M4 4 Q8 12 4 20'),
  ),
  // The AND body, narrowed to leave the inverting bubble clear of the nose.
  4: () => icon(
    path('M5 5 H11 A7 7 0 0 1 11 19 H5 Z'),
    svgEl('circle', { cx: 20, cy: 12, r: 1.8 }),
  ),
};

/** Gate glyph for a logic operator id. Unknown ids fall back to OR, as applyLogic does. */
export function logicGateIcon(opId) {
  return (LOGIC_GATES[Math.floor(Number(opId))] ?? LOGIC_GATES[1])();
}

/**
 * A five-pip die face.
 *
 * The quincunx is symmetric about the horizontal axis, which matters because this glyph
 * is filled from the bottom up: an asymmetric face would light unevenly and read as a
 * smear rather than as a level.
 */
export function diceIcon() {
  const pip = (cx, cy) => svgEl('circle', { cx, cy, r: 1.5, class: 'icon__dot' });
  return icon(
    svgEl('rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 3.5 }),
    pip(8, 8), pip(16, 8),
    pip(12, 12),
    pip(8, 16), pip(16, 16),
  );
}

/**
 * Two arcs chasing each other round a circle, each ending in an arrowhead.
 *
 * The arcs stop 10 degrees short of the horizontal at both ends, so the gaps the
 * arrowheads sit in are part of the geometry rather than drawn over a closed ring. The
 * barbs are swept back from the arc's tangent rather than squared to the page, which is
 * what stops them reading as flags rather than as arrowheads. The two halves are the same
 * shape turned through 180 degrees.
 */
export function loopIcon() {
  return icon(
    path('M5.1 10.8 A7 7 0 0 1 18.9 10.8'),
    points('15.7,9.6 19.1,12 21.5,8.6'),
    path('M18.9 13.2 A7 7 0 0 1 5.1 13.2'),
    points('8.3,14.4 4.9,12 2.5,15.4'),
  );
}

/**
 * Two arrows crossing, both heads on the right: two positions trading places.
 *
 * Mirror-symmetric about the horizontal axis for the same reason the die is -- it is
 * filled from the bottom up.
 */
export function crossArrowsIcon() {
  return icon(
    path('M4 19 L19 5'),
    points('14.5,5 19,5 19,9.5'),
    path('M4 5 L19 19'),
    points('14.5,19 19,19 19,14.5'),
  );
}

/**
 * The axis-lock toggle's glyph: a horizontal double-arrow crossing a vertical one, the
 * same shape as the platform's own "move" cursor -- deliberately, since that cursor is
 * exactly what free mode leaves the drag track showing (see BiasSpreadSlider.js).
 *
 * One glyph, not two: locked dims the whole thing rather than swapping to a different
 * shape, since brightness alone says whether the two axes currently move together.
 */
export function axisLockIcon(locked) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: locked ? 'icon is-unpaired' : 'icon' });
  svg.append(
    path('M12 3 V21'),
    path('M3 12 H21'),
    points('9,6 12,3 15,6'),
    points('9,18 12,21 15,18'),
    points('6,9 3,12 6,15'),
    points('18,9 21,12 18,15'),
  );
  return svg;
}
