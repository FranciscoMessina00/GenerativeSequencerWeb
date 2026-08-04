import { EventBus } from './core/EventBus.js';
import { Rng } from './core/rng.js';
import { paramSpec } from './core/paramSchema.js';
import { ParamStore } from './core/ParamStore.js';
// Namespaced because toJSON has no button of its own -- it is how a new factory
// patch gets authored, via the console handle at the bottom of this file.
import * as presets from './core/presets.js';
import { Track } from './sequencer/Track.js';
import { Scheduler } from './sequencer/Scheduler.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { UIController } from './ui/UIController.js';
import { EuclidView } from './ui/EuclidView.js';
import { BiasSpreadSlider } from './ui/BiasSpreadSlider.js';
import { Dropdown } from './ui/Dropdown.js';
import { GlideControl } from './ui/GlideControl.js';
import { StepDivisionControl } from './ui/StepDivisionControl.js';
import { LogicOpControl } from './ui/LogicOpControl.js';
import { FillIconControl } from './ui/FillIconControl.js';
import { TrigLoopControl } from './ui/TrigLoopControl.js';
import { LfoPanel } from './ui/LfoPanel.js';
import { InfoBar } from './ui/InfoBar.js';
import { Modulation } from './modulation/Modulation.js';
import { MOD_TARGETS } from './modulation/modTargets.js';
import { modSweepRange } from './modulation/modRange.js';
import { diceIcon } from './ui/icons.js';
import { SCALES } from './sequencer/scales.js';

/**
 * Bootstrap. The only module that knows about all the others -- everything
 * downstream talks over the bus.
 */

const bus = new EventBus();
const rng = new Rng();
const audio = new AudioEngine(bus);

// One channel for now. `tracks` is a list and every event carries its trackId, so
// adding channels is additive.
const tracks = [new Track(0, rng)];

// Which track the single on-screen control surface is bound to. A track selector
// would make this a variable; until then it names the assumption instead of
// scattering literal zeros through the wiring.
const VISIBLE_TRACK = 0;

const scheduler = new Scheduler({
  bus,
  getCurrentTime: () => audio.currentTime,
  tracks,
});

// Assigned below, once the canvas has been measured. Declared here so the store's
// routing closure can reference it without risking a temporal-dead-zone throw.
/** @type {EuclidView | undefined} */
let view;

// Named for what it explains rather than what it is, since that's the only
// reason the ring's own routing closure below needs to touch it.
const legendRandomEl = document.getElementById('legend-random');

// Which engine owns a param, and nothing else -- no UI side effects.
//
// Split out of the routing closure below because it has a second caller: the LFO
// writes modulated values through here too, deliberately going around the store so
// that the value the user dialled in stays the authoritative one and their controls
// stay still. See modulation/Modulation.js.
const writeToEngine = (key, value, trackId, spec) => {
  if (spec.target === 'track') tracks[trackId]?.setParam(key, value);
  else if (spec.target === 'transport') scheduler.setParam(key, value);
  else if (spec.target === 'voice') audio.setParam(key, value);
};

// Assigned below, once the store exists for it to read base values from.
/** @type {import('./modulation/Modulation.js').Modulation | undefined} */
let modulation;

// The one authoritative copy of every parameter. It owns writing to the engines and
// announces each committed value as `param:changed`, which is what lets a preset or
// a MIDI message move the controls.
const store = new ParamStore({
  bus,
  trackCount: tracks.length,
  route: (key, value, trackId, spec) => {
    if (spec.target === 'modulation') {
      // Not an engine: these configure the LFO itself.
      modulation?.setParam(key, value);
      return;
    }
    writeToEngine(key, value, trackId, spec);

    if (spec.target === 'track') {
      // The ring is a picture of the Euclidean pattern, so refresh it when the
      // pattern parameters move.
      if (key === 'steps' || key === 'pulses' || key === 'rotation') {
        view?.setPattern(tracks[trackId].getPattern());
      } else if (key === 'trigLoop') {
        // The ring also overlays the rhythm loop's captured random-bit buffer
        // while it's active -- see EuclidView.setLoopActive/setLoopSnapshot.
        // An immediate snapshot on top of activating gives feedback right away,
        // rather than waiting for the playhead to complete a full revolution.
        view?.setLoopActive(value);
        legendRandomEl.hidden = !value;
        if (value) {
          view?.setLoopSnapshot(tracks[trackId].getTrigLoopWindow(tracks[trackId].getPattern().length));
        }
      } else if ((key === 'trigLoopLength' || key === 'trigPerm') && tracks[trackId].params.trigLoop) {
        // A recapture changes the buffer's content immediately; refresh the
        // overlay too rather than leaving it showing what's now a stale
        // projection until the next revolution happens to complete.
        view?.setLoopSnapshot(tracks[trackId].getTrigLoopWindow(tracks[trackId].getPattern().length));
      }
    }
  },
});

// The LFO. It reads base values out of the store and writes modulated ones straight to
// the engines, so the store keeps owning what the user actually set.
modulation = new Modulation({
  store,
  write: writeToEngine,
  getBarSeconds: () => scheduler.barDuration,
  trackId: VISIBLE_TRACK,
});

// The parameters that define the Euclidean pattern live inside the ring, since they are
// what the ring is a picture of. Division joins them because it sets how fast the playhead
// crosses those sectors. Order fills the 2x2 grid: Steps | Pulses, then Rotation | Division.
const EUCLID_KEYS = ['steps', 'pulses', 'rotation'];
const HUB_KEYS = [...EUCLID_KEYS, 'stepDivision', 'stepMod'];

const hubEl = document.getElementById('hub');
const ui = new UIController({ bus });
ui.renderDragNumbers(hubEl, EUCLID_KEYS);

// Division is a drag-number plus two letter toggles, so it is built here rather than by
// renderDragNumbers, and appended as the grid's fourth cell.
const stepDivisionControl = new StepDivisionControl({
  bus,
  trackId: VISIBLE_TRACK,
  divisionSpec: paramSpec('stepDivision'),
  modSpec: paramSpec('stepMod'),
});
hubEl.appendChild(stepDivisionControl.element);

// The rest of the rhythm controls sit under the ring, as one row of glyphs: how the
// Euclidean bit combines with the random one, how often that bit is set, and the loop
// that can freeze and reorder it. None of the four is a magnitude worth reading to two
// decimals, which is why none of them is a slider.
const TRIG_KEYS = ['logicOp', 'probability', 'trigLoop', 'trigLoopLength', 'trigPerm'];

const logicOpControl = new LogicOpControl({
  spec: paramSpec('logicOp'),
  onInput: (value) => bus.emit('param:change', { trackId: VISIBLE_TRACK, key: 'logicOp', value }),
});
const probabilityControl = new FillIconControl({
  spec: paramSpec('probability'),
  buildIcon: diceIcon,
  label: 'Prob',
  onInput: (value) => bus.emit('param:change', { trackId: VISIBLE_TRACK, key: 'probability', value }),
});
const trigLoopControl = new TrigLoopControl({
  bus,
  trackId: VISIBLE_TRACK,
  enabledSpec: paramSpec('trigLoop'),
  lengthSpec: paramSpec('trigLoopLength'),
  permSpec: paramSpec('trigPerm'),
});

const trigRow = document.createElement('div');
trigRow.className = 'trig-row';
trigRow.append(logicOpControl.element, probabilityControl.element, trigLoopControl.element);

// Every Rhythm param is now drawn by a purpose-built control, so the group renders as
// nothing but its heading and this row. renderGroups keeps the section because `prepend`
// is present even though no schema control survives the skip list.
ui.renderGroups(document.getElementById('rhythm-controls'), ['Rhythm'], {
  skip: [...HUB_KEYS, ...TRIG_KEYS],
  prepend: { Rhythm: trigRow },
});
// Bias/spread pairs get one combined slider instead of two: horizontal drag sets
// the bias, vertical drag sets the spread -- see BiasSpreadSlider.js.
const BIAS_SPREAD_AXES = {
  Pitch: { bias: 'noteBias', spread: 'noteSpread', title: 'Note' },
  Velocity: { bias: 'velBias', spread: 'velSpread', title: 'Velocity' },
  String: { bias: 'modBias', spread: 'modSpread', title: 'Pluck Position' },
};
const sliderPrepend = {};
/** Kept by group so the sliders can be registered for two-way sync below. */
const biasSpreadSliders = {};
for (const [group, axes] of Object.entries(BIAS_SPREAD_AXES)) {
  const slider = new BiasSpreadSlider({
    bus,
    trackId: VISIBLE_TRACK,
    biasSpec: paramSpec(axes.bias),
    spreadSpec: paramSpec(axes.spread),
    title: axes.title,
  });
  biasSpreadSliders[group] = slider;
  sliderPrepend[group] = slider.element;
}
const sliderSkipKeys = Object.values(BIAS_SPREAD_AXES).flatMap((a) => [a.bias, a.spread]);

// Pitch and Velocity get the same loop mechanism Rhythm draws as a glyph row --
// capture, length, and (where the schema has one) reorder. See TrigLoopControl.js.
const noteLoopControl = new TrigLoopControl({
  bus,
  trackId: VISIBLE_TRACK,
  enabledSpec: paramSpec('noteLoop'),
  lengthSpec: paramSpec('noteLoopLength'),
  permSpec: paramSpec('notePerm'),
});
// Velocity has no permutation param, so its loop is capture + length only --
// TrigLoopControl omits the permutation glyph whenever permSpec isn't passed.
const velLoopControl = new TrigLoopControl({
  bus,
  trackId: VISIBLE_TRACK,
  enabledSpec: paramSpec('velLoop'),
  lengthSpec: paramSpec('velLoopLength'),
});
const NOTE_LOOP_KEYS = ['noteLoop', 'noteLoopLength', 'notePerm'];
const VEL_LOOP_KEYS = ['velLoop', 'velLoopLength'];

// Scale and Glide share one row below the Note slider: Scale flexes to fill it,
// Glide sits fixed-width at the right.
const scaleDropdown = new Dropdown({
  spec: paramSpec('scale'),
  options: SCALES.map((s) => ({ value: s.id, label: s.name })),
  onInput: (value) => bus.emit('param:change', { trackId: VISIBLE_TRACK, key: 'scale', value }),
});
const glideControl = new GlideControl({
  bus,
  trackId: VISIBLE_TRACK,
  amountSpec: paramSpec('glideAmount'),
  modeSpec: paramSpec('glideMode'),
});
const scaleRow = document.createElement('div');
scaleRow.className = 'control-row dropdown-row';
scaleRow.append(scaleDropdown.element, glideControl.element);

const pitchPrepend = document.createElement('div');
pitchPrepend.append(sliderPrepend.Pitch, scaleRow, noteLoopControl.element);
sliderPrepend.Pitch = pitchPrepend;

const velocityPrepend = document.createElement('div');
velocityPrepend.append(sliderPrepend.Velocity, velLoopControl.element);
sliderPrepend.Velocity = velocityPrepend;

// The Modulation group is nothing but the LFO panel: every one of its schema entries
// is drawn by the panel itself, so all eight are skipped below to stop renderGroups
// also emitting them as plain sliders underneath.
const LFO_KEYS = [
  'lfoShape', 'lfoRate', 'lfoSync', 'lfoDivision',
  'lfoSyncMod', 'lfoFold', 'lfoAmount', 'lfoTarget',
];
const lfoPanel = new LfoPanel({
  bus,
  trackId: VISIBLE_TRACK,
  shapeSpec: paramSpec('lfoShape'),
  rateSpec: paramSpec('lfoRate'),
  syncSpec: paramSpec('lfoSync'),
  divisionSpec: paramSpec('lfoDivision'),
  syncModSpec: paramSpec('lfoSyncMod'),
  foldSpec: paramSpec('lfoFold'),
  amountSpec: paramSpec('lfoAmount'),
  targetSpec: paramSpec('lfoTarget'),
  onMapRequest: () => toggleAssignMode(),
});
sliderPrepend.Modulation = lfoPanel.element;

// Group order and membership no longer track PARAM_GROUPS: the order here is the
// on-screen order, which the schema's own ordering has no reason to dictate.
const CONTROL_GROUPS = ['Pitch', 'Velocity', 'Modulation', 'String', 'Granulator', 'Transport'];

ui.renderGroups(
  document.getElementById('controls'),
  CONTROL_GROUPS,
  {
    skip: [...sliderSkipKeys, ...NOTE_LOOP_KEYS, ...VEL_LOOP_KEYS, ...LFO_KEYS, 'scale', 'glideAmount', 'glideMode'],
    prepend: sliderPrepend,
    headingExtra: { Modulation: lfoPanel.targetRow },
  },
);
// Attaching a hidden readout would still cost a full reformat on every step, so
// the monitor's own visibility decides whether it gets fed.
const monitorEl = document.getElementById('monitor');
if (!monitorEl.hidden) ui.attachReadout(document.getElementById('readout'));

view = new EuclidView(
  document.getElementById('ring'),
  () => audio.currentTime,
  // Fit the hub overlay to the largest square that fits inside the hub circle,
  // so no control can spill past the sectors at any column width.
  ({ innerR }) => {
    const side = Math.max(60, (innerR * 2) / Math.SQRT2 - 8);
    hubEl.style.width = `${side}px`;
    hubEl.style.height = `${side}px`;
    // Shrink the controls when the ring itself is small. Keyed off the measured square
    // rather than a viewport breakpoint, since it is the ring's size that decides
    // whether four controls fit, and that depends on the column, not the window.
    hubEl.classList.toggle('hub--tight', side < 150);
  },
);
view.setPattern(tracks[VISIBLE_TRACK].getPattern());
view.setLoopActive(tracks[VISIBLE_TRACK].params.trigLoop);

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// key -> how to reflect a committed value back onto its control.
//
// Leaf controls take just the value; multi-key controls take (key, value). Binding
// the key here keeps the dispatch below a single Map lookup rather than a chain of
// instanceof checks.
const controlSetters = new Map();
// key -> how to draw (or clear) the LFO's sweep on its control, for whichever
// widgets implement setModRange -- most don't, and are simply never added here.
// See renderModRange() below.
const modRangeSetters = new Map();
const registerKeyed = (widget) => {
  for (const key of widget.keys()) {
    controlSetters.set(key, (v) => widget.setValue(key, v));
    if (widget.setModRange) modRangeSetters.set(key, (r) => widget.setModRange(key, r));
  }
};
const registerLeaf = (widget) => {
  for (const key of widget.keys()) {
    controlSetters.set(key, (v) => widget.setValue(v));
    if (widget.setModRange) modRangeSetters.set(key, (r) => widget.setModRange(r));
  }
};

registerKeyed(ui);
registerKeyed(glideControl);
registerKeyed(stepDivisionControl);
registerKeyed(trigLoopControl);
registerKeyed(noteLoopControl);
registerKeyed(velLoopControl);
registerKeyed(lfoPanel);
for (const slider of Object.values(biasSpreadSliders)) registerKeyed(slider);
registerLeaf(scaleDropdown);
registerLeaf(logicOpControl);
registerLeaf(probabilityControl);

// A control's gesture is only a *request*; the store decides what actually happens.
bus.on('param:change', ({ trackId, key, value }) => {
  store.set(key, value, trackId);
});

// ...and the committed value comes back here to move the controls. A control's own
// change lands as an idempotent redraw, because setValue never re-emits and the
// store already dropped the value if nothing changed.
bus.on('param:changed', ({ trackId, key, value, global }) => {
  if (!global && trackId !== VISIBLE_TRACK) return;
  controlSetters.get(key)?.(value);
});

// The ring's stepIndex from the step *before* this one, so a wrap (a new
// revolution starting) can be detected here once and the loop's whole next
// revolution projected in a single shot, rather than the ring updating one
// position at a time as the playhead happens to pass each one.
let lastRingStepIndex = -1;

bus.on('step', (step) => {
  audio.noteOn(step);
  const wrapped = step.trackId === VISIBLE_TRACK && step.stepIndex < lastRingStepIndex;
  lastRingStepIndex = step.stepIndex;
  view.enqueue(
    step,
    wrapped ? tracks[VISIBLE_TRACK].getTrigLoopWindow(tracks[VISIBLE_TRACK].getPattern().length) : undefined,
  );
  ui.pushStep(step);
  // Sampled here rather than on an animation frame: this path runs off the
  // scheduler's Worker timer, so it keeps modulating in a hidden tab where a
  // requestAnimationFrame loop would stall while the sequence played on.
  if (step.trackId === VISIBLE_TRACK) modulation.onStep(step);
});

// ---------------------------------------------------------------------------
// Modulation assignment
// ---------------------------------------------------------------------------

// Which controls the LFO is allowed to point at, by param key.
const MOD_TARGET_KEYS = new Set(MOD_TARGETS.filter(Boolean));

/**
 * The first eligible param an element speaks for, or null.
 *
 * `data-info` can name more than one id -- the bias/spread track drives two params
 * from one element -- so mapping takes the first eligible one. For that track it is
 * the bias, which is the axis the horizontal drag controls and the more useful of
 * the two to sweep.
 */
function targetKeyOf(element) {
  const ids = (element.dataset.info ?? '').split(/\s+/);
  return ids.find((id) => MOD_TARGET_KEYS.has(id)) ?? null;
}

let assigning = false;

/**
 * Assign mode: light up everything mappable, then bind whichever one is clicked.
 *
 * Page-level rather than something the panel does to itself, since it reaches every
 * control on screen -- the same reason the info footer's hover delegation lives here.
 * It needs no new markup: every control already carries `data-info` naming its param
 * key, so that attribute doubles as the map of what is mappable.
 */
function setAssignMode(next) {
  assigning = next;
  lfoPanel.setAssigning(assigning);
  for (const el of document.querySelectorAll('[data-info]')) {
    el.classList.toggle('is-mod-eligible', assigning && Boolean(targetKeyOf(el)));
  }
}

function toggleAssignMode() {
  setAssignMode(!assigning);
}

// Which control last had a sweep drawn on it, so a target change clears the
// previous one rather than leaving it stuck showing a stale range.
let modRangeKey = null;

/**
 * Draw the LFO's reach on whatever it targets, and clear it off whatever it just
 * stopped targeting. Purely a function of the store's current lfoTarget, lfoAmount
 * and the target's own base value -- called again whenever any of those three
 * change, never on a timer, since there is no live phase involved (see
 * modulation/modRange.js).
 */
function renderModRange() {
  const key = MOD_TARGETS[store.get('lfoTarget', VISIBLE_TRACK)] ?? null;
  if (modRangeKey && modRangeKey !== key) modRangeSetters.get(modRangeKey)?.(null);
  modRangeKey = key;
  if (!key) return;
  const amount = store.get('lfoAmount', VISIBLE_TRACK);
  const base = Number(store.get(key, VISIBLE_TRACK));
  modRangeSetters.get(key)?.(modSweepRange(key, base, amount));
}

// Capture phase, so the click binds the control instead of operating it -- otherwise
// picking a drag-number would also nudge its value.
document.addEventListener('pointerdown', (e) => {
  if (!assigning) return;
  const host = e.target instanceof Element ? e.target.closest('[data-info]') : null;
  const key = host ? targetKeyOf(host) : null;
  if (!key) return;
  e.preventDefault();
  e.stopPropagation();
  bus.emit('param:change', {
    trackId: VISIBLE_TRACK,
    key: 'lfoTarget',
    value: MOD_TARGETS.indexOf(key),
  });
  setAssignMode(false);
}, true);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && assigning) setAssignMode(false);
});

bus.on('param:changed', ({ key }) => {
  if (key === 'lfoTarget' || key === 'lfoAmount' || key === modRangeKey) renderModRange();
});

// ---------------------------------------------------------------------------
// Info footer
// ---------------------------------------------------------------------------

// One delegated pair of listeners for every control on the page. Each control
// names its own description through `data-info` -- most of them from their spec
// key, inside their own constructor -- so nothing here needs a list of controls to
// keep in sync, and a new control is one attribute away from being described.
const infoBar = new InfoBar(document.getElementById('infobar'));
// closest(), not e.target.dataset: nearly every control's pointer events land on a
// child that carries nothing -- a .dragnum__value, a .bsslider__rail, an icon svg.
const infoHostFor = (e) => (e.target instanceof Element ? e.target.closest('[data-info]') : null);

// pointerover bubbles (pointerenter does not), so this one handler covers arriving
// and leaving both: stepping off a control onto the page fires it on the page,
// which resolves to no host. Drag and wheel need no special case -- a captured
// pointer keeps delivering to the control it started on, so the text holds instead
// of flickering, and a wheel implies the pointer is already over the control.
document.addEventListener('pointerover', (e) => {
  const host = infoHostFor(e);
  if (host) infoBar.show(host.dataset.info);
  else infoBar.showHint();
});
document.addEventListener('focusin', (e) => {
  const host = infoHostFor(e);
  if (host) infoBar.show(host.dataset.info);
});
// The pointer leaving the window entirely fires no pointerover anywhere.
document.addEventListener('pointerleave', () => infoBar.showHint());
// A narrower bar can turn text that fitted into text that has to scroll.
window.addEventListener('resize', () => infoBar.remeasure());

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const playButton = document.getElementById('play');
const statusEl = document.getElementById('status');

bus.on('transport:change', ({ running }) => {
  view.setRunning(running);
  // Resets the LFO's phase on start, so a synced one is locked to the bar; on stop it
  // hands the parameter it was driving back to the value the store holds.
  modulation.setRunning(running);
  playButton.textContent = running ? 'Stop' : 'Play';
  playButton.classList.toggle('active', running);
  if (!running) {
    // Cut the ringing voices rather than letting up to 16 modal tails hang for
    // seconds after the transport stops.
    audio.panic();
    ui.clearReadout();
  }
});

async function ensureAudio() {
  // An AudioContext can only be created or resumed from a user gesture, so the
  // graph is built lazily on first press rather than at load.
  if (!audio.ready) {
    statusEl.textContent = 'starting audio…';
    try {
      await audio.init();
    } catch (err) {
      statusEl.textContent = `audio failed: ${err.message}`;
      throw err;
    }
  }
  await audio.resume();
  statusEl.textContent = `${audio.context.sampleRate} Hz · ${audio.context.state}`;
}

playButton.addEventListener('click', async () => {
  await ensureAudio();
  scheduler.toggle();
});

// A single note on demand, for checking the voice without running the sequence.
document.getElementById('pluck').addEventListener('click', async () => {
  await ensureAudio();
  const step = tracks[VISIBLE_TRACK].step(scheduler.stepDurationFor(VISIBLE_TRACK));
  audio.noteOn({ ...step, triggered: true, audioTime: audio.currentTime + 0.02 });
  ui.pushStep({ ...step, triggered: true });
});

document.getElementById('reseed').addEventListener('click', () => {
  rng.setSeed((Math.random() * 0x7fffffff) | 0);
  statusEl.textContent = `reseeded (${rng.seed})`;
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    playButton.click();
  }
});

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

const presetSlots = /** @type {HTMLSelectElement} */ (document.getElementById('preset-slots'));
const presetStatus = document.getElementById('preset-status');
const presetLoad = /** @type {HTMLButtonElement} */ (document.getElementById('preset-load'));

/** name -> patch, filled in once the factory file has been fetched. */
const factory = new Map();

let statusTimer;
/**
 * Transient feedback for a patch action. Keep messages within the width reserved by
 * `.patch__status` (15 characters) -- they do not name the patch, because the
 * dropdown next to them already says which one is selected.
 */
function say(message) {
  presetStatus.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { presetStatus.textContent = ''; }, 2600);
}

/**
 * Apply a patch, restoring its seed too.
 *
 * Order matters: reseed before the ring is refreshed, so what the display shows and
 * what the generators will produce come from the same seed.
 */
function applySnapshot(snapshot) {
  const seed = store.load(snapshot);
  if (seed !== undefined) rng.setSeed(seed);
  view.setPattern(tracks[VISIBLE_TRACK].getPattern());
  return seed;
}

function fillSlots(names) {
  if (names.length === 0) {
    // An empty select collapses to a bare caret, which reads as broken rather than
    // empty -- so say so instead.
    const placeholder = document.createElement('option');
    placeholder.textContent = 'unavailable';
    placeholder.value = '';
    presetSlots.replaceChildren(placeholder);
    presetSlots.disabled = true;
    presetLoad.disabled = true;
    return;
  }

  presetSlots.replaceChildren(
    ...names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      return option;
    }),
  );
  presetSlots.disabled = false;
  presetLoad.disabled = false;
}

presetLoad.addEventListener('click', () => {
  const patch = factory.get(presetSlots.value);
  if (!patch) {
    say('unavailable');
    return;
  }
  applySnapshot(patch);
  say('loaded');
});

// Disabled until the fetch lands, so the button cannot be pressed with nothing
// behind it. The instrument is already playable meanwhile -- it boots on the schema
// defaults, which is exactly what the shipped patch holds.
fillSlots([]);
presetSlots.replaceChildren(Object.assign(document.createElement('option'), {
  textContent: 'loading…',
  value: '',
}));

presets.loadFactoryPresets().then((list) => {
  factory.clear();
  for (const { name, patch } of list) factory.set(name, patch);
  fillSlots([...factory.keys()]);
});

// Console handle. Module bindings are not reachable from the devtools console, and
// poking a generative instrument by hand is genuinely useful:
//
//   __seq.store.set('bpm', 90)     moves the fader and the clock together
//
// It is also how a new factory patch is authored -- dial the instrument in, then
// paste the output into presets/factory.json as another entry:
//
//   __seq.presets.toJSON(__seq.store.snapshot(__seq.rng.seed))
/** @type {any} */ (window).__seq = {
  bus, store, tracks, rng, audio, scheduler, presets, applySnapshot, modulation,
};
