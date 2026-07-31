import { EventBus } from './core/EventBus.js';
import { Rng } from './core/rng.js';
import { PARAM_GROUPS, paramSpec } from './core/paramSchema.js';
import { Track } from './sequencer/Track.js';
import { Scheduler } from './sequencer/Scheduler.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { UIController } from './ui/UIController.js';
import { EuclidView } from './ui/EuclidView.js';
import { BiasSpreadSlider } from './ui/BiasSpreadSlider.js';
import { Dropdown } from './ui/Dropdown.js';
import { GlideControl } from './ui/GlideControl.js';
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

const scheduler = new Scheduler({
  bus,
  getCurrentTime: () => audio.currentTime,
  tracks,
});

// The three parameters that define the Euclidean pattern live inside the ring, as
// drag-numbers, since they are what the ring is a picture of.
const EUCLID_KEYS = ['steps', 'pulses', 'rotation'];

const hubEl = document.getElementById('hub');
const ui = new UIController({ bus });
ui.renderDragNumbers(hubEl, EUCLID_KEYS);
// The rest of the rhythm controls sit under the ring; everything else goes in the
// side panel.
ui.renderGroups(document.getElementById('rhythm-controls'), ['Rhythm'], {
  skip: EUCLID_KEYS,
});
// Bias/spread pairs get one combined slider instead of two: the handle is the
// bias, the wheel adjusts spread.
const BIAS_SPREAD_AXES = {
  Pitch: { bias: 'noteBias', spread: 'noteSpread', title: 'Note' },
  Velocity: { bias: 'velBias', spread: 'velSpread', title: 'Velocity' },
  Modulation: { bias: 'modBias', spread: 'modSpread', title: 'Pluck Position' },
};
const sliderPrepend = {};
for (const [group, axes] of Object.entries(BIAS_SPREAD_AXES)) {
  const slider = new BiasSpreadSlider({
    bus,
    trackId: 0,
    biasSpec: paramSpec(axes.bias),
    spreadSpec: paramSpec(axes.spread),
    title: axes.title,
  });
  sliderPrepend[group] = slider.element;
}
const sliderSkipKeys = Object.values(BIAS_SPREAD_AXES).flatMap((a) => [a.bias, a.spread]);

// Scale and Glide share one row below the Note slider: Scale flexes to fill it,
// Glide sits fixed-width at the right.
const scaleDropdown = new Dropdown({
  spec: paramSpec('scale'),
  options: SCALES.map((s) => ({ value: s.id, label: s.name })),
  onInput: (value) => bus.emit('param:change', { trackId: 0, key: 'scale', value }),
});
const glideControl = new GlideControl({
  bus,
  trackId: 0,
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

const view = new EuclidView(
  document.getElementById('ring'),
  () => audio.currentTime,
  // Fit the hub overlay to the largest square that fits inside the hub circle,
  // so no control can spill past the sectors at any column width.
  ({ innerR }) => {
    const side = Math.max(60, (innerR * 2) / Math.SQRT2 - 8);
    hubEl.style.width = `${side}px`;
    hubEl.style.height = `${side}px`;
  },
);
view.setPattern(tracks[0].getPattern());

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

bus.on('param:change', ({ trackId, key, value }) => {
  const spec = paramSpec(key);
  if (!spec) return;

  if (spec.target === 'track') {
    tracks[trackId]?.setParam(key, value);
    // The ring reflects the Euclidean pattern, so refresh it when the pattern
    // parameters move.
    if (key === 'steps' || key === 'pulses' || key === 'rotation') {
      view.setPattern(tracks[trackId].getPattern());
    }
  } else if (spec.target === 'transport') {
    scheduler.setParam(key, value);
  } else if (spec.target === 'voice') {
    audio.setParam(key, value);
  }
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
  const step = tracks[0].step(scheduler.stepDuration);
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
