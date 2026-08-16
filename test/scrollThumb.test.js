import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollThumb, THUMB_MARGIN_PX } from '../src/ui/scrollThumb.js';

/**
 * The scroll indicator's geometry. Pure arithmetic, so it is checked here rather
 * than only in test/browser/scroll-indicator-check.html -- that page covers the DOM
 * wiring, this covers what the numbers should be.
 */

/** A page roughly three viewports tall, inside a full-height track. */
const TALL = { scrollTop: 0, scrollHeight: 2400, clientHeight: 800, trackHeight: 800 };

test('content that fits reports nothing to indicate', () => {
  const fits = scrollThumb({ scrollTop: 0, scrollHeight: 700, clientHeight: 800, trackHeight: 800 });
  assert.equal(fits.hidden, true);

  // Exactly equal is the common case -- a page one viewport tall.
  const exact = scrollThumb({ scrollTop: 0, scrollHeight: 800, clientHeight: 800, trackHeight: 800 });
  assert.equal(exact.hidden, true);

  // A sub-pixel overrun is a rounding artefact, not something to show a thumb for.
  const sliver = scrollThumb({ scrollTop: 0, scrollHeight: 800.4, clientHeight: 800, trackHeight: 800 });
  assert.equal(sliver.hidden, true);
});

test('a zero-height track reports hidden -- the above-the-breakpoint case', () => {
  // `.scrollind` is display:none above 640px, so its clientHeight is 0. That is the
  // only thing switching the widget off: the breakpoint lives in CSS alone, and this
  // is what keeps a second copy of it out of the JS.
  const result = scrollThumb({ ...TALL, trackHeight: 0 });
  assert.equal(result.hidden, true);
});

test('thumb height is the visible fraction of the track', () => {
  // 800 of 2400 visible -> one third of an 800px track. Compared with a tolerance
  // because the implementation multiplies before dividing, which lands a few ulps
  // off an exact 800/3 -- the value is rounded to whole pixels before it reaches
  // the DOM anyway.
  const result = scrollThumb(TALL);
  assert.equal(result.hidden, false);
  assert.ok(Math.abs(result.height - 800 / 3) < 1e-9, `height was ${result.height}`);
});

test('a very long page still gets a visible thumb, and it never exceeds the track', () => {
  // 800 of 100000 visible would be 6.4px -- below the floor.
  const floored = scrollThumb({ ...TALL, scrollHeight: 100000, minThumb: 24 });
  assert.equal(floored.height, 24);
  assert.ok(floored.height <= TALL.trackHeight);

  // ...and the floor cannot push the thumb past the end of a short track. The track
  // is too short to spare the margin too, so it shrinks to nothing rather than push
  // the thumb past the track's own bottom.
  const short = scrollThumb({ ...TALL, scrollHeight: 100000, trackHeight: 10, minThumb: 24 });
  assert.equal(short.height, 10);
  assert.equal(short.margin, 0);
  assert.equal(short.top, 0); // no travel left
});

test('the thumb keeps a margin off the top and off the track bottom', () => {
  const atTop = scrollThumb(TALL);
  assert.equal(atTop.top, THUMB_MARGIN_PX);
  assert.equal(atTop.margin, THUMB_MARGIN_PX);

  // Full scroll is scrollHeight - clientHeight.
  const atEnd = scrollThumb({ ...TALL, scrollTop: 1600 });
  assert.equal(atEnd.top, TALL.trackHeight - THUMB_MARGIN_PX - atEnd.height);
  assert.equal(atEnd.top + atEnd.height, TALL.trackHeight - THUMB_MARGIN_PX);
});

test('halfway down the page puts the thumb halfway through its travel', () => {
  const half = scrollThumb({ ...TALL, scrollTop: 800 });
  assert.equal(half.top, (TALL.trackHeight - half.height) / 2);
});

test('the thumb advances monotonically and always stays inside the track', () => {
  let previousTop = -1;
  for (let scrollTop = 0; scrollTop <= 1600; scrollTop += 50) {
    const { hidden, height, top } = scrollThumb({ ...TALL, scrollTop });
    assert.equal(hidden, false, `scrollTop ${scrollTop}`);
    assert.ok(top >= previousTop, `thumb went backwards at scrollTop ${scrollTop}`);
    assert.ok(top >= THUMB_MARGIN_PX, `thumb entered the margin at scrollTop ${scrollTop}`);
    assert.ok(
      top + height <= TALL.trackHeight - THUMB_MARGIN_PX + 1e-9,
      `thumb overran at scrollTop ${scrollTop}`
    );
    previousTop = top;
  }
});

test('rubber-banding past either end clamps rather than leaving the track', () => {
  // iOS reports a scrollTop below 0 and above the maximum while bouncing.
  const above = scrollThumb({ ...TALL, scrollTop: -200 });
  assert.equal(above.top, THUMB_MARGIN_PX);

  const below = scrollThumb({ ...TALL, scrollTop: 5000 });
  assert.equal(below.top, TALL.trackHeight - THUMB_MARGIN_PX - below.height);
});

test('nonsensical input reads as hidden rather than throwing', () => {
  // This runs inside an animation frame; a decoration must not be able to take the
  // page down. Same stance as playheadProgress.stepProgress().
  for (const bad of [NaN, Infinity, undefined]) {
    assert.equal(scrollThumb({ ...TALL, scrollTop: bad }).hidden, true, `scrollTop ${bad}`);
    assert.equal(scrollThumb({ ...TALL, scrollHeight: bad }).hidden, true, `scrollHeight ${bad}`);
    assert.equal(scrollThumb({ ...TALL, clientHeight: bad }).hidden, true, `clientHeight ${bad}`);
    assert.equal(scrollThumb({ ...TALL, trackHeight: bad }).hidden, true, `trackHeight ${bad}`);
  }
});
