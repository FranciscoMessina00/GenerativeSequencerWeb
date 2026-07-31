import { EventBus } from './core/EventBus.js';
import { Rng } from './core/rng.js';
import { PARAM_GROUPS, paramSpec } from './core/paramSchema.js';
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

// The one authoritative copy of every parameter. It owns writing to the engines and
// announces each committed value as `param:changed`, which is what lets a preset or
// a MIDI message move the controls.
const store = new ParamStore({
  bus,
  trackCount: tracks.length,
  route: (key, value, trackId, spec) => {
    if (spec.target === 'track') {
      tracks[trackId]?.setParam(key, value);
      // The ring is a picture of the Euclidean pattern, so refresh it when the
      // pattern parameters move.
      if (key === 'steps' || key === 'pulses' || key === 'rotation') {
        view?.setPattern(tracks[trackId].getPattern());
      }
    } else if (spec.target === 'transport') {
      scheduler.setParam(key, value);
    } else if (spec.target === 'voice') {
      audio.setParam(key, value);
    }
  },
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
// The rest of the rhythm controls sit under the ring; everything else goes in the
// side panel.
ui.renderGroups(document.getElementById('rhythm-controls'), ['Rhythm'], {
  skip: HUB_KEYS,
});
// Bias/spread pairs get one combined slider instead of two: the handle is the
// bias, the wheel adjusts spread.
const BIAS_SPREAD_AXES = {
  Pitch: { bias: 'noteBias', spread: 'noteSpread', title: 'Note' },
  Velocity: { bias: 'velBias', spread: 'velSpread', title: 'Velocity' },
  Modulation: { bias: 'modBias', spread: 'modSpread', title: 'Pluck Position' },
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
pitchPrepend.append(sliderPrepend.Pitch, scaleRow);
sliderPrepend.Pitch = pitchPrepend;

ui.renderGroups(
  document.getElementById('controls'),
  PARAM_GROUPS.filter((g) => g !== 'Rhythm'),
  { skip: [...sliderSkipKeys, 'scale', 'glideAmount', 'glideMode'], prepend: sliderPrepend },
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

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// key -> how to reflect a committed value back onto its control.
//
// Leaf controls take just the value; multi-key controls take (key, value). Binding
// the key here keeps the dispatch below a single Map lookup rather than a chain of
// instanceof checks.
const controlSetters = new Map();
const registerKeyed = (widget) => {
  for (const key of widget.keys()) controlSetters.set(key, (v) => widget.setValue(key, v));
};
const registerLeaf = (widget) => {
  for (const key of widget.keys()) controlSetters.set(key, (v) => widget.setValue(v));
};

registerKeyed(ui);
registerKeyed(glideControl);
registerKeyed(stepDivisionControl);
for (const slider of Object.values(biasSpreadSliders)) registerKeyed(slider);
registerLeaf(scaleDropdown);

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

bus.on('step', (step) => {
  audio.noteOn(step);
  view.enqueue(step);
  ui.pushStep(step);
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const playButton = document.getElementById('play');
const statusEl = document.getElementById('status');

bus.on('transport:change', ({ running }) => {
  view.setRunning(running);
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
  bus, store, tracks, rng, audio, scheduler, presets, applySnapshot,
};
