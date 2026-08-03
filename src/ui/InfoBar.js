import { INFO_HINT, INFO_TEXT } from './infoText.js';

/**
 * The pinned footer that says what the control under the pointer does.
 *
 * One bar for the whole instrument rather than a tooltip per control: a tooltip
 * covers the thing it describes and cannot be read while dragging, which is
 * exactly when a description is wanted here. A fixed lane at the bottom is always
 * in the same place and never moves under the hand.
 *
 * Lookup is by id through infoText.js, and `data-info` may name more than one id
 * (space-separated, like `class`) -- the bias/spread track is a single element
 * driving two parameters, so it names both and gets both descriptions.
 *
 * A description too long for the lane scrolls out and back rather than being
 * clipped, since a truncated sentence is worse than no sentence. That is a real
 * animation, unlike every 0.12s transition elsewhere in the stylesheet, so it is
 * kept to the one case that needs it and disabled under prefers-reduced-motion.
 */

/** Joins the descriptions when one element names several ids. */
const SEPARATOR = ' · ';
/** Scroll speed, so a long overrun and a short one travel at the same readable pace. */
const MARQUEE_PX_PER_SEC = 45;
/** Floor, so a two-pixel overrun does not whip across in a fraction of a second. */
const MARQUEE_MIN_SECONDS = 2;
/** Below this the overrun is a rounding artefact, not something to scroll. */
const OVERFLOW_EPSILON = 1;

export class InfoBar {
  /**
   * @param {HTMLElement} element the footer. Its inner lane and text span are built
   *   here rather than in the markup, so the marquee's moving parts stay owned by
   *   one file.
   */
  constructor(element) {
    this.element = element;

    this.laneEl = document.createElement('div');
    this.laneEl.className = 'infobar__lane';

    this.textEl = document.createElement('span');
    this.textEl.className = 'infobar__text';

    this.laneEl.appendChild(this.textEl);
    this.element.appendChild(this.laneEl);

    /** The text currently displayed, so an unchanged one can be skipped. */
    this.text = '';
    this.showHint();
  }

  /**
   * Describe whatever `data-info` named. Ids with no entry are dropped, and a value
   * that resolves to nothing at all falls back to the hint rather than blanking the
   * bar -- an empty pinned bar reads as broken.
   */
  show(value) {
    this.#render(this.#resolve(value) || INFO_HINT);
  }

  /** Back to naming the bar's own purpose, for when nothing is under the pointer. */
  showHint() {
    this.#render(INFO_HINT);
  }

  /** Re-decide whether the current text overruns, after the lane changes width. */
  remeasure() {
    this.#apply(this.text);
  }

  /**
   * Ids to text. Exact match first; a dotted id then falls back to the generic
   * `range.<suffix>` entry, which is what covers BiasSpreadSlider's generated
   * `<key>.min` / `<key>.max` range edges without six near-identical lines of copy.
   */
  #resolve(value) {
    if (!value) return '';
    return String(value)
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => {
        const exact = INFO_TEXT[id];
        if (exact) return exact;
        const dot = id.lastIndexOf('.');
        return dot === -1 ? undefined : INFO_TEXT[`range.${id.slice(dot + 1)}`];
      })
      .filter(Boolean)
      .join(SEPARATOR);
  }

  /**
   * Skipping an unchanged string is what keeps the marquee steady: `pointerover`
   * fires again for every child element the pointer crosses inside one control, and
   * re-applying the text on each would restart the scroll from the beginning
   * forever.
   */
  #render(text) {
    if (text === this.text) return;
    this.text = text;
    this.#apply(text);
  }

  #apply(text) {
    this.textEl.textContent = text;
    this.textEl.classList.remove('is-marquee');

    // This read does two jobs. It measures the overrun, and it flushes the class
    // removal above -- without a layout read in between, dropping a class and
    // re-adding it in the same frame leaves the animation running from where it
    // was instead of starting over.
    const overflow = this.textEl.scrollWidth - this.laneEl.clientWidth;

    if (overflow <= OVERFLOW_EPSILON) {
      this.textEl.style.removeProperty('--marquee-shift');
      this.textEl.style.removeProperty('--marquee-duration');
      return;
    }

    // Plain unit-bearing values, no calc() on either side, so a test can read them
    // back and compare -- same contract as FillIconControl's --fill-top.
    const seconds = Math.max(MARQUEE_MIN_SECONDS, overflow / MARQUEE_PX_PER_SEC);
    this.textEl.style.setProperty('--marquee-shift', `${-Math.round(overflow)}px`);
    this.textEl.style.setProperty('--marquee-duration', `${seconds.toFixed(2)}s`);
    this.textEl.classList.add('is-marquee');
  }
}
