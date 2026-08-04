import { DragNumber } from './DragNumber.js';
import {
  STEP_MOD_DOTTED,
  STEP_MOD_STRAIGHT,
  STEP_MOD_TRIPLET,
  noteValueDescription,
  noteValueLabel,
} from '../sequencer/stepDivision.js';

/**
 * The step division: a drag-number for the note value, with T and D beside it for triplet
 * and dotted.
 *
 * Both letters drive one tri-state `stepMod` rather than a flag each. Clicking a lit
 * letter returns to straight, so the three states are reachable with two buttons and
 * "both lit" cannot happen -- which matters because triplet and dotted together cancel
 * out exactly (x2/3 * x3/2 = x1), so it would be a state that looks meaningful and
 * sounds like neither.
 *
 * Built specifically for this rather than as a generic multi-toggle, the same way
 * GlideControl is built for glide.
 */
export class StepDivisionControl {
  /**
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {number} [opts.trackId]
   * @param {object} opts.divisionSpec paramSchema entry for the note value
   * @param {object} opts.modSpec  paramSchema entry for the tri-state modifier
   * @param {boolean} [opts.compact] shrink the division number to dragnum--compact,
   *   for a host (the LFO panel) that swaps this in for an already-compact control
   *   and needs the two to match. The hub's own instance leaves this off.
   */
  constructor({ bus, trackId = 0, divisionSpec, modSpec, compact = false }) {
    this.bus = bus;
    this.trackId = trackId;
    this.divisionSpec = divisionSpec;
    this.modSpec = modSpec;
    this.mod = Number(modSpec.def) || STEP_MOD_STRAIGHT;

    this.divisionControl = new DragNumber({
      spec: divisionSpec,
      format: (value) => noteValueLabel(value),
      // The visible text is just "1/8"; the modifier lives in the letters beside it,
      // so the spoken form has to put them back together.
      describe: (value) => noteValueDescription(value, this.mod),
      onInput: (value) => this.#emit(divisionSpec.key, value),
    });
    if (compact) this.divisionControl.element.classList.add('dragnum--compact');

    this.modButtons = new Map([
      [STEP_MOD_TRIPLET, this.#buildModButton('T', STEP_MOD_TRIPLET, 'Triplet')],
      [STEP_MOD_DOTTED, this.#buildModButton('D', STEP_MOD_DOTTED, 'Dotted')],
    ]);

    const mods = document.createElement('div');
    mods.className = 'step-division__mods';
    mods.append(...this.modButtons.values());

    const root = document.createElement('div');
    root.className = 'step-division';
    root.append(this.divisionControl.element, mods);
    this.element = root;

    this.#renderMods();
  }

  #buildModButton(letter, id, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'step-division__mod';
    button.textContent = letter;
    button.setAttribute('aria-label', name);
    // Both letters share one description: they are two faces of a single tri-state
    // parameter, not two parameters -- see ui/infoText.js.
    button.dataset.info = this.modSpec.key;
    button.addEventListener('click', () => this.#toggleMod(id));
    return button;
  }

  /** Clicking the active modifier clears it; clicking the other replaces it. */
  #toggleMod(id) {
    const next = this.mod === id ? STEP_MOD_STRAIGHT : id;
    if (next === this.mod) return;
    this.mod = next;
    this.#renderMods();
    this.#emit(this.modSpec.key, next);
  }

  #renderMods() {
    for (const [id, button] of this.modButtons) {
      const active = this.mod === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    // The division's spoken form includes the modifier, so it has to be refreshed too.
    this.divisionControl.setValue(this.divisionControl.value);
  }

  #emit(key, value) {
    this.bus.emit('param:change', { trackId: this.trackId, key, value });
  }

  /** The two schema keys this control owns. */
  keys() {
    return [this.divisionSpec.key, this.modSpec.key];
  }

  /**
   * Reflect an externally-changed value without emitting, so applying a broadcast
   * cannot echo back onto the bus.
   */
  setValue(key, value) {
    if (key === this.divisionSpec.key) {
      this.divisionControl.setValue(value);
    } else if (key === this.modSpec.key) {
      this.mod = Number(value) || STEP_MOD_STRAIGHT;
      this.#renderMods();
    }
  }
}
