import { LOGIC_OPS, nextLogicOp } from '../sequencer/logic.js';
import { logicGateIcon } from './icons.js';

/** Operator id -> name, for the caption under the glyph. */
const NAME_BY_ID = new Map(LOGIC_OPS.map((op) => [op.id, op.name]));

/**
 * The logic operator, as a gate symbol that clicks through OR, AND, XOR, NAND.
 *
 * A slider was the wrong instrument for this: four named operators are a choice, not a
 * magnitude, and dragging a 1..4 track to reach XOR asks the hand to treat a category as
 * a quantity. A cycling glyph makes the whole set reachable in at most three clicks and
 * spends no horizontal room on a track.
 *
 * The schematic symbol says which control this is; the caption says what it is set to,
 * because at 24px the differences that matter -- XOR's second arc, NAND's bubble -- are
 * as small as they are on a real schematic.
 *
 * A leaf, like Dropdown: it reports through `onInput` rather than holding the bus.
 */
export class LogicOpControl {
  /**
   * @param {object} opts
   * @param {object} opts.spec entry from paramSchema
   * @param {(value: number) => void} opts.onInput
   */
  constructor({ spec, onInput }) {
    this.spec = spec;
    this.onInput = onInput;
    this.value = Number(spec.def);

    this.element = document.createElement('button');
    this.element.type = 'button';
    this.element.className = 'logic-op';
    this.element.addEventListener('click', () => this.#cycle());

    this.iconEl = document.createElement('span');
    this.iconEl.className = 'logic-op__icon';

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'logic-op__label';

    this.element.append(this.iconEl, this.labelEl);
    this.#render();
  }

  /** The one schema key this control owns. */
  keys() {
    return [this.spec.key];
  }

  /** Set from outside without emitting, so a broadcast cannot echo back onto the bus. */
  setValue(next) {
    this.value = Number(next);
    this.#render();
  }

  #render() {
    const name = NAME_BY_ID.get(this.value) ?? '?';
    this.iconEl.replaceChildren(logicGateIcon(this.value));
    this.labelEl.textContent = name;
    // The whole label, not just the role: a four-state cycler has no honest
    // aria-pressed, so the operator's name has to travel in the accessible name.
    this.element.setAttribute('aria-label', `${this.spec.label}: ${name}`);
  }

  #cycle() {
    this.value = nextLogicOp(this.value);
    this.#render();
    this.onInput(this.value);
  }
}
