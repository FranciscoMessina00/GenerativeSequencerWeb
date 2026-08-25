import { ahdEnvelope, attackWasCut, holdWasClamped } from '../audio/envelope.js';
import { instrumentById } from '../audio/instruments.js';
import { DragNumber } from './DragNumber.js';
import { EnvelopeView } from './EnvelopeView.js';
import { svgEl } from './icons.js';
import { formatMilliseconds } from './numberUtils.js';

/**
 * The amplitude envelope: a display of the shape, the three times that make it, and
 * the curve toggle.
 *
 * A composite in the same shape as LfoPanel and TrigLoopControl -- it owns the bus,
 * emits `param:change` for the four keys it holds, and reflects external changes
 * through setValue without echoing.
 *
 * Two things reach it that are not its own parameters, and both arrive through
 * setters rather than through the bus, because both are questions about context
 * rather than about the envelope:
 *
 *   `setInstrument`  Hold is the modal string's alone. A percussion voice never reads
 *                    envHold (see audio/instruments.js), so showing the control on a
 *                    drum page would be a dial that does nothing -- worse than an
 *                    absent one. The drawn curve drops the stage with it, so the
 *                    picture agrees with what the track would actually play.
 *   `setStepSeconds` The step is what the attack and hold are truncated against, so
 *                    it decides both the marker's position and the curve's own shape.
 *                    It moves with tempo, division and step modifier, none of which
 *                    this panel owns.
 */

/** How far right of the cut the warning badge sits, in CSS pixels. */
const WARN_OFFSET_X = 6;

/**
 * The two curve glyphs: a straight 45deg line (linear), a quadratic curve
 * (exponential). Deliberately the same pair GlideControl draws -- the issue asks for
 * that icon by name, and one shape meaning "linear or exponential" everywhere is
 * worth more than a second drawing of the same idea.
 */
function buildCurveIcon(exponential) {
  const svg = svgEl('svg', { viewBox: '0 0 12 12', class: 'envelope__curve-icon' });
  const shape = exponential
    ? svgEl('path', { d: 'M2 10 Q10 10 10 2', fill: 'none' })
    : svgEl('line', { x1: 2, y1: 10, x2: 10, y2: 2 });
  svg.appendChild(shape);
  return svg;
}

export class EnvelopePanel {
  /**
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {number} [opts.trackId]
   * @param {object} opts.attackSpec paramSchema entry for envAttack
   * @param {object} opts.holdSpec   envHold
   * @param {object} opts.decaySpec  envDecay
   * @param {object} opts.curveSpec  envCurve
   * @param {() => number} [opts.getStepSeconds] the visible track's current step
   *   duration; read late so a tempo change needs no re-wiring
   */
  constructor({
    bus, trackId = 0, attackSpec, holdSpec, decaySpec, curveSpec, getStepSeconds,
  }) {
    this.bus = bus;
    this.trackId = trackId;
    this.specs = {
      attack: attackSpec, hold: holdSpec, decay: decaySpec, curve: curveSpec,
    };
    this.getStepSeconds = getStepSeconds ?? (() => 0);

    this.values = {
      attack: Number(attackSpec.def) || 0,
      hold: Number(holdSpec.def) || 0,
      decay: Number(decaySpec.def) || 0,
    };
    this.exponential = Boolean(curveSpec.def);
    /** Whether the current instrument has a hold stage at all. */
    this.holdEnabled = true;
    this.stepSeconds = 0;

    const root = document.createElement('div');
    root.className = 'envelope';
    root.append(this.#buildScope(), this.#buildRow());
    this.element = root;

    this.#renderCurveIcon();
    this.refresh();
  }

  /** The four schema keys this panel owns. */
  keys() {
    return Object.values(this.specs).map((spec) => spec.key);
  }

  /**
   * Reflect an externally-changed value without emitting, so applying a broadcast
   * cannot echo back onto the bus.
   */
  setValue(key, value) {
    const s = this.specs;
    if (key === s.attack.key) {
      this.values.attack = Number(value) || 0;
      this.attackControl.setValue(value);
    } else if (key === s.hold.key) {
      this.values.hold = Number(value) || 0;
      this.holdControl.setValue(value);
    } else if (key === s.decay.key) {
      this.values.decay = Number(value) || 0;
      this.decayControl.setValue(value);
    } else if (key === s.curve.key) {
      this.exponential = Boolean(value);
      this.#renderCurveIcon();
    } else {
      return;
    }
    this.refresh();
  }

  /** Point this panel at a different track -- see main.js's selectTrack(). */
  setTrackId(trackId) {
    this.trackId = trackId;
  }

  /**
   * Which instrument the visible track plays, which decides whether Hold exists.
   *
   * Takes the stored `instrument` value rather than a boolean, so the one place that
   * knows hold belongs to the string is this line and audio/instruments.js's param
   * lists -- not a flag main.js would have to keep in step with both.
   */
  setInstrument(id) {
    const next = instrumentById(id).key === 'string';
    if (next === this.holdEnabled) return;
    this.holdEnabled = next;
    this.holdControl.element.hidden = !next;
    this.refresh();
  }

  /** Redraw against the current step duration -- tempo, division or modifier moved. */
  refresh() {
    this.stepSeconds = Number(this.getStepSeconds()) || 0;
    const env = this.#envelope();
    this.#syncHoldReach(env);
    this.view.setEnvelope(env, this.stepSeconds);
  }

  /** Draw in a different page's colours -- see ui/palette.js. */
  setPalette(palette) {
    this.view.setPalette(palette);
  }

  /**
   * Exactly the envelope a note-on would carry, truncation and all -- built through
   * the same ahdEnvelope() the audio path uses, with the same zero hold the percussion
   * builders pass. The picture is then of the sound rather than of the settings.
   */
  #envelope() {
    return ahdEnvelope({
      attackMs: this.values.attack,
      holdMs: this.holdEnabled ? this.values.hold : 0,
      decayMs: this.values.decay,
      stepSeconds: this.stepSeconds,
      exponential: this.exponential,
    });
  }

  #buildScope() {
    const wrap = document.createElement('div');
    wrap.className = 'envelope__scope';
    wrap.dataset.info = 'envScope';

    const canvas = document.createElement('canvas');
    canvas.className = 'envelope__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrap.appendChild(canvas);

    // Real elements over the canvas rather than glyphs painted into it: the whole
    // info-footer mechanism is `data-info` on a DOM node (main.js's delegated
    // pointerover), and a canvas has no sub-regions to hang that on. Both hidden until
    // there is something to warn about -- see #placeWarnings.
    //
    // Two, one per stage boundary, and never both at once: an attack that overran
    // skips the hold rather than shortening it, so the second warning's own condition
    // excludes the first's. They would otherwise land on the same point, since the two
    // dots coincide when there is no hold.
    this.warnAttackEl = this.#buildWarning(
      'envClipped',
      'The attack runs past the step and will be cut',
    );
    this.warnHoldEl = this.#buildWarning(
      'envHoldCut',
      'The hold reaches the end of the step and stops there',
    );
    wrap.append(this.warnAttackEl, this.warnHoldEl);

    // Constructed while this wrapper is still detached, so the canvas cannot be
    // measured yet -- EnvelopeView carries a ResizeObserver for exactly that, and
    // nothing here needs to call resize(). onDraw is what places the badges, for the
    // same reason: the first real geometry arrives with the first real measurement,
    // and every later redraw (resize, palette, a new envelope) goes through it too.
    this.view = new EnvelopeView({ canvas, onDraw: (shape) => this.#placeWarnings(shape) });
    return wrap;
  }

  /** One `!` badge, described through the info footer like every other control. */
  #buildWarning(infoId, label) {
    const el = document.createElement('span');
    el.className = 'envelope__warn';
    el.dataset.info = infoId;
    el.textContent = '!';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    el.hidden = true;
    return el;
  }

  /**
   * Put each warning on the boundary it is about, or take it away.
   *
   * To the right of its point rather than above it: right is the empty side (the curve
   * is falling away from both of these), while above would land in the "Step Length"
   * caption's band whenever the stage ended near full level -- which is precisely when
   * these fire.
   */
  #placeWarnings(shape) {
    this.#placeWarning(this.warnAttackEl, shape.truncated, shape.attackEnd);
    this.#placeWarning(this.warnHoldEl, shape.holdClamped, shape.decayStart);
  }

  #placeWarning(el, shown, at) {
    el.hidden = !shown;
    if (!shown) return;
    const limit = Math.max(0, this.view.cssWidth - (el.offsetWidth || 0) - 2);
    el.style.left = `${Math.min(at.x + WARN_OFFSET_X, limit)}px`;
    el.style.top = `${at.y}px`;
  }

  /**
   * How much of Hold the step is letting through, reflected onto the control itself.
   *
   * Three states, and the difference between the last two is the point:
   *
   *   the attack was cut     the stage is skipped outright (ahdEnvelope's rule 1), so
   *                          the control is greyed -- a dial the engine will not read
   *   the hold was clamped   the stage runs, just not for as long as it says. Nothing
   *                          is disabled: the value is still doing something, and
   *                          slowing the tempo would give all of it back
   *   neither                Hold means exactly what it says
   *
   * The reason joins the control's own description rather than replacing it, so the
   * footer reads what Hold is and what the step is doing to it at once. `data-info`
   * taking several space-separated ids is the same feature the bias/spread track uses.
   */
  #syncHoldReach(env) {
    const cut = attackWasCut(env);
    this.holdControl.setDisabled(cut);

    const key = this.specs.hold.key;
    if (cut) this.holdControl.element.dataset.info = `${key} envClipped`;
    else if (holdWasClamped(env)) this.holdControl.element.dataset.info = `${key} envHoldCut`;
    else this.holdControl.element.dataset.info = key;
  }

  /**
   * The curve toggle, built to sit in the row as a fourth cell rather than as an
   * icon floating on the display: the four things this panel holds are one set, and
   * a captioned glyph beside three captioned numbers reads as one.
   *
   * A `<button>` rather than a DragNumber, since it has two states and no magnitude,
   * but it borrows `.dragnum`'s stack -- the thing that changes above, what it is
   * called below -- so the row lines up on both.
   */
  #buildCurveToggle() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'envelope__curve';
    button.dataset.info = this.specs.curve.key;
    button.setAttribute('aria-label', this.specs.curve.label);
    button.setAttribute('aria-pressed', String(this.exponential));
    button.addEventListener('click', () => this.#toggleCurve());

    this.curveIconEl = document.createElement('span');
    this.curveIconEl.className = 'envelope__curve-glyph';

    const label = document.createElement('span');
    label.className = 'envelope__curve-label';
    label.textContent = 'Curve';

    button.append(this.curveIconEl, label);
    return button;
  }

  #buildRow() {
    const row = document.createElement('div');
    row.className = 'envelope__row';

    const build = (name) => {
      const spec = this.specs[name];
      const control = new DragNumber({
        spec,
        format: (v) => formatMilliseconds(v),
        describe: (v) => `${Math.round(v)} milliseconds`,
        onInput: (v) => {
          this.values[name] = v;
          this.refresh();
          this.#emit(spec.key, v);
        },
      });
      control.element.classList.add('dragnum--compact');
      return control;
    };

    this.attackControl = build('attack');
    this.holdControl = build('hold');
    this.decayControl = build('decay');
    this.curveButton = this.#buildCurveToggle();

    row.append(
      this.attackControl.element,
      this.holdControl.element,
      this.decayControl.element,
      this.curveButton,
    );
    return row;
  }

  #renderCurveIcon() {
    this.curveIconEl.replaceChildren(buildCurveIcon(this.exponential));
    this.curveButton.setAttribute('aria-pressed', String(this.exponential));
  }

  #toggleCurve() {
    this.exponential = !this.exponential;
    this.#renderCurveIcon();
    this.refresh();
    this.#emit(this.specs.curve.key, this.exponential);
  }

  #emit(key, value) {
    this.bus.emit('param:change', { trackId: this.trackId, key, value });
  }
}
