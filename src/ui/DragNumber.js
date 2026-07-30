/**
 * A label-plus-number control that you change by dragging vertically.
 *
 * Sliders need horizontal room and their travel is fixed by their width, which
 * makes them a poor fit for the inside of the step ring: the space there is
 * circular and tight, and steps/pulses/rotation want precise integer nudges more
 * than they want a broad sweep. A drag-number takes only as much room as its text
 * and gets its resolution from pointer travel instead of layout width.
 *
 * Interaction, in order of how much it is likely to be used:
 *   drag up/down   coarse change, full range over ~180 px
 *   shift + drag   eight times finer, for the fractional params
 *   wheel          one step per notch
 *   arrows         one step; page up/down ten; home/end to the extremes
 *   double click   back to the schema default
 *
 * The pointer is captured on press, so the drag keeps working when it leaves the
 * element -- necessary here because the element is small and sits inside a circle.
 */

function decimalsFor(step) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Travel, in pixels, for one full sweep of the parameter's range. */
const FULL_RANGE_PX = 180;
const FINE_DIVISOR = 8;

export class DragNumber {
  /**
   * @param {object} opts
   * @param {object} opts.spec    entry from paramSchema
   * @param {Function} opts.format (value) => display string
   * @param {Function} opts.onInput (value) => void
   */
  constructor({ spec, format, onInput }) {
    this.spec = spec;
    this.format = format;
    this.onInput = onInput;
    this.decimals = decimalsFor(spec.step);
    this.value = spec.def;

    this.element = document.createElement('div');
    this.element.className = 'dragnum';
    this.element.tabIndex = 0;
    // Announced as a slider because that is what it behaves like, even though it
    // is not rendered as one.
    this.element.setAttribute('role', 'slider');
    this.element.setAttribute('aria-label', spec.label);

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
    const { min, max, step } = this.spec;
    const snapped = Math.round(raw / step) * step;
    const clamped = Math.min(max, Math.max(min, snapped));
    // Snapping by multiplication leaves float dust (0.30000000000000004), which
    // would show up directly in the readout.
    return Number(clamped.toFixed(this.decimals));
  }

  #render() {
    this.valueEl.textContent = this.format(this.value);
    this.element.setAttribute('aria-valuenow', String(this.value));
    this.element.setAttribute('aria-valuemin', String(this.spec.min));
    this.element.setAttribute('aria-valuemax', String(this.spec.max));
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
    });

    el.addEventListener('pointermove', (e) => {
      if (this.dragStartY === undefined) return;
      // Up is positive: dragging toward the top of the screen raises the value.
      const dy = this.dragStartY - e.clientY;
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
        this.#commit(this.spec.min);
      } else if (e.key === 'End') {
        e.preventDefault();
        this.#commit(this.spec.max);
      }
    });
  }
}
