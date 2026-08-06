import { INSTRUMENTS, instrumentById } from '../audio/instruments.js';
import { Dropdown } from './Dropdown.js';

/**
 * Which instrument's controls are on screen, and the selector that changes it.
 *
 * Every instrument's panel is rendered once, up front, and all but one is hidden.
 * Rebuilding them on each track switch would be the obvious alternative and is a worse
 * one: the panels are built by UIController from the schema, so tearing them down would
 * invalidate every entry it holds in `inputs`, `valueLabels` and `modTicks`, and take
 * the LFO's sweep indicators with them. Hiding costs four sections' worth of DOM that
 * exists anyway the moment a second track selects a different instrument.
 *
 * The selector is one Dropdown that *moves* rather than four that stay put, because
 * there is only one thing being chosen. It sits on the visible panel's heading, so the
 * question ("which instrument?") is next to its answer rather than somewhere general.
 *
 * Split out of main.js so a check page can drive it without a whole bootstrap.
 */
export class InstrumentPanel {
  /**
   * @param {object} opts
   * @param {object} opts.spec paramSchema entry for `instrument`
   * @param {Map<string, HTMLElement>} opts.sections group name -> its <section>
   * @param {Map<string, HTMLElement>} opts.headings group name -> its <h2>
   * @param {(value: number) => void} opts.onInput asked to change instrument; the
   *   store decides what actually happens, as with every other control
   */
  constructor({ spec, sections, headings, onInput }) {
    this.spec = spec;
    this.sections = sections;
    this.headings = headings;

    this.dropdown = new Dropdown({
      spec,
      options: INSTRUMENTS.map((i) => ({ value: i.id, label: i.name })),
      onInput,
    });
    this.dropdown.element.classList.add('instrument-pick');

    /** The instrument currently shown, so a repeat call can do nothing. */
    this.current = null;
    this.setInstrument(spec.def);
  }

  /** The one schema key this owns, so main.js can register it like any other control. */
  keys() {
    return [this.spec.key];
  }

  /**
   * Reflect a committed value without emitting -- the contract every setValue here
   * follows, which is what stops a control's own echo becoming a loop.
   */
  setValue(value) {
    this.dropdown.setValue(value);
    this.setInstrument(value);
  }

  /**
   * Show one instrument's panel and hide the rest.
   *
   * An unknown id resolves to the first instrument rather than hiding everything: a
   * patch from a future build naming an instrument this one lacks should leave a usable
   * panel on screen, matching what instrumentById does for the sound.
   */
  setInstrument(id) {
    const instrument = instrumentById(id);
    if (instrument.group === this.current) return;
    this.current = instrument.group;

    for (const other of INSTRUMENTS) {
      const section = this.sections.get(other.group);
      // Plain `hidden` is enough: .group sets no display of its own, unlike .legend
      // span and the LFO's rate controls, which need a rule to outrank it.
      if (section) section.hidden = other.group !== instrument.group;
    }

    // Moving the node is the whole mechanism -- appendChild on a node that is already
    // somewhere else relocates it, so there is never more than one selector.
    this.headings.get(instrument.group)?.append(this.dropdown.element);
  }
}
