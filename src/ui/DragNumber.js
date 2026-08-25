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

import {
  bindDragAxis, dragDeltaValue, expDragDeltaValue, FULL_RANGE_PX,
} from './dragGesture.js';
import { quantize } from './numberUtils.js';

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
    /** Set through setDisabled -- see there for what it does and does not stop. */
    this.disabled = false;
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

  /**
   * Grey it out and stop it changing, for a value the engine will not read.
   *
   * Opt-in: no caller that never calls this sees any difference. What it deliberately
   * does NOT do is take the element out of the pointer's reach -- hovering a greyed
   * control is how you find out why it is greyed, and the info footer needs a
   * `pointerover` to say so. See EnvelopePanel, which adds the reason to this
   * control's own `data-info` while it is disabled.
   *
   * The gestures are stopped at #commit rather than at each of the seven hooks
   * bindDragAxis calls: every one of them -- drag, wheel, arrows, double-click --
   * already funnels through it, so one guard covers the lot and cannot be forgotten
   * when a new gesture is added.
   */
  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    this.element.classList.toggle('dragnum--disabled', this.disabled);
    this.element.setAttribute('aria-disabled', String(this.disabled));
    // Out of the tab order, but still hoverable and still announced when read.
    this.element.tabIndex = this.disabled ? -1 : 0;
  }

  #commit(next) {
    if (this.disabled) return;
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
    bindDragAxis({
      element: this.element,
      onDragStart: () => {
        this.dragStartValue = this.value;
        if (this.values) this.dragStartIndex = this.#indexOfValue();
      },
      onDragMove: (dy, shiftKey) => {
        if (this.values) {
          // One full sweep walks the whole list, however many members it has, so the
          // travel per setting stays comfortable whether there are three or thirty.
          // No shift-fine here -- an index has no "finer" to walk toward.
          const perPx = (this.values.length - 1) / FULL_RANGE_PX;
          const index = Math.round(this.dragStartIndex + dy * perPx);
          this.#commit(this.values[Math.min(this.values.length - 1, Math.max(0, index))]);
          return;
        }
        // A param can ask for its travel to be bunched toward its low end -- see
        // dragGesture.js. Only the drag changes: the stored value, the readout, the
        // arrow keys and the wheel are all in the param's own units either way.
        this.#commit(this.spec.curve === 'exp'
          ? expDragDeltaValue(this.dragStartValue, dy, this.spec.min, this.spec.max, shiftKey)
          : dragDeltaValue(this.dragStartValue, dy, this.spec.max - this.spec.min, shiftKey));
      },
      onWheelNudge: (direction) => this.#nudge(direction),
      onDblClick: () => this.#commit(this.spec.def),
      onKeyNudge: (steps) => this.#nudge(steps),
      onHome: () => this.#commit(this.values ? this.values[0] : this.spec.min),
      onEnd: () => this.#commit(this.values ? this.values[this.values.length - 1] : this.spec.max),
    });
  }
}
