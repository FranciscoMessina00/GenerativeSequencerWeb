import { bindDragAxis, dragDeltaValue } from './dragGesture.js';
import { decimalsFor, formatNumber, quantize } from './numberUtils.js';

/**
 * An icon that fills from the bottom up as its value rises, dragged vertically.
 *
 * Where a slider spends a whole row on a track and a thumb, this spends 24 pixels and
 * says the same thing: how full it is *is* the value. That suits the two parameters it
 * carries, probability and permutation, because neither has a number worth reading
 * precisely -- what matters is roughly how much of it is switched on.
 *
 * The gestures are DragNumber's, deliberately, down to the shared travel constants:
 *
 *   drag up/down   coarse change, full range over one FULL_RANGE_PX sweep
 *   shift + drag   eight times finer
 *   wheel          one step per notch
 *   arrows         one step; page up/down ten; home/end to the extremes
 *   double click   back to the schema default
 *
 * A press without movement changes nothing, so the icon can be clicked to focus it for
 * the keyboard without disturbing the value.
 *
 * The caption gives way to the live value while hovering or dragging -- fine most of the
 * time, since "roughly how full" is the point, but a hand actively on the control usually
 * wants the number that hand is producing.
 *
 * A leaf, like DragNumber and Dropdown: it reports through `onInput` and never touches
 * the bus, leaving the owner to decide what a gesture means.
 */
export class FillIconControl {
  /**
   * @param {object} opts
   * @param {object} opts.spec entry from paramSchema
   * @param {() => Element} opts.buildIcon returns a fresh 24x24 glyph; called twice, for
   *   the dim base layer and the accent layer clipped to the fill level
   * @param {string} opts.label short uppercase caption under the glyph, shown except
   *   while hovering or dragging, when the live value takes its place
   * @param {(value: number) => void} opts.onInput
   */
  constructor({ spec, buildIcon, label, onInput }) {
    this.spec = spec;
    this.onInput = onInput;
    this.value = spec.def;
    this.caption = label;
    // Whether to show the live value in place of the caption -- while hovering or
    // dragging, seeing the caption is less useful than seeing the number it would
    // otherwise cost a whole row to display.
    this.hovering = false;
    // A drag can leave the element while pointer-captured, so peeking has to key off
    // this flag rather than :hover -- a full-range sweep is 180px, far more than the
    // icon's own footprint.
    this.dragging = false;

    this.element = document.createElement('div');
    this.element.className = 'fillicon';
    this.element.tabIndex = 0;
    // A slider by behaviour, even though it is drawn as a glyph rather than a track.
    this.element.setAttribute('role', 'slider');
    this.element.setAttribute('aria-orientation', 'vertical');
    this.element.setAttribute('aria-label', spec.label);
    // Names this control's description for the info footer -- see ui/infoText.js.
    this.element.dataset.info = spec.key;

    const glyph = document.createElement('span');
    glyph.className = 'fillicon__glyph';

    // Two copies of the same geometry stacked exactly on top of each other: the lower
    // one dim, the upper one accent-coloured and clipped to the bottom `value` of its
    // height. Cheaper and less fragile than an SVG <clipPath>, which would need a
    // document-unique id per instance.
    const base = buildIcon();
    base.classList.add('fillicon__base');
    this.fillEl = buildIcon();
    this.fillEl.classList.add('fillicon__fill');

    // The LFO's reach, when this is its target -- a line beside the glyph rather
    // than on it, since the glyph's own fill already means "value" and a second
    // thing changing the same 24px would just be noise. Hidden by default; see
    // setModRange().
    this.modRangeEl = document.createElement('span');
    this.modRangeEl.className = 'fillicon__modrange';
    this.modDotEl = document.createElement('span');
    this.modDotEl.className = 'fillicon__moddot';

    glyph.append(base, this.fillEl, this.modRangeEl, this.modDotEl);

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'fillicon__label';

    this.element.append(glyph, this.labelEl);
    this.#render();
    this.#bind();
  }

  /**
   * The one schema key this control owns.
   *
   * Present so an instance owned directly by the wiring can be registered for two-way
   * sync, as Dropdown is. Nested instances -- the permutation inside TrigLoopControl --
   * are covered by their owner's keys() instead, and never have this called.
   */
  keys() {
    return [this.spec.key];
  }

  /**
   * The spoken form, for aria-valuetext -- the only place the number appears at all,
   * since the glyph's fill is the visible readout.
   *
   * Read off `spec.display` rather than passed in, so the schema stays the one place a
   * param's presentation is declared. Percent decimals follow the step: 0.01 speaks whole
   * percents, 0.001 speaks tenths, so the finer of the two params is not rounded to a
   * figure that barely moves as it is dragged.
   */
  #format(value) {
    if (this.spec.display === 'percent') {
      return `${(value * 100).toFixed(Math.max(0, decimalsFor(this.spec.step) - 2))}%`;
    }
    return formatNumber(value, this.spec.step);
  }

  /** Where the value sits in its range, 0..1. */
  #fraction() {
    return this.#fractionOf(this.value);
  }

  /** Where an arbitrary value sits in this control's range, 0..1 -- for setModRange. */
  #fractionOf(value) {
    const range = this.spec.max - this.spec.min;
    if (range <= 0) return 0;
    return (value - this.spec.min) / range;
  }

  /** Hovering or mid-drag: close enough to be looking for the number, not the name. */
  #peeking() {
    return this.hovering || this.dragging;
  }

  #render() {
    // The CSS clips the accent layer with `inset(var(--fill-top) 0 0 0)`, so this is how
    // much to hide from the top. Computed here rather than with calc() in the stylesheet
    // to keep the custom property a plain percentage that a test can read back.
    const hidden = (1 - this.#fraction()) * 100;
    this.element.style.setProperty('--fill-top', `${hidden.toFixed(2)}%`);
    this.element.setAttribute('aria-valuenow', String(this.value));
    this.element.setAttribute('aria-valuemin', String(this.spec.min));
    this.element.setAttribute('aria-valuemax', String(this.spec.max));
    const spoken = this.#format(this.value);
    this.element.setAttribute('aria-valuetext', spoken);
    this.labelEl.textContent = this.#peeking() ? spoken : this.caption;
  }

  /** Set from outside without firing onInput -- used to reflect external changes. */
  setValue(next) {
    this.value = quantize(next, this.spec.min, this.spec.max, this.spec.step);
    this.#render();
  }

  /**
   * The LFO's sweep, drawn as a line beside the glyph with a dot at the base
   * value it is centred on -- `range` is `{ lo, hi, base }` in this param's own
   * units, from modulation/modRange.js, or null to clear it when this control
   * stops being the target (or the depth drops to zero).
   *
   * Static: called only when the mapping, the depth, or the base value itself
   * changes, never on a timer -- there is no live phase to track here.
   */
  setModRange(range) {
    this.element.classList.toggle('has-mod-range', Boolean(range));
    if (!range) return;
    // Top offsets, not heights, since the line's own top edge is its high end --
    // the same inverted convention `--fill-top` already uses.
    const hiTop = (1 - this.#fractionOf(range.hi)) * 100;
    const loTop = (1 - this.#fractionOf(range.lo)) * 100;
    const baseTop = (1 - this.#fractionOf(range.base)) * 100;
    this.modRangeEl.style.top = `${hiTop.toFixed(2)}%`;
    this.modRangeEl.style.height = `${Math.max(0, loTop - hiTop).toFixed(2)}%`;
    this.modDotEl.style.top = `${baseTop.toFixed(2)}%`;
  }

  /**
   * Dim the control to show its value currently has no effect.
   *
   * Visual only, and deliberately not `aria-disabled`: the control works, and the value
   * it holds takes effect the moment whatever gates it is switched on.
   */
  setInactive(inactive) {
    this.element.classList.toggle('is-inactive', Boolean(inactive));
  }

  #commit(next) {
    const quantized = quantize(next, this.spec.min, this.spec.max, this.spec.step);
    if (quantized === this.value) return;
    this.value = quantized;
    this.#render();
    this.onInput(quantized);
  }

  #nudge(steps) {
    this.#commit(this.value + steps * this.spec.step);
  }

  #bind() {
    const el = this.element;

    bindDragAxis({
      element: el,
      onDragStart: () => {
        this.dragStartValue = this.value;
        this.dragging = true;
        this.#render();
      },
      onDragMove: (dy, shiftKey) => {
        // Up is positive, so the glyph fills in the direction the hand moves.
        this.#commit(dragDeltaValue(this.dragStartValue, dy, this.spec.max - this.spec.min, shiftKey));
      },
      onDragEnd: () => {
        this.dragging = false;
        this.#render();
      },
      onWheelNudge: (direction) => this.#nudge(direction),
      onDblClick: () => this.#commit(this.spec.def),
      onKeyNudge: (steps) => this.#nudge(steps),
      onHome: () => this.#commit(this.spec.min),
      onEnd: () => this.#commit(this.spec.max),
    });

    el.addEventListener('pointerenter', () => {
      this.hovering = true;
      this.#render();
    });
    el.addEventListener('pointerleave', () => {
      this.hovering = false;
      this.#render();
    });
  }
}
