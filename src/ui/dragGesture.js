/**
 * The vertical-drag gesture shared by DragNumber, FillIconControl and (for its
 * spread axis only) BiasSpreadSlider -- extracted here so the three controls can
 * never answer the same hand movement differently by accident, the way three
 * independently-maintained copies eventually would.
 *
 * Two tiers, not one. `dragDeltaValue` is the pure math (shared by all three
 * controls, including BiasSpreadSlider, whose horizontal bias axis and axis-lock
 * mode are otherwise genuinely different from the other two and stay out of
 * `bindDragAxis`). `bindDragAxis` is the event wiring itself -- pointer capture,
 * wheel, dblclick, and the arrow/page/home/end key map -- shared only by DragNumber
 * and FillIconControl, whose gestures are actually the same shape. Forcing
 * BiasSpreadSlider's two-axis, axis-locking drag through `bindDragAxis` would need
 * as many opt-out flags as it would save lines, so it keeps its own `#bindTrack`.
 */

/** Travel, in pixels, for one full sweep of a parameter's range. */
export const FULL_RANGE_PX = 180;
/** How much finer a shift-held drag reads the same travel. */
export const FINE_DIVISOR = 8;

/**
 * How hard a `curve: 'exp'` param's drag is bent toward its low end.
 *
 * 3 was chosen by what it does at the two ends rather than as a round number: the
 * halfway point of the travel lands at 18% of the range, the bottom of the drag reads
 * about 6x finer than a linear one, and the top about 3x coarser. Higher starts to
 * make the upper half feel like it is running away; lower stops being worth the
 * departure from a plain linear drag.
 */
export const EXP_DRAG_K = 3;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** Raw value implied by a vertical drag delta from a start value, shift-fine-halved. */
export function dragDeltaValue(startValue, dy, range, shiftKey) {
  let perPx = range / FULL_RANGE_PX;
  if (shiftKey) perPx /= FINE_DIVISOR;
  return startValue + dy * perPx;
}

/**
 * The same gesture, warped so the low end of the range gets more of the travel.
 *
 * For a param whose useful settings are bunched near its minimum -- the envelope
 * times, where 5 ms and 40 ms are different sounds but 3.2 s and 3.5 s are the same
 * one -- a linear drag spends most of its 180 px where nothing is being decided.
 *
 * The drag moves a *position* `u` linearly across 0..1, and the value is
 * `min + span * (e^(k·u) − 1) / (e^k − 1)`. One full sweep still covers the whole
 * range, so the gesture's shape is unchanged; only where its resolution sits moves.
 * `u` is recovered from `startValue` on every move rather than carried, so the
 * mapping is a pure function of where the drag began and how far it has travelled.
 *
 * Unlike the linear version this clamps at both ends instead of letting the value
 * run past them for `quantize` to catch later -- overshooting an exponential would
 * mean exponentiating the overshoot. The practical difference is an improvement:
 * dragging past the top and back down responds immediately rather than after
 * retracing however far it went.
 */
export function expDragDeltaValue(startValue, dy, min, max, shiftKey) {
  const span = max - min;
  if (!(span > 0)) return startValue;

  const t = clamp01((startValue - min) / span);
  // expm1/log1p rather than exp/log: both arguments are small near the bottom of the
  // range, which is exactly where this curve exists to give resolution.
  const u = Math.log1p(t * Math.expm1(EXP_DRAG_K)) / EXP_DRAG_K;

  let perPx = 1 / FULL_RANGE_PX;
  if (shiftKey) perPx /= FINE_DIVISOR;

  const next = clamp01(u + dy * perPx);
  return min + span * (Math.expm1(EXP_DRAG_K * next) / Math.expm1(EXP_DRAG_K));
}

/**
 * Wire one element for DragNumber/FillIconControl's shared gesture vocabulary:
 * pointer-drag (captured, so it survives leaving the element), wheel (one step per
 * notch), dblclick (reset), and Arrow/Page/Home/End keys. Deliberately
 * value-math-agnostic -- every hook receives raw deltas/directions and the caller
 * decides what a step or a range even means -- so it doesn't need to know about
 * DragNumber's enumerated-`values` mode or FillIconControl's hover-peeking state;
 * those stay local to each caller.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.element
 * @param {(e: PointerEvent) => void} opts.onDragStart capture whatever start state
 *   this gesture needs (e.g. the value being dragged from)
 * @param {(dy: number, shiftKey: boolean) => void} opts.onDragMove
 * @param {(e: PointerEvent) => void} [opts.onDragEnd]
 * @param {(direction: 1 | -1) => void} opts.onWheelNudge
 * @param {() => void} opts.onDblClick
 * @param {(steps: 1 | -1 | 10 | -10) => void} opts.onKeyNudge
 * @param {() => void} opts.onHome
 * @param {() => void} opts.onEnd
 */
export function bindDragAxis({
  element, onDragStart, onDragMove, onDragEnd, onWheelNudge, onDblClick, onKeyNudge, onHome, onEnd,
}) {
  /** undefined means "not dragging" -- the sentinel pointermove/end both check. */
  let dragStartY;

  element.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    element.setPointerCapture(e.pointerId);
    element.classList.add('is-dragging');
    dragStartY = e.clientY;
    onDragStart(e);
  });

  element.addEventListener('pointermove', (e) => {
    if (dragStartY === undefined) return;
    // Up is positive: dragging toward the top of the screen raises the value.
    onDragMove(dragStartY - e.clientY, e.shiftKey);
  });

  const end = (e) => {
    if (dragStartY === undefined) return;
    dragStartY = undefined;
    element.classList.remove('is-dragging');
    if (element.hasPointerCapture?.(e.pointerId)) element.releasePointerCapture(e.pointerId);
    onDragEnd?.(e);
  };
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);

  element.addEventListener('wheel', (e) => {
    e.preventDefault();
    onWheelNudge(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  element.addEventListener('dblclick', () => onDblClick());

  element.addEventListener('keydown', (e) => {
    const map = {
      ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1,
      PageUp: 10, PageDown: -10,
    };
    if (e.key in map) {
      e.preventDefault();
      onKeyNudge(map[e.key]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onHome();
    } else if (e.key === 'End') {
      e.preventDefault();
      onEnd();
    }
  });
}
