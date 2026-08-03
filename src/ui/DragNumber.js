/**
 * A label-plus-number control changed by dragging vertically. Takes only as much
 * room as its text and draws resolution from pointer travel rather than layout
 * width, which is what lets it live inside the step ring.
 *
 *   drag up/down   coarse change, full range over ~180 px
 *   shift + drag   eight times finer, for the fractional params
 *   wheel          one step per notch
 *   arrows         one step; page up/down ten; home/end to the extremes
 *   double click   back to the schema default
 *
 * The pointer is captured on press so the drag survives leaving the element --
 * necessary because it is small and sits inside a circle.
 */

import { quantize } from './numberUtils.js';

/**
 * Travel, in pixels, for one full sweep of the parameter's range.
 *
 * Exported because FillIconControl drags the same way. Two drag controls on one panel
 * that answered differently to the same hand movement would feel like a bug, so they
 * share the constant rather than each declaring 180.
 */
export const FULL_RANGE_PX = 180;
export const FINE_DIVISOR = 8;

export class DragNumber {
  /**
   * @param {object} opts
   * @param {object} opts.spec     entry from paramSchema
   * @param {(value: number) => string} opts.format
   * @param {(value: number) => void} opts.onInput
   * @param {(value: number) => string} [opts.describe] spoken form for aria-valuetext;
   *   defaults to `format`, and worth passing where the visible text drops the unit
   */
  constructor({ spec, format, onInput, describe }) {
    this.spec = spec;
    this.format = format;
    this.describe = describe ?? format;
    this.onInput = onInput;
    this.value = spec.def;
    /**
     * Enumerated params are walked by index rather than stepped by value: their
     * members are not evenly spaced, so adding `spec.step` would land between two of
     * them and snap ambiguously (from 1/8, +1 would sit exactly between 8 and 16).
     */
    this.values = spec.values ?? null;

    this.element = document.createElement('div');
    this.element.className = 'dragnum';
    this.element.tabIndex = 0;
    // Announced as a slider because that is what it behaves like, even though it
    // is not rendered as one.
    this.element.setAttribute('role', 'slider');
    this.element.setAttribute('aria-label', spec.label);
    // Names this control's description for the info footer -- see ui/infoText.js.
    // Set here rather than by every caller, which covers all nine instances at
    // once, including the ones nested inside other widgets.
    this.element.dataset.info = spec.key;

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'dragnum__label';
    this.labelEl.textContent = spec.short ?? spec.label;

    this.valueEl = document.createElement('span');
    this.valueEl.className = 'dragnum__value';

    this.element.append(this.valueEl, this.labelEl);
    this.#render();
    this.#bind();
  }

  #quantize(raw) {
    if (this.values) return this.#nearest(raw);
    return quantize(raw, this.spec.min, this.spec.max, this.spec.step);
  }

  /** Closest member of an enumerated list; ties resolve downward. */
  #nearest(raw) {
    let best = this.values[0];
    let bestDistance = Infinity;
    for (const candidate of this.values) {
      const distance = Math.abs(candidate - raw);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  #indexOfValue() {
    const index = this.values.indexOf(this.value);
    return index === -1 ? this.values.indexOf(this.#nearest(this.value)) : index;
  }

  #render() {
    this.valueEl.textContent = this.format(this.value);
    this.element.setAttribute('aria-valuenow', String(this.value));
    this.element.setAttribute('aria-valuemin', String(this.spec.min));
    this.element.setAttribute('aria-valuemax', String(this.spec.max));
    this.element.setAttribute('aria-valuetext', this.describe(this.value));
  }

  /** Set from outside without firing onInput -- used to reflect external changes. */
  setValue(next) {
    this.value = this.#quantize(next);
    this.#render();
  }

  #commit(next) {
    const quantized = this.#quantize(next);
    if (quantized === this.value) return;
    this.value = quantized;
    this.#render();
    this.onInput(quantized);
  }

  #nudge(steps) {
    if (this.values) {
      const next = this.#indexOfValue() + steps;
      this.#commit(this.values[Math.min(this.values.length - 1, Math.max(0, next))]);
      return;
    }
    this.#commit(this.value + steps * this.spec.step);
  }

  #bind() {
    const el = this.element;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-dragging');
      this.dragStartY = e.clientY;
      this.dragStartValue = this.value;
      if (this.values) this.dragStartIndex = this.#indexOfValue();
    });

    el.addEventListener('pointermove', (e) => {
      if (this.dragStartY === undefined) return;
      // Up is positive: dragging toward the top of the screen raises the value.
      const dy = this.dragStartY - e.clientY;

      if (this.values) {
        // One full sweep walks the whole list, however many members it has, so the
        // travel per setting stays comfortable whether there are three or thirty.
        const perPx = (this.values.length - 1) / FULL_RANGE_PX;
        const index = Math.round(this.dragStartIndex + dy * perPx);
        this.#commit(this.values[Math.min(this.values.length - 1, Math.max(0, index))]);
        return;
      }

      const range = this.spec.max - this.spec.min;
      let perPx = range / FULL_RANGE_PX;
      if (e.shiftKey) perPx /= FINE_DIVISOR;
      this.#commit(this.dragStartValue + dy * perPx);
    });

    const end = (e) => {
      if (this.dragStartY === undefined) return;
      this.dragStartY = undefined;
      el.classList.remove('is-dragging');
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.#nudge(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    el.addEventListener('dblclick', () => this.#commit(this.spec.def));

    el.addEventListener('keydown', (e) => {
      const map = {
        ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1,
        PageUp: 10, PageDown: -10,
      };
      if (e.key in map) {
        e.preventDefault();
        this.#nudge(map[e.key]);
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.#commit(this.values ? this.values[0] : this.spec.min);
      } else if (e.key === 'End') {
        e.preventDefault();
        this.#commit(this.values ? this.values[this.values.length - 1] : this.spec.max);
      }
    });
  }
}
