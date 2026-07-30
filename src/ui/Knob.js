import { formatNumber, quantize } from './numberUtils.js';

/** Rotational travel, in degrees from centre, matching the standard hardware-knob convention. */
const MIN_ANGLE = -135;
const MAX_ANGLE = 135;

/** Vertical drag distance, in pixels, for one full sweep end-to-end. */
const FULL_RANGE_PX = 150;
const FINE_DIVISOR = 8;

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  // 0deg = straight up, positive = clockwise -- the same convention a clock face uses.
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  if (startAngle === endAngle) return '';
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  const sweep = endAngle > startAngle ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
}

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * A minimal rotary knob: one arc trail, one small circle marking where the
 * current value sits on it -- the same track-plus-handle language a linear
 * slider already uses, just bent into an arc instead of a straight line.
 *
 * Deliberately generic rather than built for any one control. It was first
 * built as a glide-specific bipolar knob with a colored fill arc, a radial
 * pointer and fixed linear/exponential icons; glide went back to being a
 * plain slider (see paramSchema.js's `icons` field and
 * UIController#buildControl), and this component was stripped down to a
 * reusable building block for whatever needs a compact rotary control next,
 * rather than deleted.
 *
 * `bipolar` is the one remaining trace of that history: when true, a small
 * tick marks the trail at value 0 as a fixed reference point; when false, no
 * such reference is drawn, since a unipolar range has no meaningful centre.
 * Nothing currently constructs this with `bipolar: false` -- it exists so the
 * next caller can, without this file changing again.
 *
 * Dragging is vertical, not literally circular -- a mouse can't trace an arc
 * naturally, and every other drag-based control in this app (DragNumber,
 * BiasSpreadSlider) already uses vertical drag for its value, so this matches
 * that established feel rather than introducing a new one.
 */
export class Knob {
  /**
   * @param {object} opts
   * @param {object} opts.spec          paramSchema entry
   * @param {boolean} [opts.bipolar]    draws a centre-tick at value 0 when true (default true)
   * @param {boolean} [opts.showLabel]  default true
   * @param {boolean} [opts.showValue]  default true
   * @param {'top'|'bottom'} [opts.labelPosition] defaults to 'top'
   * @param {Function} [opts.format]    (value) => display string, defaults to a plain number
   * @param {Function} opts.onInput     (value) => void
   */
  constructor({
    spec,
    bipolar = true,
    showLabel = true,
    showValue = true,
    labelPosition = 'top',
    format,
    onInput,
  }) {
    this.spec = spec;
    this.bipolar = bipolar;
    this.onInput = onInput;
    this.format = format ?? ((v) => formatNumber(v, spec.step));
    this.value = spec.def;
    this.dragStartY = undefined;

    this.#build(showLabel, showValue, labelPosition);
    this.#bind();
    this.#render();
  }

  #valueToAngle(v) {
    const t = (v - this.spec.min) / (this.spec.max - this.spec.min);
    return MIN_ANGLE + t * (MAX_ANGLE - MIN_ANGLE);
  }

  #build(showLabel, showValue, labelPosition) {
    const root = document.createElement('div');
    root.className = 'knob';
    root.tabIndex = 0;
    root.setAttribute('role', 'slider');
    root.setAttribute('aria-label', this.spec.label);
    root.setAttribute('aria-valuemin', String(this.spec.min));
    root.setAttribute('aria-valuemax', String(this.spec.max));

    const svg = svgEl('svg', { viewBox: '0 0 100 100', class: 'knob__face' });
    this.trackPath = svgEl('path', { class: 'knob__track' });
    svg.append(this.trackPath);

    if (this.bipolar) {
      this.centerTick = svgEl('circle', { class: 'knob__center-tick', r: 2 });
      svg.append(this.centerTick);
    }

    this.handle = svgEl('circle', { class: 'knob__handle', r: 5 });
    svg.append(this.handle);
    this.faceWrap = svg;

    this.labelEl = showLabel ? document.createElement('span') : null;
    if (this.labelEl) {
      this.labelEl.className = 'knob__label';
      this.labelEl.textContent = this.spec.short ?? this.spec.label;
    }

    this.valueEl = showValue ? document.createElement('span') : null;
    if (this.valueEl) this.valueEl.className = 'knob__value';

    const middle = [this.labelEl, svg, this.valueEl].filter(Boolean);
    const children = labelPosition === 'bottom'
      ? [svg, this.valueEl, this.labelEl].filter(Boolean)
      : middle;
    root.append(...children);

    this.element = root;
  }

  #render() {
    const angle = this.#valueToAngle(this.value);

    this.trackPath.setAttribute('d', describeArc(50, 50, 38, MIN_ANGLE, MAX_ANGLE));

    if (this.centerTick) {
      const zero = polarToCartesian(50, 50, 38, this.#valueToAngle(0));
      this.centerTick.setAttribute('cx', zero.x);
      this.centerTick.setAttribute('cy', zero.y);
    }

    const pos = polarToCartesian(50, 50, 38, angle);
    this.handle.setAttribute('cx', pos.x);
    this.handle.setAttribute('cy', pos.y);

    if (this.valueEl) this.valueEl.textContent = this.format(this.value);
    this.element.setAttribute('aria-valuenow', String(this.value));
  }

  /** Set from outside without firing onInput -- for reflecting external changes. */
  setValue(next) {
    this.value = quantize(next, this.spec.min, this.spec.max, this.spec.step);
    this.#render();
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
      const dy = this.dragStartY - e.clientY;
      const range = this.spec.max - this.spec.min;
      let perPx = range / FULL_RANGE_PX;
      if (e.shiftKey) perPx /= FINE_DIVISOR;
      this.#commit(this.dragStartValue + dy * perPx);
    });

    const endDrag = (e) => {
      if (this.dragStartY === undefined) return;
      this.dragStartY = undefined;
      el.classList.remove('is-dragging');
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.#nudge(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    el.addEventListener('dblclick', () => this.#commit(this.spec.def));

    el.addEventListener('keydown', (e) => {
      const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
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
