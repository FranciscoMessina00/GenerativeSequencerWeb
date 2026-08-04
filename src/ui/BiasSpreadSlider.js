import { DragNumber, FINE_DIVISOR, FULL_RANGE_PX } from './DragNumber.js';
import { axisLockIcon } from './icons.js';
import { clamp, formatNumber, quantize } from './numberUtils.js';
import { midiNoteName } from './noteNames.js';

/** Smallest allowed gap between the axis's min and max, as a fraction of its hard range. */
const MIN_GAP_FRACTION = 0.02;

/**
 * Movement, in either direction from the press, before a locked drag commits to an
 * axis. Small enough to feel immediate, big enough to absorb the jitter a plain click
 * produces before any drag was intended.
 */
const AXIS_LOCK_THRESHOLD_PX = 4;

/**
 * One slider per bias/spread pair, driven by a single drag along two axes: the
 * handle's horizontal position is the bias -- jump-to-click, exactly where the
 * pointer lands -- and vertical travel from wherever the drag started is the
 * spread, the same delta-driven gesture DragNumber and FillIconControl use
 * elsewhere (shift for finer). One pointer gesture, two independent reads of it,
 * rather than a second input method (the wheel) for the second axis.
 *
 * A per-instance toggle can constrain a drag to whichever axis moves first --
 * see #bindTrack -- for fine-tuning one value without the other drifting.
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
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {number} [opts.trackId]
   * @param {object} opts.biasSpec    paramSchema entry for the handle position
   * @param {object} opts.spreadSpec  paramSchema entry for the vertical-drag band
   * @param {string} opts.title       heading, e.g. "Note"
   */
  constructor({ bus, trackId = 0, biasSpec, spreadSpec, title }) {
    this.bus = bus;
    this.trackId = trackId;
    this.biasSpec = biasSpec;
    this.spreadSpec = spreadSpec;
    this.title = title;
    this.dragging = false;
    // Pure interaction preference, not a sound parameter: no schema entry, no
    // param:change, not persisted across reload -- same treatment as `range` below.
    this.axisLocked = false;
    // Which axis a locked drag has committed to, decided once per gesture in
    // #bindTrack and cleared on release. Meaningless while axisLocked is false.
    this.activeAxis = null;

    this.bias = biasSpec.def;
    this.spread = spreadSpec.def;
    // Active range for the bias axis only -- spread has no range restriction of
    // its own, since there is no second track to attach range handles to.
    //
    // This bounds the *handle*, not the generator: values are still drawn around
    // the bias and clipped to the schema's range, so narrowing this does not
    // narrow what actually gets produced.
    this.range = { min: biasSpec.min, max: biasSpec.max };

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

    const heading = document.createElement('div');
    heading.className = 'bsslider__heading';
    heading.append(titleEl, this.#buildAxisToggle(title));

    this.readoutEl = document.createElement('span');
    this.readoutEl.className = 'bsslider__readout';
    header.append(heading, this.readoutEl);

    this.trackEl = document.createElement('div');
    this.trackEl.className = 'bsslider__track';
    this.trackEl.tabIndex = 0;
    this.trackEl.setAttribute('role', 'slider');
    this.trackEl.setAttribute('aria-label', `${title} pitch and spread`);
    // Two ids, because one element really does drive two parameters -- horizontal
    // drag sets bias, vertical sets spread. The footer shows both descriptions;
    // see ui/infoText.js.
    this.trackEl.dataset.info = `${this.biasSpec.key} ${this.spreadSpec.key}`;

    const rail = document.createElement('div');
    rail.className = 'bsslider__rail';
    this.bandEl = document.createElement('div');
    this.bandEl.className = 'bsslider__band';
    // The LFO's sweep along the bias axis, when this track is its target -- shifted
    // up clear of the rail/band/handle's shared lane, so a green sweep line and the
    // blue spread band never merge into one confusing bar. See setModRange().
    this.modRangeEl = document.createElement('div');
    this.modRangeEl.className = 'bsslider__modrange';
    this.handleEl = document.createElement('div');
    this.handleEl.className = 'bsslider__handle';
    this.trackEl.append(rail, this.bandEl, this.modRangeEl, this.handleEl);

    const minControl = this.#buildRangeControl('min');
    const maxControl = this.#buildRangeControl('max');
    this.rangeControls = { min: minControl, max: maxControl };

    const body = document.createElement('div');
    body.className = 'bsslider__body';
    body.append(minControl.element, this.trackEl, maxControl.element);

    root.append(header, body);
    this.element = root;
  }

  /**
   * The axis-lock toggle: free (both axes move together, the default) versus locked
   * (a drag commits to whichever axis moves first, see #bindTrack). Purely a click,
   * no drag of its own, so it lives in the header rather than on the track.
   */
  #buildAxisToggle(title) {
    this.axisToggleEl = document.createElement('button');
    this.axisToggleEl.type = 'button';
    this.axisToggleEl.className = 'bsslider__axis-toggle';
    this.axisToggleEl.setAttribute('aria-label', `${title}: constrain drag to one axis at a time`);
    // A hand-written id: this toggle is a view preference with no schema entry.
    this.axisToggleEl.dataset.info = 'axisLock';
    this.axisToggleEl.addEventListener('click', () => {
      this.axisLocked = !this.axisLocked;
      this.#renderAxisLock();
    });

    this.axisIconEl = document.createElement('span');
    this.axisToggleEl.appendChild(this.axisIconEl);
    this.#renderAxisLock();

    return this.axisToggleEl;
  }

  #renderAxisLock() {
    // No is-active button chrome here -- the icon's own arrow is the indicator (see
    // icons.js), so a second highlight on the button around it would be redundant.
    this.axisToggleEl.setAttribute('aria-pressed', String(this.axisLocked));
    this.axisIconEl.replaceChildren(axisLockIcon(this.axisLocked));
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

  /** The two schema keys this control owns. */
  keys() {
    return [this.biasSpec.key, this.spreadSpec.key];
  }

  /**
   * Reflect an externally-changed value without emitting, so applying a broadcast
   * cannot echo back onto the bus. Bias is also held inside the active range,
   * which the range handles may have narrowed since.
   */
  setValue(key, value) {
    if (key === this.biasSpec.key) {
      this.bias = clamp(
        quantize(value, this.biasSpec.min, this.biasSpec.max, this.biasSpec.step),
        this.range.min,
        this.range.max,
      );
    } else if (key === this.spreadSpec.key) {
      this.spread = quantize(value, this.spreadSpec.min, this.spreadSpec.max, this.spreadSpec.step);
    } else {
      return;
    }
    this.#updateVisuals();
  }

  /**
   * The LFO's sweep along the bias axis, when it is the target -- `range` is
   * `{ lo, hi }` in the bias param's own units, from modulation/modRange.js, or
   * null to clear it. A no-op for the spread key or any other key, matching
   * setValue's per-key check -- this control drives two params, but only bias
   * is ever mappable (see main.js's targetKeyOf).
   *
   * Positioned over `this.range`, the same denominator #updateVisuals() uses
   * for the band, so the line stays aligned with the handle even if the active
   * range has been narrowed.
   */
  setModRange(key, range) {
    if (key !== this.biasSpec.key) return;
    this.trackEl.classList.toggle('has-mod-range', Boolean(range));
    if (!range) return;
    const span = this.range.max - this.range.min;
    const loFrac = span > 0 ? clamp((range.lo - this.range.min) / span, 0, 1) : 0;
    const hiFrac = span > 0 ? clamp((range.hi - this.range.min) / span, 0, 1) : 0;
    this.modRangeEl.style.left = `${loFrac * 100}%`;
    this.modRangeEl.style.width = `${Math.max(0, hiFrac - loFrac) * 100}%`;
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

  #bindTrack() {
    const el = this.trackEl;

    const commitBiasFromPointer = (e) => {
      const rect = el.getBoundingClientRect();
      const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      this.#commitBias(this.range.min + frac * (this.range.max - this.range.min));
    };

    // Up is positive, matching DragNumber and FillIconControl's convention, and
    // relative to where the drag started rather than to the track's height --
    // spread's range varies per axis (0.9 for velocity, 40 for notes), so there
    // is no one pixel-to-range mapping a fixed-height track could offer both.
    const commitSpreadFromDelta = (e) => {
      const dy = this.dragStartY - e.clientY;
      let perPx = (this.spreadSpec.max - this.spreadSpec.min) / FULL_RANGE_PX;
      if (e.shiftKey) perPx /= FINE_DIVISOR;
      this.#commitSpread(this.dragStartSpread + dy * perPx);
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      el.classList.add('is-dragging');
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartSpread = this.spread;
      this.activeAxis = null;
      // Jump-to-click, so a drag can start anywhere on the track, not only exactly
      // on the handle -- but only when free. Locked defers this too: the whole
      // point of the lock is that a drag which turns out to be vertical must leave
      // bias untouched, including this initial jump.
      if (!this.axisLocked) commitBiasFromPointer(e);
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;

      if (!this.axisLocked) {
        commitBiasFromPointer(e);
        commitSpreadFromDelta(e);
        return;
      }

      if (this.activeAxis === null) {
        const dx = e.clientX - this.dragStartX;
        const dy = e.clientY - this.dragStartY;
        if (Math.abs(dx) < AXIS_LOCK_THRESHOLD_PX && Math.abs(dy) < AXIS_LOCK_THRESHOLD_PX) return;
        // Whichever moved further at the instant either crosses the threshold wins,
        // and that decision holds for the rest of this gesture -- it is not
        // reconsidered even if the hand wanders back the other way later.
        this.activeAxis = Math.abs(dx) >= Math.abs(dy) ? 'bias' : 'spread';
        // The cursor confirms the same choice: narrows from the ambiguous move
        // cursor to the one axis this drag now actually commits to.
        el.classList.toggle('is-axis-x', this.activeAxis === 'bias');
        el.classList.toggle('is-axis-y', this.activeAxis === 'spread');
      }

      if (this.activeAxis === 'bias') commitBiasFromPointer(e);
      else commitSpreadFromDelta(e);
    });

    const endDrag = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.activeAxis = null;
      el.classList.remove('is-dragging', 'is-axis-x', 'is-axis-y');
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

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
