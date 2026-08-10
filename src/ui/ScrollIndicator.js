import { scrollThumb } from './scrollThumb.js';

/**
 * The scrollbar in the phone-only column down the right edge of the page.
 *
 * The column exists because almost every vertical strip of this instrument is a
 * drag control: `.dragnum`, `.bsslider__track` and `.fillicon` all set
 * `touch-action: none`, which kills a pan before any JS runs, and between them they
 * tile most of a phone screen -- including the tabs strip, where each of the four
 * tabs carries a level and a swing drag-number. So a column with no control in it
 * is reserved at the right edge (see `--gutter` in main.css), and this is the bar
 * that lives in it.
 *
 * Relaxing `touch-action` on those controls instead was considered and rejected:
 * all three read a *vertical* drag (the bias/spread track reads vertical for
 * spread), so `pan-y` would hand the browser exactly the gesture they need, and
 * `pan-x` buys nothing on a page that only scrolls vertically.
 *
 * **It scrolls like a scrollbar, not like a pan.** Dragging down walks *down* the
 * page -- the thumb follows the finger -- rather than dragging the page down the
 * way a touch pan does. That is the whole reason the strip takes `touch-action:
 * none` of its own: the browser's pan would run the other way. The gesture can
 * still only ever scroll, never edit a value, which is what the column is for.
 *
 * The 640px breakpoint lives in the stylesheet and nowhere else. Above it
 * `.scrollind` is `display: none`, so its `clientHeight` is 0, so scrollThumb()
 * reports nothing to draw: the media query switches this off on its own, with no
 * matchMedia here to drift out of step with it.
 */

/** Floor for the thumb, so a very long page still shows something you can see. */
const MIN_THUMB_PX = 24;

export class ScrollIndicator {
  /**
   * @param {HTMLElement} element the strip. Its thumb is built here rather than in
   *   the markup, the same way InfoBar builds its own lane and text span.
   * @param {object} [opts]
   * @param {Element} [opts.scroller] what is being scrolled. Injected, like
   *   Scheduler's clock, so the browser check page can drive this from an ordinary
   *   overflow container and assert exact numbers instead of scrolling a document.
   * @param {Window | Element} [opts.scrollSource] what to listen on. The document's
   *   scroll event fires at `window`, not at the scrolling element, so the two
   *   cannot be derived from one another.
   * @param {() => {top: number, bottom: number}} [opts.insets] how much fixed chrome
   *   covers the top and bottom of the viewport. The header and the info bar keep
   *   the full width of the screen, so the bar has to stop short of both rather
   *   than run underneath them -- and the header's height changes with wrapping, so
   *   this is measured rather than written down. Defaults to no inset, which is
   *   what a check page driving a plain container wants.
   * @param {Element[]} [opts.observe] elements whose size changing should trigger a
   *   remeasure. A window `resize` alone is not enough: the header settles after
   *   load and grows again whenever its status line rewraps, and the page's own
   *   height changes when a track with more controls is selected -- none of which
   *   fires a resize. A ResizeObserver catches all three, the same way LfoView
   *   watches its canvas.
   */
  constructor(element, { scroller, scrollSource, insets, observe = [] } = {}) {
    this.element = element;
    this.scroller = scroller ?? document.scrollingElement ?? document.documentElement;
    this.scrollSource = scrollSource ?? (scroller ?? window);
    this.insets = insets ?? (() => ({ top: 0, bottom: 0 }));

    this.thumbEl = document.createElement('div');
    this.thumbEl.className = 'scrollind__thumb';
    this.element.appendChild(this.thumbEl);

    /** Pending animation frame, so a burst of scroll events costs one update. */
    this.frame = null;
    /** Last geometry written, so a drag can map a pointer onto it. */
    this.thumb = { hidden: true, height: 0, top: 0 };
    /** Where inside the thumb the drag was started, so it does not jump. */
    this.grabOffset = 0;
    this.dragging = false;
    /** Last values written to `style`, so an unchanged inset costs no layout. */
    this.appliedTop = null;
    this.appliedBottom = null;

    const schedule = () => this.#schedule();
    // Passive: this never calls preventDefault, and saying so lets the browser
    // scroll without waiting on the listener.
    this.scrollSource.addEventListener('scroll', schedule, { passive: true });
    // The strip's own height and the content's both change with the viewport.
    window.addEventListener('resize', schedule);

    // Safe against a feedback loop: everything written back is on the fixed strip,
    // which is out of flow and so cannot resize anything being watched here.
    if (observe.length > 0) {
      this.observer = new ResizeObserver(schedule);
      for (const target of observe) this.observer.observe(target);
    }

    this.#bindDrag();
    this.update();
  }

  /**
   * Grab anywhere on the strip and the page follows.
   *
   * Landing off the thumb centres it under the pointer first, then drags from
   * there -- the same "the gesture starts by taking you where you pointed" the
   * bias/spread track already does. Landing on the thumb keeps the offset it was
   * grabbed by, so it does not jump out from under the finger.
   */
  #bindDrag() {
    this.element.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.thumb.hidden) return;
      e.preventDefault();
      this.element.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.element.classList.add('is-dragging');

      const y = e.clientY - this.element.getBoundingClientRect().top;
      const onThumb = y >= this.thumb.top && y <= this.thumb.top + this.thumb.height;
      this.grabOffset = onThumb ? y - this.thumb.top : this.thumb.height / 2;
      this.#scrollToPointer(y);
    });

    this.element.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.#scrollToPointer(e.clientY - this.element.getBoundingClientRect().top);
    });

    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.element.classList.remove('is-dragging');
      // Releasing a capture the browser has already dropped throws, and a stray
      // pointercancel is exactly when that happens.
      if (this.element.hasPointerCapture?.(e.pointerId)) {
        this.element.releasePointerCapture(e.pointerId);
      }
    };
    this.element.addEventListener('pointerup', end);
    this.element.addEventListener('pointercancel', end);
  }

  /**
   * Put the thumb's grabbed point under `y` and scroll to match.
   *
   * The mapping is deliberately the scrollbar's, not the pan's: a larger `y` is a
   * larger scrollTop, so pulling down moves further down the page.
   */
  #scrollToPointer(y) {
    const travel = this.element.clientHeight - this.thumb.height;
    if (travel <= 0) return;

    const top = Math.min(travel, Math.max(0, y - this.grabOffset));
    const scrollable = this.scroller.scrollHeight - this.scroller.clientHeight;
    this.scroller.scrollTop = (top / travel) * scrollable;
  }

  /**
   * Coalesce to one update per frame. Scroll fires far more often than the screen
   * repaints, and every update is a layout read plus two style writes.
   */
  #schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.update();
    });
  }

  /** Measure, and write the result out. Public so a test can drive it directly. */
  update() {
    this.#applyInsets();

    const thumb = scrollThumb({
      scrollTop: this.scroller.scrollTop,
      scrollHeight: this.scroller.scrollHeight,
      clientHeight: this.scroller.clientHeight,
      trackHeight: this.element.clientHeight,
      minThumb: MIN_THUMB_PX,
    });
    this.thumb = thumb;

    this.thumbEl.classList.toggle('is-hidden', thumb.hidden);
    if (thumb.hidden) return;

    // Plain unit-bearing values, no calc() on either side, so a test can read them
    // back and compare -- the same contract as InfoBar's --marquee-shift and
    // FillIconControl's --fill-top. Rounded to whole pixels: this is a decoration
    // redrawn on every frame of a scroll, and sub-pixel positions would only cost
    // the compositor work nobody can see.
    this.thumbEl.style.setProperty('--thumb-height', `${Math.round(thumb.height)}px`);
    this.thumbEl.style.setProperty('--thumb-top', `${Math.round(thumb.top)}px`);
  }

  /**
   * Stop the strip short of the fixed header and info bar. Written only when the
   * measurement actually changes, so the common case costs no style invalidation.
   */
  #applyInsets() {
    const { top, bottom } = this.insets();
    if (top !== this.appliedTop) {
      this.element.style.top = `${top}px`;
      this.appliedTop = top;
    }
    if (bottom !== this.appliedBottom) {
      this.element.style.bottom = `${bottom}px`;
      this.appliedBottom = bottom;
    }
  }
}
