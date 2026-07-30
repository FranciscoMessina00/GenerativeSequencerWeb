import { PARAM_SCHEMA } from '../core/paramSchema.js';
import { LOGIC_OP_NAMES } from '../sequencer/logic.js';
import { SCALE_NAMES } from '../sequencer/scales.js';
import { DragNumber } from './DragNumber.js';

/**
 * Builds the control surface from the param schema and publishes changes to the
 * bus. Deliberately plain -- sliders, checkboxes and a readout -- because phase 1
 * is about verifying the engine, not about looking like the Processing GUI.
 *
 * The UI never touches the sequencer or the audio engine directly; it only emits
 * `param:change`. That is what makes the same control surface work unchanged when
 * a second track is added.
 */
export class UIController {
  constructor({ bus, trackId = 0 }) {
    this.bus = bus;
    this.trackId = trackId;
    this.valueLabels = new Map();
    this.inputs = new Map();
    /** key -> DragNumber, for the controls rendered inside the step ring. */
    this.dragNumbers = new Map();
  }

  /** Human-readable value for the enum-ish params, which are integers on the wire. */
  #formatValue(spec, value) {
    if (spec.display === 'logic') return LOGIC_OP_NAMES[Math.round(value) - 1] ?? '?';
    if (spec.display === 'scale') return SCALE_NAMES[Math.round(value) - 1] ?? '?';
    if (spec.type === 'toggle') return value ? 'on' : 'off';
    const decimals = spec.step >= 1 ? 0 : spec.step >= 0.01 ? 2 : 3;
    return Number(value).toFixed(decimals);
  }

  #emit(key, value) {
    this.bus.emit('param:change', { trackId: this.trackId, key, value });
  }

  /**
   * Render the named groups as slider panels into `container`.
   *
   * Rendering is split by target rather than done in one pass, because some
   * params live inside the step ring and the rest live in the side panel. Keys in
   * `skip` are omitted so they can be rendered elsewhere without appearing twice.
   *
   * `prepend` inserts a custom widget (e.g. a BiasSpreadSlider) at the top of a
   * named group's panel, before its remaining sliders -- used where a group's
   * bias and spread params are better driven by one combined control than by
   * two separate sliders.
   */
  renderGroups(container, groupNames, { skip = [], prepend = {} } = {}) {
    const skipped = new Set(skip);

    for (const group of groupNames) {
      const specs = PARAM_SCHEMA.filter(
        (s) => s.group === group && !skipped.has(s.key),
      );
      const extra = prepend[group];
      if (specs.length === 0 && !extra) continue;

      const section = document.createElement('section');
      section.className = 'group';

      const heading = document.createElement('h2');
      heading.textContent = group;
      section.appendChild(heading);

      if (extra) section.appendChild(extra);
      for (const spec of specs) section.appendChild(this.#buildControl(spec));
      container.appendChild(section);
    }
  }

  /**
   * Render the given keys as drag-numbers, with no group chrome.
   *
   * Used for the Euclidean parameters inside the ring, where a heading and slider
   * tracks would not fit and would compete with the pattern itself for attention.
   */
  renderDragNumbers(container, keys) {
    for (const key of keys) {
      const spec = PARAM_SCHEMA.find((s) => s.key === key);
      if (!spec) continue;
      const control = new DragNumber({
        spec,
        format: (v) => this.#formatValue(spec, v),
        onInput: (v) => this.#emit(spec.key, v),
      });
      this.dragNumbers.set(key, control);
      container.appendChild(control.element);
    }
  }

  #buildControl(spec) {
    const wrapper = document.createElement('div');
    wrapper.className = spec.type === 'toggle' ? 'control toggle' : 'control';

    const label = document.createElement('label');
    label.textContent = spec.label;
    label.htmlFor = `param-${spec.key}`;

    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = this.#formatValue(spec, spec.def);
    this.valueLabels.set(spec.key, value);

    const input = document.createElement('input');
    input.id = `param-${spec.key}`;
    this.inputs.set(spec.key, input);

    if (spec.type === 'toggle') {
      input.type = 'checkbox';
      input.checked = Boolean(spec.def);
      input.addEventListener('change', () => {
        value.textContent = this.#formatValue(spec, input.checked);
        this.#emit(spec.key, input.checked);
      });
    } else {
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(spec.def);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        value.textContent = this.#formatValue(spec, v);
        this.#emit(spec.key, v);
      });
    }

    const header = document.createElement('div');
    header.className = 'control-header';
    header.append(label, value);
    wrapper.append(header, input);

    return wrapper;
  }

  /**
   * Live readout of the last few steps.
   *
   * This is the main verification instrument: it shows the Euclidean bit, the
   * random/loop bit and the resulting trigger side by side, so a disagreement
   * between them immediately identifies which stage is misbehaving.
   */
  attachReadout(element, maxRows = 14) {
    this.readout = element;
    this.rows = [];
    this.maxRows = maxRows;
  }

  pushStep(step) {
    if (!this.readout) return;
    this.rows.unshift(step);
    if (this.rows.length > this.maxRows) this.rows.pop();

    const lines = [
      'step  euc rnd trig   note  vel   pluck',
      '─────────────────────────────────────────',
      ...this.rows.map((s) => {
        const idx = String(s.stepIndex).padStart(3);
        const euc = String(s.euclidBit);
        const rnd = String(s.randomBit);
        const trg = s.triggered ? '  ●  ' : '  ·  ';
        const note = s.note.toFixed(0).padStart(5);
        const vel = s.velocity.toFixed(2).padStart(5);
        const mod = s.mod.toFixed(1).padStart(6);
        return `${idx}    ${euc}   ${rnd}  ${trg} ${note} ${vel} ${mod}`;
      }),
    ];
    this.readout.textContent = lines.join('\n');
  }

  clearReadout() {
    if (!this.readout) return;
    this.rows.length = 0;
    this.readout.textContent = '';
  }
}
