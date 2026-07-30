import { EventBus } from './core/EventBus.js';
import { Rng } from './core/rng.js';
import { paramSpec } from './core/paramSchema.js';
import { Track } from './sequencer/Track.js';
import { Scheduler } from './sequencer/Scheduler.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { UIController } from './ui/UIController.js';
import { EuclidView } from './ui/EuclidView.js';

/**
 * Bootstrap. The only module that knows about all the others.
 *
 * Everything downstream communicates over the bus, so the sequencer has no
 * reference to the audio engine and neither has any reference to the DOM.
 */

const bus = new EventBus();
const rng = new Rng();
const audio = new AudioEngine(bus);

// Phase 1 is a single channel. `tracks` is already a list and every event is
// tagged with its trackId, so adding channels is additive.
const tracks = [new Track(0, rng)];

const scheduler = new Scheduler({
  bus,
  getCurrentTime: () => audio.currentTime,
  tracks,
});

const ui = new UIController({ bus, root: document.getElementById('controls') });
ui.build();
ui.attachReadout(document.getElementById('readout'));

const view = new EuclidView(
  document.getElementById('ring'),
  () => audio.currentTime,
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
