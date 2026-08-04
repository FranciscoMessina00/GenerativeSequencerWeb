import { DragNumber } from './DragNumber.js';
import { svgEl } from './icons.js';
import { formatNumber } from './numberUtils.js';

/**
 * The two glide-mode glyphs: a straight 45deg line (linear), a quadratic curve
 * (exponential). Built here rather than in icons.js because they mean nothing outside
 * glide, the same way each control keeps its own value formatting.
 */
function buildModeIcon(exponential) {
  const svg = svgEl('svg', { viewBox: '0 0 12 12', class: 'glide-control__icon' });
  const shape = exponential
    ? svgEl('path', { d: 'M2 10 Q10 10 10 2', fill: 'none' })
    : svgEl('line', { x1: 2, y1: 10, x2: 10, y2: 2 });
  svg.appendChild(shape);
  return svg;
}

/**
 * Glide's control: a mode-toggle icon button next to a drag-number for the amount.
 * A click flips linear/exponential; dragging the number sets how much.
 *
 * Built specifically for glide rather than as a generic icon-toggle system, the
 * same way BiasSpreadSlider is built for bias/spread.
 */
export class GlideControl {
  /**
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {number} [opts.trackId]
   * @param {object} opts.amountSpec paramSchema entry for the unipolar amount
   * @param {object} opts.modeSpec   paramSchema entry for the mode toggle
   */
  constructor({ bus, trackId = 0, amountSpec, modeSpec }) {
    this.bus = bus;
    this.trackId = trackId;
    this.amountSpec = amountSpec;
    this.modeSpec = modeSpec;
    this.exponential = Boolean(modeSpec.def);

    const root = document.createElement('div');
    root.className = 'glide-control';

    this.modeButton = document.createElement('button');
    this.modeButton.type = 'button';
    this.modeButton.className = 'glide-control__mode';
    this.modeButton.setAttribute('aria-label', modeSpec.label);
    // The amount's drag-number tags itself; only the mode button needs it here.
    this.modeButton.dataset.info = modeSpec.key;
    this.modeButton.setAttribute('aria-pressed', String(this.exponential));
    this.modeButton.addEventListener('click', () => this.#toggleMode());
    this.#renderIcon();

    this.amountControl = new DragNumber({
      spec: amountSpec,
      format: (v) => amountSpec.display === 'percent'
        ? `${Math.round(v * 100)}%`
        : formatNumber(v, amountSpec.step),
      onInput: (v) => this.bus.emit('param:change', { trackId: this.trackId, key: amountSpec.key, value: v }),
    });
    this.amountControl.element.classList.add('dragnum--right', 'dragnum--label-first');

    root.append(this.amountControl.element, this.modeButton);
    this.element = root;
  }

  /** The two schema keys this control owns. */
  keys() {
    return [this.amountSpec.key, this.modeSpec.key];
  }

  /**
   * Reflect an externally-changed value without emitting, so applying a broadcast
   * cannot echo back onto the bus.
   */
  setValue(key, value) {
    if (key === this.amountSpec.key) {
      this.amountControl.setValue(value);
    } else if (key === this.modeSpec.key) {
      this.exponential = Boolean(value);
      this.modeButton.setAttribute('aria-pressed', String(this.exponential));
      this.#renderIcon();
    }
  }

  /** Point this control at a different track -- see main.js's selectTrack(). */
  setTrackId(trackId) {
    this.trackId = trackId;
  }

  #renderIcon() {
    this.modeButton.replaceChildren(buildModeIcon(this.exponential));
  }

  #toggleMode() {
    this.exponential = !this.exponential;
    this.modeButton.setAttribute('aria-pressed', String(this.exponential));
    this.#renderIcon();
    this.bus.emit('param:change', {
      trackId: this.trackId,
      key: this.modeSpec.key,
      value: this.exponential,
    });
  }
}
