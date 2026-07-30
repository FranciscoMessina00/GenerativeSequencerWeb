import { DragNumber } from './DragNumber.js';
import { clamp, formatNumber, quantize } from './numberUtils.js';
import { midiNoteName } from './noteNames.js';

/** Smallest allowed gap between the axis's min and max, as a fraction of its hard range. */
const MIN_GAP_FRACTION = 0.02;

/**
 * Distance accumulated during a run of rapid-fire wheel events (a trackpad
 * swipe, or a fast-spun mouse wheel) is spent in units of this size. See
 * ISOLATED_EVENT_GAP_MS for why this only applies to rapid runs, not to a
 * single click.
 */
const WHEEL_NOTCH_PX = 50;

/**
 * A wheel event arriving at least this long after the previous one is treated
 * as a fresh, isolated interaction -- almost certainly one deliberate mouse
 * click -- and applies a full notch immediately, regardless of how large or
 * small its own deltaY happens to be.
 *
 * Distinguishing "one mouse click" from "one trackpad swipe" by event
 * *magnitude* alone doesn't work: some mice report a single click with a small
 * deltaY, no bigger than a single frame of trackpad momentum, so a fixed
 * magnitude threshold either ignores real clicks (if set high) or lets
 * trackpad swipes right back through (if set low to compensate). Timing is the
 * reliable signal instead -- a swipe or a fast-spun wheel fires events roughly
 * every animation frame (well under 50ms apart); an isolated click, even
 * clicked repeatedly at a brisk pace, is still spaced much further apart than
 * that.
 */
const ISOLATED_EVENT_GAP_MS = 120;

/**
 * Plain-scroll (no shift) increment for spread, keyed by the axis's `display`
 * kind. A literal "1" is the right coarse step for note spread (whole
 * semitones, range 0..40) and works fine as a default for an axis with no
 * particular display (pluck position, range 0.1..20) -- but velocity spread
 * lives on 0.1..1, where "1" is bigger than the entire range and every plain
 * scroll notch jumped straight to an extreme. 0.05 (5 percentage points) gives
 * velocity about the same number of notches to sweep its range as note gets
 * for its much wider one.
 */
const WHEEL_COARSE_STEP = { percent: 0.01, semitones: 1 };

/**
 * A single horizontal slider for one bias/spread pair: the handle is the bias
 * (e.g. pitch), horizontal drag moves it, and the mouse wheel adjusts spread --
 * shown as a highlighted band spanning bias-spread..bias+spread under the
 * handle rather than as a second axis. Plain scroll moves spread by whole
 * units; shift+scroll drops to the schema's own step for fine adjustment.
 *
 * Replaces an earlier 2D XY-pad design for the same three pairs (note,
 * velocity, pluck position). The pad made bias and spread two independent
 * draggable axes; this instead treats spread as an *attribute of the bias
 * handle* -- which is closer to what it actually is. In the narrow-spread
 * regime (see `distributions.js`), the generator draws
 * `gauss(bias, spread)`, so the band literally shows the one-standard-deviation
 * range the next few notes are likely to land in. That correspondence breaks
 * down once spread crosses into the wide/bimodal regime (bias is ignored
 * there entirely, see `distributions.js`'s `wide` functions) -- the band still
 * draws at bias +/- spread in that regime, which is no longer what the
 * generator is actually doing. Flagged here rather than solved: drawing the
 * wide regime's true bimodal shape would need this control to know which
 * regime it's in, which is a bigger change than was asked for.
 *
 * Two independent gestures rather than one, deliberately: a single 2D drag
 * would have to decide whether a diagonal movement meant "mostly bias" or
 * "mostly spread", which is exactly the ambiguity a wheel-for-the-second-axis
 * split avoids.
 */
export class BiasSpreadSlider {
  /**
   * @param {object} opts
   * @param {EventBus} opts.bus
   * @param {number} [opts.trackId]
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
   * Render a bias/spread axis value per its schema's `display` kind.
   *
   * `display` lives on the paramSchema entry rather than being passed in
   * separately, matching how UIController already resolves 'logic'/'scale'
   * displays -- one declarative place decides how a param reads, wherever it's
   * rendered. Falls through to the plain numeric format for axes (pluck
   * position) that don't set one.
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
    // The two endpoints constrain each other rather than the hard schema
    // bounds, which is what keeps min from being dragged past max.
    if (edge === 'min') next = Math.min(next, this.range.max - gap);
    else next = Math.max(next, this.range.min + gap);
    next = clamp(next, spec.min, spec.max);

    this.range[edge] = next;
    // The gap constraint may have overridden what the drag-number itself
    // computed -- resync its own readout.
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

    // The band is bias +/- spread, clamped to the same active range the handle
    // moves within -- it can never visually spill past the track.
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
   * Scale deltaY onto the same pixel-ish axis WHEEL_NOTCH_PX assumes.
   *
   * `deltaMode` is 0 (pixel) for virtually all wheel and trackpad input on
   * Chrome/Safari/macOS, which is what WHEEL_NOTCH_PX is calibrated against.
   * Firefox, and some non-default configurations elsewhere, can report LINE or
   * PAGE mode instead, with deltaY in much smaller units -- scaled up here so
   * the same threshold means roughly the same physical scroll distance there.
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
        // A standalone event -- treat it as one deliberate click and respond
        // immediately, whatever its own deltaY magnitude happens to be. Reset
        // the accumulator so it doesn't carry stale distance from before a gap
        // into whatever comes next.
        this.wheelAccum = 0;
        const dir = e.deltaY < 0 ? 1 : -1;
        this.#commitSpread(this.spread + dir * increment);
        return;
      }

      // Part of a rapid run (trackpad swipe or fast-spun wheel): accumulate
      // distance and only spend it in whole notches, so many small events
      // don't each apply a full increment on their own -- see WHEEL_NOTCH_PX.
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
