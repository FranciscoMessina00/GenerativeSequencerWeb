import { paramSpec } from '../core/paramSchema.js';
import { shapeName } from '../modulation/lfo.js';
import { modTargetKey } from '../modulation/modTargets.js';
import { DragNumber } from './DragNumber.js';
import { LfoView } from './LfoView.js';
import { StepDivisionControl } from './StepDivisionControl.js';
import { svgEl } from './icons.js';
import { formatNumber } from './numberUtils.js';

/**
 * The LFO: a scope, a morphing shape, a rate that can follow the transport, a fold, a
 * depth, and the button that points it at a parameter.
 *
 * A composite in the same shape as BiasSpreadSlider and TrigLoopControl: it owns the
 * bus, emits param:change for the eight keys it holds, and reflects external changes
 * through setValue without echoing.
 *
 * The one thing it does not own is *which* parameter gets modulated. Assigning means
 * highlighting controls all over the page and intercepting a click on one of them,
 * which is page-level work -- so the button reports through `onMapRequest` and the
 * bootstrap runs the assign mode, the same division of labour the info footer uses.
 */

/**
 * The assign glyph: an arrow entering a target ring. Built here rather than in
 * icons.js because it means nothing outside modulation, the same reasoning
 * GlideControl gives for keeping its two curve glyphs local.
 */
function buildMapIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'icon' });
  svg.append(
    svgEl('circle', { cx: 15, cy: 12, r: 6 }),
    svgEl('circle', { cx: 15, cy: 12, r: 1.7, class: 'icon__dot' }),
    svgEl('path', { d: 'M2 12 H7.5' }),
    svgEl('polyline', { points: '5.5,9.8 7.8,12 5.5,14.2' }),
  );
  return svg;
}

/**
 * The Sync button's glyph: a metronome, case and pendulum arm -- built here for the
 * same reason buildMapIcon() is: it means nothing outside the LFO.
 */
function buildSyncIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'icon' });
  svg.append(
    svgEl('path', { d: 'M7 20 L10 5 H14 L17 20 Z' }), // the case
    svgEl('path', { d: 'M4 20 H20' }), // the base
    svgEl('path', { d: 'M12 19 L16.5 4' }), // the pendulum arm
    svgEl('circle', { cx: 15, cy: 10.5, r: 1.4, class: 'icon__dot' }), // the weight
  );
  return svg;
}

export class LfoPanel {
  /**
   * @param {object} opts
   * @param {import('../core/EventBus.js').EventBus} opts.bus
   * @param {number} [opts.trackId]
   * @param {object} opts.shapeSpec    paramSchema entry for the morph position
   * @param {object} opts.rateSpec     free-running rate in Hz
   * @param {object} opts.syncSpec     follow the transport instead of the Hz rate
   * @param {object} opts.divisionSpec note value, when synced
   * @param {object} opts.syncModSpec  straight / triplet / dotted, when synced
   * @param {object} opts.foldSpec     how far the peaks fold back
   * @param {object} opts.amountSpec   depth
   * @param {object} opts.targetSpec   index into MOD_TARGETS
   * @param {() => void} opts.onMapRequest the Map button was pressed
   */
  constructor({
    bus, trackId = 0, shapeSpec, rateSpec, syncSpec, divisionSpec, syncModSpec,
    foldSpec, amountSpec, targetSpec, onMapRequest,
  }) {
    this.bus = bus;
    this.trackId = trackId;
    this.specs = {
      shape: shapeSpec, rate: rateSpec, sync: syncSpec, division: divisionSpec,
      syncMod: syncModSpec, fold: foldSpec, amount: amountSpec, target: targetSpec,
    };
    this.onMapRequest = onMapRequest;

    this.shape = Number(shapeSpec.def) || 0;
    this.fold = Number(foldSpec.def) || 0;
    this.synced = Boolean(syncSpec.def);
    this.target = Number(targetSpec.def) || 0;
    this.assigning = false;

    const root = document.createElement('div');
    root.className = 'lfo';

    root.append(
      this.#buildScope(),
      this.#buildShapeRow(),
      this.#buildControlGrid(),
    );
    this.element = root;

    // Built, but deliberately not appended here: it sits next to the "Modulation"
    // heading instead, on the group's own <h2>, not inside the panel -- see
    // main.js's ui.renderGroups() call (headingExtra) and #buildTargetReadout()'s
    // own comment for why.
    this.targetRow = this.#buildTargetReadout();

    this.#renderSyncState();
    this.#renderTarget();
    this.#renderShape();
  }

  /** The eight schema keys this control owns. */
  keys() {
    return Object.values(this.specs).map((spec) => spec.key);
  }

  /**
   * Reflect an externally-changed value without emitting, so applying a broadcast
   * cannot echo back onto the bus.
   */
  setValue(key, value) {
    const s = this.specs;
    if (key === s.shape.key) {
      this.shape = Number(value) || 0;
      this.shapeInput.value = String(this.shape);
      this.#renderShape();
    } else if (key === s.fold.key) {
      this.fold = Number(value) || 0;
      this.foldControl.setValue(value);
      this.#renderShape();
    } else if (key === s.rate.key) {
      this.rateControl.setValue(value);
    } else if (key === s.sync.key) {
      this.synced = Boolean(value);
      this.#renderSyncState();
    } else if (key === s.amount.key) {
      this.amountControl.setValue(value);
    } else if (key === s.target.key) {
      this.target = Number(value) || 0;
      this.#renderTarget();
    } else if (key === s.division.key || key === s.syncMod.key) {
      // Owned by the nested division control, which is covered by this widget's keys().
      this.divisionControl.setValue(key, value);
    }
  }

  /** Highlight the Map button while the page is waiting for a control to be picked. */
  setAssigning(assigning) {
    this.assigning = Boolean(assigning);
    this.mapButton.classList.toggle('is-active', this.assigning);
    this.mapButton.setAttribute('aria-pressed', String(this.assigning));
    this.#renderTarget();
  }

  #buildScope() {
    const wrap = document.createElement('div');
    wrap.className = 'lfo__scope';
    wrap.dataset.info = 'lfoScope';

    const canvas = document.createElement('canvas');
    canvas.className = 'lfo__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrap.appendChild(canvas);

    // Constructed while this wrapper is still detached, so the canvas cannot be
    // measured yet -- a getBoundingClientRect() here is all zeros, and nothing about
    // being appended to the panel changes that. LfoView carries a ResizeObserver for
    // exactly this reason: it fires once the panel reaches the document and the
    // canvas has a real size. Nothing here needs to call resize().
    this.view = new LfoView({ canvas });
    return wrap;
  }

  /**
   * Shape is a slider rather than a drag-number: it is a continuum between four named
   * shapes, and the name is all the readout worth having -- what the morph is actually
   * doing is visible in the scope directly above it.
   */
  #buildShapeRow() {
    const row = document.createElement('div');
    row.className = 'lfo__row lfo__row--shape';
    row.dataset.info = this.specs.shape.key;

    const header = document.createElement('div');
    header.className = 'lfo__header';
    const label = document.createElement('span');
    label.className = 'lfo__label';
    label.textContent = 'Shape';
    this.shapeValueEl = document.createElement('span');
    this.shapeValueEl.className = 'lfo__value';
    header.append(label, this.shapeValueEl);

    this.shapeInput = document.createElement('input');
    this.shapeInput.type = 'range';
    this.shapeInput.className = 'lfo__slider';
    this.shapeInput.min = String(this.specs.shape.min);
    this.shapeInput.max = String(this.specs.shape.max);
    this.shapeInput.step = String(this.specs.shape.step);
    this.shapeInput.value = String(this.shape);
    this.shapeInput.setAttribute('aria-label', this.specs.shape.label);
    this.shapeInput.addEventListener('input', () => {
      this.shape = Number(this.shapeInput.value);
      this.#renderShape();
      this.#emit(this.specs.shape.key, this.shape);
    });

    row.append(header, this.shapeInput);
    return row;
  }

  /**
   * The four remaining controls, on a 2x2 grid: Fold | Rate (with Sync) above,
   * Amount | Map below -- the same layout idiom EuclidView's hub uses for its own
   * four stats. Rate and Sync are one grid cell, not two: Sync just says which of
   * Rate's two faces (free Hz or synced division) is showing, so it moves as part
   * of that control -- trailing after the number, since this cell sits in the
   * grid's right column -- rather than getting a quarter of the grid to itself.
   *
   * Free rate and synced division are the same setting expressed two ways, so only
   * one is ever shown -- two visible rate controls would leave it ambiguous which
   * one the LFO is actually following.
   */
  #buildControlGrid() {
    const grid = document.createElement('div');
    grid.className = 'lfo__grid';

    const rateGroup = document.createElement('div');
    rateGroup.className = 'lfo__rate-group';

    this.syncButton = document.createElement('button');
    this.syncButton.type = 'button';
    this.syncButton.className = 'lfo__sync';
    this.syncButton.append(buildSyncIcon());
    this.syncButton.setAttribute('aria-label', this.specs.sync.label);
    this.syncButton.dataset.info = this.specs.sync.key;
    this.syncButton.addEventListener('click', () => {
      this.synced = !this.synced;
      this.#renderSyncState();
      this.#emit(this.specs.sync.key, this.synced);
    });

    this.rateControl = new DragNumber({
      spec: this.specs.rate,
      format: (v) => `${formatNumber(v, this.specs.rate.step)}Hz`,
      describe: (v) => `${formatNumber(v, this.specs.rate.step)} hertz`,
      onInput: (v) => this.#emit(this.specs.rate.key, v),
    });
    this.rateControl.element.classList.add('dragnum--compact');

    this.divisionControl = new StepDivisionControl({
      bus: this.bus,
      trackId: this.trackId,
      divisionSpec: this.specs.division,
      modSpec: this.specs.syncMod,
      // Matches the rate control's own compact sizing above -- without this the
      // division's drag-number renders at the default, much larger size, so
      // toggling Sync visibly resized the row.
      compact: true,
    });

    rateGroup.append(this.rateControl.element, this.divisionControl.element, this.syncButton);

    this.foldControl = new DragNumber({
      spec: this.specs.fold,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => {
        this.fold = v;
        this.#renderShape();
        this.#emit(this.specs.fold.key, v);
      },
    });
    this.foldControl.element.classList.add('dragnum--compact');

    this.amountControl = new DragNumber({
      spec: this.specs.amount,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => this.#emit(this.specs.amount.key, v),
    });
    this.amountControl.element.classList.add('dragnum--compact');

    this.mapButton = document.createElement('button');
    this.mapButton.type = 'button';
    this.mapButton.className = 'lfo__map';
    this.mapButton.dataset.info = 'lfoMap';
    this.mapButton.setAttribute('aria-pressed', 'false');
    const caption = document.createElement('span');
    caption.className = 'lfo__map-label';
    caption.textContent = 'Map';
    this.mapButton.append(buildMapIcon(), caption);
    this.mapButton.addEventListener('click', () => this.onMapRequest?.());

    // DOM order is the grid order: fold and amount land in the left column (odd
    // positions), rateGroup and map in the right (even) -- see the CSS, which mirrors
    // .hub's own odd/even mirrored alignment so both columns hug the centre gutter.
    grid.append(this.foldControl.element, rateGroup, this.amountControl.element, this.mapButton);
    return grid;
  }

  /**
   * The name of whatever the LFO is pointed at, plus a button to clear it. Returned
   * for the caller to place -- see targetRow in the constructor -- rather than
   * appended here, since it lives beside the "Modulation" heading, not inside this
   * panel.
   */
  #buildTargetReadout() {
    const row = document.createElement('div');
    row.className = 'lfo__target-row';

    this.targetEl = document.createElement('span');
    this.targetEl.className = 'lfo__target';

    this.clearButton = document.createElement('button');
    this.clearButton.type = 'button';
    this.clearButton.className = 'lfo__clear';
    this.clearButton.textContent = '×';
    this.clearButton.setAttribute('aria-label', 'Clear the LFO mapping');
    this.clearButton.dataset.info = 'lfoClear';
    // Index 0 is MOD_TARGETS[0] === null, "not mapped" -- the same value the page's
    // own assign-mode click handler writes when binding a target (main.js), just
    // hardcoded here since there is nothing to map an id through in the other
    // direction.
    this.clearButton.addEventListener('click', () => this.#emit(this.specs.target.key, 0));

    row.append(this.targetEl, this.clearButton);
    return row;
  }

  #renderShape() {
    this.shapeValueEl.textContent = shapeName(this.shape);
    this.shapeInput.setAttribute('aria-valuetext', shapeName(this.shape));
    this.view.setWave(this.shape, this.fold);
  }

  #renderSyncState() {
    this.syncButton.classList.toggle('is-active', this.synced);
    this.syncButton.setAttribute('aria-pressed', String(this.synced));
    this.rateControl.element.hidden = this.synced;
    this.divisionControl.element.hidden = !this.synced;
  }

  /** Names what the LFO is pointed at, since the Map button itself has no room for it. */
  #renderTarget() {
    if (this.assigning) {
      this.targetEl.textContent = 'Pick a control…';
      this.targetEl.classList.add('is-assigning');
      this.clearButton.hidden = true;
      return;
    }
    this.targetEl.classList.remove('is-assigning');
    const key = modTargetKey(this.target);
    const spec = key ? paramSpec(key) : null;
    this.targetEl.textContent = spec ? `→ ${spec.label}` : 'Not mapped';
    this.targetEl.classList.toggle('is-unmapped', !spec);
    // Nothing to clear when there is no mapping, and mid-pick is handled above.
    this.clearButton.hidden = !spec;
  }

  #emit(key, value) {
    this.bus.emit('param:change', { trackId: this.trackId, key, value });
  }

  /**
   * Point this panel at a different track -- see main.js's selectTrack().
   *
   * The nested division control emits on its own, so it has to be told too;
   * everything else in here routes through #emit.
   */
  setTrackId(trackId) {
    this.trackId = trackId;
    this.divisionControl.setTrackId(trackId);
  }
}
