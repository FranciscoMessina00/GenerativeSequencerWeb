/**
 * Where the scroll indicator's thumb sits, and how tall it is.
 *
 * Split out of ui/ScrollIndicator.js for the same reason playheadProgress.js is
 * split out of TrackTabs.js: it is the only part with arithmetic worth getting
 * wrong, and this way it is unit-tested in Node rather than only observed in a
 * browser.
 *
 * Pure, and deliberately knows nothing about elements or the viewport -- the caller
 * measures and passes numbers in. That is also what lets the browser check page
 * drive it from an ordinary overflow container instead of the document.
 */

/** Below this the content effectively fits and there is nothing to indicate. */
const SCROLLABLE_EPSILON = 1;

/**
 * Gap kept between the thumb and each end of the track, so a full scroll to either
 * end leaves it sitting just short of the chrome that caps the strip rather than
 * touching it. Shrunk rather than dropped when the track is too short to spare it --
 * same stance as the height floor below giving way instead of overrunning a short
 * track.
 */
export const THUMB_MARGIN_PX = 6;

/**
 * @param {object} opts
 * @param {number} opts.scrollTop     current offset of the scroll container
 * @param {number} opts.scrollHeight  total height of its content
 * @param {number} opts.clientHeight  height of its visible area
 * @param {number} opts.trackHeight   height of the strip the thumb moves inside
 * @param {number} [opts.minThumb]    floor, so a very long page still shows something
 * @param {number} [opts.margin]      gap from each end of the track; see THUMB_MARGIN_PX
 * @returns {{ hidden: boolean, height: number, top: number, margin: number }} `margin`
 *   is the gap actually applied (after shrinking for a short track), so a caller
 *   mapping a pointer position back onto the track -- ScrollIndicator's drag -- uses
 *   the exact same figure rather than a second copy of the shrinking rule.
 */
export function scrollThumb({
  scrollTop,
  scrollHeight,
  clientHeight,
  trackHeight,
  minThumb = 24,
  margin = THUMB_MARGIN_PX,
}) {
  const hiddenResult = { hidden: true, height: 0, top: 0, margin: 0 };

  // A non-finite input is not worth reasoning about, and this runs inside an
  // animation frame -- same defensive stance as stepProgress().
  if (![scrollTop, scrollHeight, clientHeight, trackHeight].every(Number.isFinite)) {
    return hiddenResult;
  }

  // A zero-height track is the ordinary above-the-breakpoint case, not an error:
  // `.scrollind` is display:none there, so the CSS media query is what switches
  // this whole widget off, with no second copy of the breakpoint in JS.
  if (trackHeight <= 0) return hiddenResult;

  const scrollable = scrollHeight - clientHeight;
  if (scrollable <= SCROLLABLE_EPSILON) return hiddenResult;

  // Proportional to the visible fraction, then floored so a very long page renders
  // a thumb you can actually see, and capped so the floor cannot exceed the track.
  const proportional = trackHeight * (clientHeight / scrollHeight);
  const height = Math.min(trackHeight, Math.max(minThumb, proportional));

  // Slack is what is left of the track once the thumb has taken its share. The
  // margin is carved out of that same slack rather than off trackHeight directly, so
  // a track too short to spare it shrinks the margin instead of pushing the thumb
  // past the track's own bottom.
  const slack = trackHeight - height;
  const appliedMargin = Math.min(margin, slack / 2);
  // What is left for the thumb to travel once both margins are set aside, so its
  // bottom lands just short of the track's bottom at full scroll rather than flush
  // with it.
  const travel = slack - appliedMargin * 2;
  // Clamped: iOS rubber-banding reports a scrollTop below 0 and above the maximum,
  // and the thumb should sit still at the end rather than leave the track.
  const fraction = Math.min(1, Math.max(0, scrollTop / scrollable));

  return { hidden: false, height, top: appliedMargin + fraction * travel, margin: appliedMargin };
}
