import { PARAM_SCHEMA } from '../core/paramSchema.js';
import { SCALE_NAMES } from '../sequencer/scales.js';
import { noteValueLabel, stepModById } from '../sequencer/stepDivision.js';
import { DragNumber } from './DragNumber.js';
import { formatNumber } from './numberUtils.js';

/**
 * Builds the control surface from the param schema and publishes changes to the
 * bus.
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
    /** key -> { wrapper, lo, hi, spec }, for setModRange -- range-input keys only. */
    this.modTicks = new Map();
  }

  /** Human-readable value for the enum-ish params, which are integers on the wire. */
  #formatValue(spec, value) {
    if (spec.display === 'scale') return SCALE_NAMES[Math.round(value) - 1] ?? '?';
    if (spec.display === 'noteValue') return noteValueLabel(value);
    if (spec.display === 'stepMod') return stepModById(value).name;
    if (spec.type === 'toggle') return value ? 'on' : 'off';
    return formatNumber(Number(value), spec.step);
  }

  #emit(key, value) {
    this.bus.emit('param:change', { trackId: this.trackId, key, value });
  }

  /**
   * Render the named groups as slider panels into `container`.
   *
   * `skip` omits keys so they can be rendered elsewhere without appearing twice --
   * some params live inside the step ring rather than the side panel. `prepend`
   * puts a custom widget (e.g. a BiasSpreadSlider) at the top of a group. `headingExtra`
   * puts one on the group's own heading line instead -- e.g. the LFO's target readout,
   * which reads better next to "Modulation" than inside the panel below it.
   */
  renderGroups(container, groupNames, { skip = [], prepend = {}, headingExtra = {} } = {}) {
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
      const titleExtra = headingExtra[group];
      if (titleExtra) heading.appendChild(titleExtra);
      section.appendChild(heading);

      if (extra) section.appendChild(extra);
      for (const spec of specs) section.appendChild(this.#buildControl(spec));
      container.appendChild(section);
    }
  }

  /** The schema keys this controller owns a control for. */
  keys() {
    return [...this.inputs.keys(), ...this.dragNumbers.keys()];
  }

  /**
   * Reflect an externally-changed value. Updates the control and its readout
   * without emitting, so applying a broadcast cannot echo back onto the bus.
   */
  setValue(key, value) {
    const spec = PARAM_SCHEMA.find((s) => s.key === key);
    if (!spec) return;

    this.dragNumbers.get(key)?.setValue(value);

    const input = this.inputs.get(key);
    if (input) {
      if (spec.type === 'toggle') input.checked = Boolean(value);
      else input.value = String(value);
    }

    const label = this.valueLabels.get(key);
    if (label) label.textContent = this.#formatValue(spec, value);
  }

  /**
   * Render the given keys as drag-numbers, with no group chrome -- for the
   * Euclidean params inside the ring, where slider tracks would not fit and would
   * compete with the pattern itself for attention.
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
    // On the row rather than the input, so hovering the label or the value readout
    // describes the control too -- see ui/infoText.js.
    wrapper.dataset.info = spec.key;

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

    if (spec.type === 'toggle') {
      wrapper.append(header, input);
    } else {
      // Wrapped rather than left bare, so the LFO's sweep -- when this param is
      // its target -- has a positioned parent to place tick marks against. A
      // toggle has no numeric range to mark, so it never gets one.
      const track = document.createElement('div');
      track.className = 'control__track';
      const modLo = document.createElement('span');
      modLo.className = 'control__modtick control__modtick--lo';
      const modHi = document.createElement('span');
      modHi.className = 'control__modtick control__modtick--hi';
      track.append(input, modLo, modHi);
      this.modTicks.set(spec.key, { wrapper: track, lo: modLo, hi: modHi, spec });
      wrapper.append(header, track);
    }

    return wrapper;
  }

  /**
   * The LFO's sweep on a plain slider, drawn as two tick marks at the range's
   * edges -- the thumb itself already marks the base value, so no extra dot is
   * needed here. `range` is `{ lo, hi }` in this param's own units, from
   * modulation/modRange.js, or null to clear it. A no-op for any key this
   * controller didn't build a range input for.
   */
  setModRange(key, range) {
    const entry = this.modTicks.get(key);
    if (!entry) return;
    entry.wrapper.classList.toggle('has-mod-range', Boolean(range));
    if (!range) return;
    const { spec } = entry;
    const span = spec.max - spec.min;
    const loPct = span > 0 ? ((range.lo - spec.min) / span) * 100 : 0;
    const hiPct = span > 0 ? ((range.hi - spec.min) / span) * 100 : 0;
    entry.lo.style.left = `${loPct}%`;
    entry.hi.style.left = `${hiPct}%`;
  }

  /**
   * Live readout of the last few steps: the Euclidean bit, the random/loop bit and
   * the resulting trigger side by side, so a disagreement between them identifies
   * which stage is misbehaving.
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
