/**
 * A labelled <select>, for params whose values are a short enumerated list
 * (currently: scale) rather than a continuous range -- a slider communicates
 * "somewhere between two ends," which is the wrong shape for "pick one of
 * these ten named things."
 */
export class Dropdown {
  /**
   * @param {object} opts
   * @param {object} opts.spec      paramSchema entry
   * @param {{value:number,label:string}[]} opts.options
   * @param {Function} opts.onInput (value) => void
   */
  constructor({ spec, options, onInput }) {
    this.spec = spec;
    this.onInput = onInput;

    const root = document.createElement('div');
    root.className = 'dropdown';

    const label = document.createElement('label');
    label.className = 'dropdown__label';
    label.textContent = spec.short ?? spec.label;
    label.htmlFor = `dropdown-${spec.key}`;

    this.selectEl = document.createElement('select');
    this.selectEl.className = 'dropdown__select';
    this.selectEl.id = `dropdown-${spec.key}`;

    for (const opt of options) {
      const optionEl = document.createElement('option');
      optionEl.value = String(opt.value);
      optionEl.textContent = opt.label;
      this.selectEl.appendChild(optionEl);
    }
    this.selectEl.value = String(spec.def);

    this.selectEl.addEventListener('change', () => {
      this.onInput(Number(this.selectEl.value));
    });

    root.append(label, this.selectEl);
    this.element = root;
  }

  /** Set from outside without firing onInput -- for reflecting external changes. */
  setValue(next) {
    this.selectEl.value = String(next);
  }
}
