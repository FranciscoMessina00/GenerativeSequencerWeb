import { EventBus } from './core/EventBus.js';
import { Rng } from './core/rng.js';
import { paramSpec } from './core/paramSchema.js';
import { ParamStore, TRACK_COUNT } from './core/ParamStore.js';
import { applyBootDefaults } from './core/bootDefaults.js';
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
import { TrackTabs } from './ui/TrackTabs.js';
import { InstrumentPanel } from './ui/InstrumentPanel.js';
import { INSTRUMENT_GROUPS } from './audio/instruments.js';
import { InfoBar } from './ui/InfoBar.js';
import { applyPalette, paletteFor } from './ui/palette.js';
import { Modulation } from './modulation/Modulation.js';
import { MOD_TARGETS } from './modulation/modTargets.js';
import { modSweepRange } from './modulation/modRange.js';
import { diceIcon } from './ui/icons.js';
import { SCALES } from './sequencer/scales.js';

/**
 * Bootstrap. The only module that knows about all the others -- everything
 * downstream talks over the bus.
 */

/**
 * Track 0's seed on a cold boot; the rest count up from it, so a fresh page is
 * reproducible and the four tracks still differ. Any saved patch overrides all
 * four -- see applySnapshot.
 */
const BASE_SEED = 424242;

const bus = new EventBus();
const audio = new AudioEngine(bus, { trackCount: TRACK_COUNT });

// One Rng per track, never one shared: the generators draw from it every step, so
// a shared stream would couple four independent random walks into one.
const rngs = Array.from({ length: TRACK_COUNT }, (_, i) => new Rng(BASE_SEED + i));
const tracks = rngs.map((rng, i) => new Track(i, rng));

// Which track the single on-screen control surface is bound to right now.
//
// One surface re-bound rather than four built and hidden: that keeps the DOM ids
// unique, keeps one canvas per view, and keeps the setter maps below keyed by
// param alone. selectTrack() is what moves it.
//
// Two mechanisms carry it into the controls, and both read it late rather than
// copying it: widgets that own a trackId get setTrackId() called on them, and the
// leaf controls (Dropdown, LogicOpControl, FillIconControl) emit through closures
// defined here, which see whatever this holds at the moment of the gesture.
let visibleTrack = 0;

const scheduler = new Scheduler({
  bus,
  getCurrentTime: () => audio.currentTime,
  tracks,
});

// Assigned below, once the canvas has been measured. Declared here so the store's
// routing closure can reference it without risking a temporal-dead-zone throw.
/** @type {EuclidView | undefined} */
let view;

// Likewise: the step handler feeds the tab strip's progress bars, and the strip is
// built after the controls it switches between.
/** @type {import('./ui/TrackTabs.js').TrackTabs | undefined} */
let tabs;

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
  else if (spec.target === 'voice') audio.setVoiceParam(key, value, trackId);
  else if (spec.target === 'transport') scheduler.setParam(key, value);
  else if (spec.target === 'master') audio.setMasterParam(key, value);
};

// Assigned below, once the store exists for them to read base values from. One per
// track: the LFO's own settings are per-track, and so is everything it can point
// at, so two tracks sweeping the same param no longer fight over one value.
/** @type {import('./modulation/Modulation.js').Modulation[]} */
let modulations = [];

// The one authoritative copy of every parameter. It owns writing to the engines and
// announces each committed value as `param:changed`, which is what lets a preset or
// a MIDI message move the controls.
const store = new ParamStore({
  bus,
  trackCount: tracks.length,
  route: (key, value, trackId, spec) => {
    if (spec.target === 'modulation') {
      // Not an engine: these configure one track's LFO.
      modulations[trackId]?.setParam(key, value);
      return;
    }
    writeToEngine(key, value, trackId, spec);

    // The ring shows one track at a time, so only that track's changes are worth
    // repainting for. Without this guard a hidden track's edit would redraw the
    // visible ring with the wrong pattern.
    if (spec.target === 'track' && trackId === visibleTrack) {
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

// The LFOs, one per track. Each reads base values out of the store and writes
// modulated ones straight to the engines, so the store keeps owning what the user
// actually set. Each is advanced by its OWN track's steps below, so its phase rate
// follows that track's step division rather than whichever tab happens to be open.
modulations = tracks.map((track) => new Modulation({
  store,
  write: writeToEngine,
  getBarSeconds: () => scheduler.barDuration,
  trackId: track.trackId,
}));

// The parameters that define the Euclidean pattern live inside the ring, since they are
// what the ring is a picture of. Division joins them because it sets how fast the playhead
// crosses those sectors. Order fills the 2x2 grid: Steps | Pulses, then Rotation | Division.
const EUCLID_KEYS = ['steps', 'pulses', 'rotation'];
const HUB_KEYS = [...EUCLID_KEYS, 'stepDivision', 'stepMod'];

const hubEl = document.getElementById('hub');
const ui = new UIController({ bus });
ui.renderDragNumbers(hubEl, EUCLID_KEYS);

// The two global params, in the header beside Play. Same widget the hub uses -- a
// tempo and an output level are magnitudes you nudge, not settings you pick.
const TRANSPORT_KEYS = ['bpm', 'masterGain'];
ui.renderDragNumbers(document.getElementById('transport-nums'), TRANSPORT_KEYS);

// Division is a drag-number plus two letter toggles, so it is built here rather than by
// renderDragNumbers, and appended as the grid's fourth cell.
const stepDivisionControl = new StepDivisionControl({
  bus,
  trackId: visibleTrack,
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
  onInput: (value) => bus.emit('param:change', { trackId: visibleTrack, key: 'logicOp', value }),
});
const probabilityControl = new FillIconControl({
  spec: paramSpec('probability'),
  buildIcon: diceIcon,
  label: 'Prob',
  onInput: (value) => bus.emit('param:change', { trackId: visibleTrack, key: 'probability', value }),
});
const trigLoopControl = new TrigLoopControl({
  bus,
  trackId: visibleTrack,
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
    trackId: visibleTrack,
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
  trackId: visibleTrack,
  enabledSpec: paramSpec('noteLoop'),
  lengthSpec: paramSpec('noteLoopLength'),
  permSpec: paramSpec('notePerm'),
});
// Velocity has no permutation param, so its loop is capture + length only --
// TrigLoopControl omits the permutation glyph whenever permSpec isn't passed.
const velLoopControl = new TrigLoopControl({
  bus,
  trackId: visibleTrack,
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
  onInput: (value) => bus.emit('param:change', { trackId: visibleTrack, key: 'scale', value }),
});
const glideControl = new GlideControl({
  bus,
  trackId: visibleTrack,
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
  trackId: visibleTrack,
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
//
// Transport is absent because its two params moved to the header, Mixer because its
// two are drawn on the tab strip, and Instrument because the selector draws its one --
// so none of the three renders as sliders here.
//
// All four instrument groups are rendered, and InstrumentPanel hides every one but the
// visible track's. They sit together in the middle so that switching instrument moves
// nothing else on the page.
const CONTROL_GROUPS = [
  'Pitch', 'Velocity', 'Modulation', ...INSTRUMENT_GROUPS, 'Granulator',
];

ui.renderGroups(
  document.getElementById('controls'),
  CONTROL_GROUPS,
  {
    skip: [...sliderSkipKeys, ...NOTE_LOOP_KEYS, ...VEL_LOOP_KEYS, ...LFO_KEYS, 'scale', 'glideAmount', 'glideMode'],
    prepend: sliderPrepend,
    headingExtra: { Modulation: lfoPanel.targetRow },
  },
);

// Which of the four instrument panels is showing, and the selector that changes it.
// Built after renderGroups, since it needs handles on the sections that call created.
const instrumentPanel = new InstrumentPanel({
  spec: paramSpec('instrument'),
  sections: ui.sections,
  headings: ui.headings,
  onInput: (value) => bus.emit('param:change', { trackId: visibleTrack, key: 'instrument', value }),
});

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
view.setPattern(tracks[visibleTrack].getPattern());
view.setLoopActive(tracks[visibleTrack].params.trigLoop);

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
// A leaf like the scale dropdown, and registering it here is also what swaps the
// panel: its setValue shows the matching group, so a preset load or an LFO-free
// param:changed moves the panel without anything else being wired up.
registerLeaf(instrumentPanel);

/** Every widget that owns a trackId, so selectTrack can re-point all of them. */
const trackBoundWidgets = [
  ui, glideControl, stepDivisionControl, trigLoopControl,
  noteLoopControl, velLoopControl, lfoPanel,
  ...Object.values(biasSpreadSliders),
];

// The ring's stepIndex from the step *before* this one, so a wrap (a new
// revolution starting) can be detected once and the loop's whole next revolution
// projected in a single shot, rather than the ring updating one position at a time
// as the playhead happens to pass each one.
//
// It tracks the visible track only. Letting every track write to it would make a
// "wrap" mean "some other track's index happened to be lower", which fires the
// projection at the wrong moments and misses the real ones.
let lastRingStepIndex = -1;

/**
 * Show a different track.
 *
 * The controls are re-pointed and then filled from the store directly rather than
 * over the bus: `param:changed` would send every value back through routing to the
 * engines, which is both pointless (they already hold these values) and wrong for
 * anything the LFO is currently driving, since routing would overwrite the
 * modulated value with the base one.
 */
function selectTrack(next) {
  if (next === visibleTrack || !tracks[next]) return;
  visibleTrack = next;

  for (const widget of trackBoundWidgets) widget.setTrackId(next);
  for (const [key, value] of Object.entries(store.trackValues[next])) {
    controlSetters.get(key)?.(value);
  }

  const track = tracks[next];
  view.setPattern(track.getPattern());
  view.setLoopActive(track.params.trigLoop);
  // The marks the ring holds describe the track it was showing a moment ago.
  view.clearPlayhead();
  lastRingStepIndex = -1;
  legendRandomEl.hidden = !track.params.trigLoop;
  if (track.params.trigLoop) {
    view.setLoopSnapshot(track.getTrigLoopWindow(track.getPattern().length));
  }

  // Assign mode is a question about one track's LFO, so it cannot survive the
  // track changing underneath it.
  setAssignMode(false);
  renderModRange();
  ui.clearReadout();

  // The page's colours. One assignment retints the whole stylesheet; the canvases
  // are handed the derived object, since reading custom properties back out in a
  // draw loop would force layout on every frame.
  const palette = applyPalette(next);
  view.setPalette(palette);
  lfoPanel.view.setPalette(palette);
  tabs?.setActive(next);
}

// A control's gesture is only a *request*; the store decides what actually happens.
bus.on('param:change', ({ trackId, key, value }) => {
  store.set(key, value, trackId);
});

// ...and the committed value comes back here to move the controls. A control's own
// change lands as an idempotent redraw, because setValue never re-emits and the
// store already dropped the value if nothing changed.
bus.on('param:changed', ({ trackId, key, value, global }) => {
  if (!global && trackId !== visibleTrack) return;
  controlSetters.get(key)?.(value);
});

bus.on('step', (step) => {
  // Every track sounds, on its own chain -- the engine dispatches on step.trackId.
  audio.noteOn(step);

  // The ring and the readout show one track, so only that track's steps reach them.
  if (step.trackId === visibleTrack) {
    const wrapped = step.stepIndex < lastRingStepIndex;
    lastRingStepIndex = step.stepIndex;
    const track = tracks[visibleTrack];
    view.enqueue(
      step,
      wrapped ? track.getTrigLoopWindow(track.getPattern().length) : undefined,
    );
    ui.pushStep(step);
  }

  // Every track's tab shows its own progress, so every track's steps go here.
  tabs?.enqueue(step, tracks[step.trackId].getPattern().length);

  // Each LFO is advanced by its own track: sampled here rather than on an
  // animation frame because this path runs off the scheduler's Worker timer, so it
  // keeps modulating in a hidden browser tab where a requestAnimationFrame loop
  // would stall while the sequence played on.
  modulations[step.trackId]?.onStep(step);
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
  const key = MOD_TARGETS[store.get('lfoTarget', visibleTrack)] ?? null;
  if (modRangeKey && modRangeKey !== key) modRangeSetters.get(modRangeKey)?.(null);
  modRangeKey = key;
  if (!key) return;
  const amount = store.get('lfoAmount', visibleTrack);
  const base = Number(store.get(key, visibleTrack));
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
    trackId: visibleTrack,
    key: 'lfoTarget',
    value: MOD_TARGETS.indexOf(key),
  });
  setAssignMode(false);
}, true);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && assigning) setAssignMode(false);
});

// Only the visible track's sweep is on screen, so a hidden track's LFO moving is
// not worth a redraw -- and every one of these keys is per-track now, so the
// trackId is never the global 0 stand-in.
bus.on('param:changed', ({ trackId, key }) => {
  if (trackId !== visibleTrack) return;
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
  tabs?.setRunning(running);
  // Resets each LFO's phase on start, so a synced one is locked to the bar; on stop
  // each hands the parameter it was driving back to the value the store holds. All
  // four, not just the visible one -- an unattended LFO would otherwise leave its
  // target stuck at whatever it happened to be sweeping.
  for (const modulation of modulations) modulation.setRunning(running);
  playButton.textContent = running ? 'Stop' : 'Play';
  playButton.classList.toggle('active', running);
  if (!running) {
    // Cut the ringing voices rather than letting modal tails hang for seconds
    // after the transport stops -- every track has its own pool.
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
// The visible track's, since that is the one whose controls are on screen -- and it
// sounds through that track's own chain, so a muted track plucks silently.
document.getElementById('pluck').addEventListener('click', async () => {
  await ensureAudio();
  const step = tracks[visibleTrack].step(scheduler.stepDurationFor(visibleTrack));
  audio.noteOn({ ...step, triggered: true, audioTime: audio.currentTime + 0.02 });
  ui.pushStep({ ...step, triggered: true });
});

// Every track, not just the visible one: the button sits in the global transport
// next to Play, so it means "shuffle the whole instrument". The status names the
// visible track's new seed, since one line cannot show four.
document.getElementById('reseed').addEventListener('click', () => {
  for (const rng of rngs) rng.setSeed((Math.random() * 0x7fffffff) | 0);
  statusEl.textContent = `reseeded (${rngs[visibleTrack].seed})`;
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
 * Apply a patch, restoring its seeds too.
 *
 * Order matters: reseed before the ring is refreshed, so what the display shows and
 * what the generators will produce come from the same seeds.
 *
 * A version-1 patch carries one seed for its one track; the tracks it says nothing
 * about keep the seed they had, since the store has already reset their params and
 * a fresh seed would add a second unrelated change.
 */
function applySnapshot(snapshot) {
  const seeds = store.load(snapshot);
  seeds?.forEach((seed, trackId) => {
    if (typeof seed === 'number') rngs[trackId]?.setSeed(seed);
  });
  view.setPattern(tracks[visibleTrack].getPattern());
  view.setLoopActive(tracks[visibleTrack].params.trigLoop);
  view.clearPlayhead();
  return seeds;
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

// ---------------------------------------------------------------------------
// Track pages
// ---------------------------------------------------------------------------

// Built last, because switching pages reaches everything above it. The strip owns
// mute and level for all four tracks at once, so unlike every other widget it is
// fed every track's changes rather than only the visible one's.
tabs = new TrackTabs({
  bus,
  trackCount: tracks.length,
  muteSpec: paramSpec('mute'),
  levelSpec: paramSpec('level'),
  getAudioTime: () => audio.currentTime,
  onSelect: (trackId) => selectTrack(trackId),
  active: visibleTrack,
});
document.getElementById('tabs-row').appendChild(tabs.element);

bus.on('param:changed', ({ trackId, key, value }) => {
  tabs.setValue(key, value, trackId);
});

// The starting page's colours. selectTrack does this on every later switch, but it
// returns early for the page already showing, so the first one happens here.
const bootPalette = applyPalette(visibleTrack);
view.setPalette(bootPalette);
lfoPanel.view.setPalette(bootPalette);

// The defaults that differ between tracks -- see core/bootDefaults.js. Applied after
// the strip and the panels exist, since they announce like any other committed value
// and the controls have to be there to hear them.
applyBootDefaults(store);

// Console handle. Module bindings are not reachable from the devtools console, and
// poking a generative instrument by hand is genuinely useful:
//
//   __seq.store.set('bpm', 90)          moves the fader and the clock together
//   __seq.store.set('steps', 9, 2)      edits track 3 without switching to it
//   __seq.selectTrack(1)                switches page, exactly as the tab does
//
// It is also how a new factory patch is authored -- dial the instrument in, then
// paste the output into presets/factory.json as another entry:
//
//   __seq.presets.toJSON(__seq.store.snapshot(__seq.rngs.map((r) => r.seed)))
/** @type {any} */ (window).__seq = {
  bus, store, tracks, rngs, audio, scheduler, presets, applySnapshot, modulations,
  selectTrack, tabs, paletteFor, get visibleTrack() { return visibleTrack; },
};
