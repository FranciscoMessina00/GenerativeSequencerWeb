import { DragNumber } from './DragNumber.js';
import { clamp, formatNumber, quantize } from './numberUtils.js';
import { midiNoteName } from './noteNames.js';

/** Smallest allowed gap between the axis's min and max, as a fraction of its hard range. */
const MIN_GAP_FRACTION = 0.02;

/** Scroll distance spent per spread increment during a rapid wheel run. */
const WHEEL_NOTCH_PX = 50;

/**
 * A wheel event this long after the previous one applies a full notch
 * immediately, whatever its deltaY. Timing, not magnitude: some mice report a
 * click with a deltaY no bigger than one frame of trackpad momentum, so a
 * magnitude threshold either ignores real clicks or lets swipes through.
 */
const ISOLATED_EVENT_GAP_MS = 120;

/**
 * Plain-scroll increment for spread, per the axis's `display` kind. Velocity
 * spread lives on 0.1..1, where a literal 1 exceeds the whole range and every
 * notch would jump to an extreme.
 */
const WHEEL_COARSE_STEP = { percent: 0.01, semitones: 1 };

/**
 * One horizontal slider per bias/spread pair: the handle is the bias, drag moves
 * it, the wheel adjusts spread as a band spanning bias±spread beneath it.
 * Shift+scroll drops to the schema's own step.
 *
 * Spread reads as an attribute of the handle rather than a second axis because in
 * the narrow regime the generator draws `gauss(bias, spread)` -- the band is
 * literally where the next few values will land. That breaks in the wide/bimodal
 * regime, where bias is ignored entirely (see `distributions.js`) but the band
 * still draws at bias±spread. Flagged rather than fixed: drawing the true shape
 * means teaching this control which regime it is in.
 */
export class BiasSpreadSlider {
  /**
   * @param {object} opts.biasSpec    paramSchema entry for the handle position
   * @param {object} opts.spreadSpec  paramSchema entry for the wheel-adjusted band
   * @param {string} opts.title       heading, e.g. "Note"
   */
  constructor({ bus, trackId = 0, biasSpec, spreadSpec, title }) {
    this.bus = bus;
    this.trackId = trackId;
    this.biasSpec = biasSpec;
    this.spreadSpec = spreadSpec;
    this.title = title;
    this.dragging = false;

    this.bias = biasSpec.def;
    this.spread = spreadSpec.def;
    // Active range for the bias axis only -- spread has no range restriction of
    // its own, since there is no second track to attach range handles to.
    //
    // This bounds the *handle*, not the generator: values are still drawn around
    // the bias and clipped to the schema's range, so narrowing this does not
    // narrow what actually gets produced.
    this.range = { min: biasSpec.min, max: biasSpec.max };
    // Sub-notch scroll distance not yet converted into a spread change; see
    // WHEEL_NOTCH_PX.
    this.wheelAccum = 0;
    // -Infinity so the very first wheel event is always treated as isolated --
    // it cannot be a continuation of a run that hasn't started yet.
    this.lastWheelTime = -Infinity;

    this.#build(title);
    this.#bindTrack();
    this.#updateVisuals();
  }

  #build(title) {
    const root = document.createElement('div');
    root.className = 'bsslider';

    const header = document.createElement('div');
    header.className = 'bsslider__header';
    const titleEl = document.createElement('span');
    titleEl.className = 'bsslider__title';
    titleEl.textContent = title;
    this.readoutEl = document.createElement('span');
    this.readoutEl.className = 'bsslider__readout';
    header.append(titleEl, this.readoutEl);

    this.trackEl = document.createElement('div');
    this.trackEl.className = 'bsslider__track';
    this.trackEl.tabIndex = 0;
    this.trackEl.setAttribute('role', 'slider');
    this.trackEl.setAttribute('aria-label', `${title} pitch and spread`);

    const rail = document.createElement('div');
    rail.className = 'bsslider__rail';
    this.bandEl = document.createElement('div');
    this.bandEl.className = 'bsslider__band';
    this.handleEl = document.createElement('div');
    this.handleEl.className = 'bsslider__handle';
    this.trackEl.append(rail, this.bandEl, this.handleEl);

    const minControl = this.#buildRangeControl('min');
    const maxControl = this.#buildRangeControl('max');
    this.rangeControls = { min: minControl, max: maxControl };

    const body = document.createElement('div');
    body.className = 'bsslider__body';
    body.append(minControl.element, this.trackEl, maxControl.element);

    root.append(header, body);
    this.element = root;
  }

  /** One edge of the active bias range: a compact DragNumber flanking the track. */
  #buildRangeControl(edge) {
    const spec = this.biasSpec;
    const pseudoSpec = {
      key: `${spec.key}.${edge}`,
      label: `${this.title} ${edge}`,
      short: edge,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      def: this.range[edge],
    };
    const control = new DragNumber({
      spec: pseudoSpec,
      format: (v) => this.#formatAxis(spec, v),
      onInput: (v) => this.#setRange(edge, v),
    });
    control.element.classList.add('dragnum--compact', 'bsslider__range');
    return control;
  }

  /**
   * Render a bias/spread axis value per its schema's `display` kind, so one
   * declarative place decides how a param reads wherever it's rendered. Axes with
   * no `display` (pluck position) fall through to the plain numeric format.
   */
  #formatAxis(spec, value) {
    if (spec.display === 'note') return midiNoteName(value);
    if (spec.display === 'semitones') return `${Math.round(value)} st`;
    if (spec.display === 'percent') return `${Math.round(value * 100)}%`;
    return formatNumber(value, spec.step);
  }

  /** Update one end of the active bias range, reconciling the current value. */
  #setRange(edge, rawValue) {
    const spec = this.biasSpec;
    const gap = Math.max(spec.step, (spec.max - spec.min) * MIN_GAP_FRACTION);

    let next = quantize(rawValue, spec.min, spec.max, spec.step);
    // The endpoints constrain each other, so min can't be dragged past max.
    if (edge === 'min') next = Math.min(next, this.range.max - gap);
    else next = Math.max(next, this.range.min + gap);
    next = clamp(next, spec.min, spec.max);

    this.range[edge] = next;
    // The gap may have overridden the drag-number's own value; resync its readout.
    this.rangeControls[edge].setValue(next);

    // Narrowing the range can strand the current bias outside it.
    const clampedBias = clamp(this.bias, this.range.min, this.range.max);
    const changed = clampedBias !== this.bias;
    this.bias = clampedBias;
    if (changed) this.#emitBias();

    this.#updateVisuals();
  }

  #emitBias() {
    this.bus.emit('param:change', { trackId: this.trackId, key: this.biasSpec.key, value: this.bias });
  }

  #emitSpread() {
    this.bus.emit('param:change', { trackId: this.trackId, key: this.spreadSpec.key, value: this.spread });
  }

  #commitBias(rawValue) {
    const bounded = clamp(rawValue, this.range.min, this.range.max);
    const quantized = quantize(bounded, this.biasSpec.min, this.biasSpec.max, this.biasSpec.step);
    if (quantized === this.bias) return;
    this.bias = quantized;
    this.#updateVisuals();
    this.#emitBias();
  }

  #commitSpread(rawValue) {
    const quantized = quantize(rawValue, this.spreadSpec.min, this.spreadSpec.max, this.spreadSpec.step);
    if (quantized === this.spread) return;
    this.spread = quantized;
    this.#updateVisuals();
    this.#emitSpread();
  }

  #updateVisuals() {
    const span = this.range.max - this.range.min;
    const biasFrac = span > 0 ? clamp((this.bias - this.range.min) / span, 0, 1) : 0;
    this.handleEl.style.left = `${biasFrac * 100}%`;

    // Clamped to the handle's own range, so the band can't spill past the track.
    const lo = clamp(this.bias - this.spread, this.range.min, this.range.max);
    const hi = clamp(this.bias + this.spread, this.range.min, this.range.max);
    const loFrac = span > 0 ? clamp((lo - this.range.min) / span, 0, 1) : 0;
    const hiFrac = span > 0 ? clamp((hi - this.range.min) / span, 0, 1) : 0;
    this.bandEl.style.left = `${loFrac * 100}%`;
    this.bandEl.style.width = `${Math.max(0, hiFrac - loFrac) * 100}%`;

    const biasText = this.#formatAxis(this.biasSpec, this.bias);
    const spreadText = this.#formatAxis(this.spreadSpec, this.spread);
    this.readoutEl.textContent = `${biasText} ± ${spreadText}`;
    this.trackEl.setAttribute('aria-valuenow', String(this.bias));
    this.trackEl.setAttribute('aria-valuemin', String(this.range.min));
    this.trackEl.setAttribute('aria-valuemax', String(this.range.max));
    this.trackEl.setAttribute('aria-valuetext', `${biasText}, spread ${spreadText}`);
  }

  /**
   * Scale deltaY onto the pixel axis WHEEL_NOTCH_PX is calibrated against. Most
   * browsers report pixels; Firefox and some configurations report LINE or PAGE
   * units instead, which are much smaller and need scaling up to match.
   */
  #normalizeWheelDelta(e) {
    if (e.deltaMode === 1) return e.deltaY * 16; // DOM_DELTA_LINE
    if (e.deltaMode === 2) return e.deltaY * 800; // DOM_DELTA_PAGE
    return e.deltaY; // DOM_DELTA_PIXEL
  }

  #bindTrack() {
    const el = this.trackEl;

    const commitFromPointer = (e) => {
      const rect = el.getBoundingClientRect();
      const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      this.#commitBias(this.range.min + frac * (this.range.max - this.range.min));
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      el.classList.add('is-dragging');
      // Jump-to-click, so a drag can start anywhere on the track, not only
      // exactly on the handle.
      commitFromPointer(e);
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      commitFromPointer(e);
    });

    const endDrag = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      el.classList.remove('is-dragging');
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();

      // Plain scroll moves by a coarse step sized to the axis's own display
      // (see WHEEL_COARSE_STEP); shift switches to the schema's own step for
      // the finer adjustments the coarse one is too big for.
      const coarse = WHEEL_COARSE_STEP[this.spreadSpec.display] ?? 1;
      const increment = e.shiftKey ? this.spreadSpec.step : coarse;

      const isolated = e.timeStamp - this.lastWheelTime > ISOLATED_EVENT_GAP_MS;
      this.lastWheelTime = e.timeStamp;

      if (isolated) {
        // Respond immediately, and drop any accumulated distance so it can't leak
        // across the gap into this gesture.
        this.wheelAccum = 0;
        const dir = e.deltaY < 0 ? 1 : -1;
        this.#commitSpread(this.spread + dir * increment);
        return;
      }

      // Part of a rapid run: accumulate distance and spend it only in whole
      // notches, so many small events don't each apply a full increment.
      this.wheelAccum += this.#normalizeWheelDelta(e);
      const notches = Math.trunc(this.wheelAccum / WHEEL_NOTCH_PX);
      if (notches === 0) return;
      this.wheelAccum -= notches * WHEEL_NOTCH_PX;
      this.#commitSpread(this.spread - notches * increment);
    }, { passive: false });

    el.addEventListener('dblclick', () => {
      this.#commitBias(this.biasSpec.def);
      this.#commitSpread(this.spreadSpec.def);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); this.#commitBias(this.bias + this.biasSpec.step); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.#commitBias(this.bias - this.biasSpec.step); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.#commitSpread(this.spread + this.spreadSpec.step); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.#commitSpread(this.spread - this.spreadSpec.step); }
    });
  }
}
