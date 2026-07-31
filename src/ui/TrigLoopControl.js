import { DragNumber } from './DragNumber.js';
import { FillIconControl } from './FillIconControl.js';
import { crossArrowsIcon, loopIcon } from './icons.js';
import { formatNumber } from './numberUtils.js';

/**
 * The rhythm loop: capture it, set how long it is, reorder it.
 *
 * One control for three parameters because they are one mechanism. Rendered as three
 * separate slider rows they read as unrelated knobs, when in truth the length only means
 * something once the loop is on and the permutation only means something once there is a
 * loop to permute.
 *
 *   loop glyph   captures the last N random bits and repeats them instead of rolling new
 *   number       N, the loop's length in steps
 *   crossed      reorders that loop, scaled by its factorial -- see permutationIndex()
 *
 * Owning all three is also what keeps the permutation's dimming internal: it follows the
 * toggle's state directly instead of needing a special case in the wiring.
 */
export class TrigLoopControl {
  /**
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {number} [opts.trackId]
   * @param {object} opts.enabledSpec paramSchema entry for the loop toggle
   * @param {object} opts.lengthSpec  paramSchema entry for the loop length
   * @param {object} opts.permSpec    paramSchema entry for the permutation
   */
  constructor({ bus, trackId = 0, enabledSpec, lengthSpec, permSpec }) {
    this.bus = bus;
    this.trackId = trackId;
    this.enabledSpec = enabledSpec;
    this.lengthSpec = lengthSpec;
    this.permSpec = permSpec;
    this.enabled = Boolean(enabledSpec.def);

    // Captioned like the glyphs either side of it, rather than left bare. Without its own
    // caption the length's "LEN" ends up looking like the toggle's label, and the row
    // stops reading as four separate controls.
    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'trig-loop__toggle';
    this.toggleButton.setAttribute('aria-label', enabledSpec.label);
    const toggleCaption = document.createElement('span');
    toggleCaption.className = 'trig-loop__label';
    toggleCaption.textContent = 'Loop';
    this.toggleButton.append(loopIcon(), toggleCaption);
    this.toggleButton.addEventListener('click', () => this.#toggle());

    this.lengthControl = new DragNumber({
      spec: lengthSpec,
      format: (v) => formatNumber(v, lengthSpec.step),
      onInput: (v) => this.#emit(lengthSpec.key, v),
    });

    this.permControl = new FillIconControl({
      spec: permSpec,
      buildIcon: crossArrowsIcon,
      label: 'Perm',
      onInput: (v) => this.#emit(permSpec.key, v),
    });

    const root = document.createElement('div');
    root.className = 'trig-loop';
    root.append(this.toggleButton, this.lengthControl.element, this.permControl.element);
    this.element = root;

    this.#renderLoopState();
  }

  /** The three schema keys this control owns. */
  keys() {
    return [this.enabledSpec.key, this.lengthSpec.key, this.permSpec.key];
  }

  /**
   * Reflect an externally-changed value without emitting, so applying a broadcast
   * cannot echo back onto the bus.
   */
  setValue(key, value) {
    if (key === this.enabledSpec.key) {
      this.enabled = Boolean(value);
      this.#renderLoopState();
    } else if (key === this.lengthSpec.key) {
      this.lengthControl.setValue(value);
    } else if (key === this.permSpec.key) {
      this.permControl.setValue(value);
    }
  }

  /**
   * The single place the toggle's state reaches the DOM, called from the constructor, the
   * click handler and setValue alike -- so a loaded patch lands in exactly the state a
   * click would have produced.
   *
   * Permutation is scaled by the loop's factorial, so with the loop off it has no effect
   * whatsoever. Dimming says that without disabling it: the value is kept, and it starts
   * mattering the moment the loop comes on.
   */
  #renderLoopState() {
    this.toggleButton.classList.toggle('is-active', this.enabled);
    this.toggleButton.setAttribute('aria-pressed', String(this.enabled));
    this.permControl.setInactive(!this.enabled);
  }

  #toggle() {
    this.enabled = !this.enabled;
    this.#renderLoopState();
    this.#emit(this.enabledSpec.key, this.enabled);
  }

  #emit(key, value) {
    this.bus.emit('param:change', { trackId: this.trackId, key, value });
  }
}
