# Web Generative Sequencer

A generative Euclidean sequencer driving a modal string voice, built on the
**Web Audio API**.

> Zero build step, plain ES modules, no dependencies.

## Architecture

The system is event-driven and fully decoupled through a synchronous pub/sub bus:

```
index.html
  └─ src/main.js              ← Wiring & bootstrap
        ├─ core/               ← Infrastructure
        │   ├─ EventBus.js     ←   Pub/sub event system
        │   ├─ rng.js          ←   Seedable PRNG (mulberry32)
        │   └─ paramSchema.js  ←   Declarative parameter definitions
        │
        ├─ sequencer/           ← Sequencing engine
        │   ├─ Scheduler.js    ←   Lookahead audio clock scheduler
        │   ├─ Ticker.js       ←   Web Worker timer (background-safe)
        │   ├─ Track.js        ←   One sequencer channel
        │   ├─ HistoryBuffer.js←   32-slot shift register
        │   ├─ euclid.js       ←   Euclidean rhythm generator
        │   ├─ logic.js        ←   OR/AND/XOR/NAND logic operators
        │   ├─ permute.js      ←   Lehmer code permutation
        │   ├─ scales.js       ←   10 musical scales + quantisation
        │   └─ generators/
        │       ├─ TriggerGenerator.js  ← Rhythm generation
        │       ├─ ValueGenerator.js    ← Note/velocity/modulation
        │       └─ distributions.js     ← Stochastic distributions
        │
        ├─ audio/               ← Audio rendering
        │   ├─ AudioEngine.js  ←   AudioContext & node graph
        │   ├─ modal/
        │   │   └─ modalModel.js ←  String physics (pure functions)
        │   └─ worklets/
        │       ├─ modal-processor.js    ← 16-voice resonator bank
        │       └─ granulator-processor.js ← Live granulator + limiter
        │
        └─ ui/                  ← User interface
            ├─ UIController.js ←   Builds control surface from schema
            ├─ EuclidView.js   ←   Canvas Euclidean ring display
            ├─ BiasSpreadSlider.js
            ├─ DragNumber.js
            ├─ Dropdown.js
            ├─ GlideControl.js
            ├─ numberUtils.js
            └─ noteNames.js
```

## Data Flow

```
Core → Sequencer → AudioEngine
  │                     │
  └────── EventBus ─────┘
         ↕     ↕
       UI   EuclidView
```

All layers communicate exclusively through **EventBus** — the sequencer never
touches the audio engine, and neither has any direct DOM access.

The scheduler decides each step ~100 ms ahead of the audio clock and stamps it
with an explicit `audioTime`, so timer jitter shifts *when a note is decided*,
never *when it sounds*.

## Physical model

The string voice is additive-modal: one two-pole resonator per mode, struck by a
shaped impulse. Mode tables are derived on the main thread
([`modalModel.js`](src/audio/modal/modalModel.js)) and handed to the worklet, so
the physics stays testable in Node and lives in exactly one place.

Mode frequencies follow the standard stiff-string relation

```
f_n = n · f1 · (1 + β + β² + n²π²β²/8)
```

where `β` is bending stiffness — the `Stiffness` control divided by 1000, so its
default of 11 gives `β = 0.011`, a realistic steel-string value. Higher modes are
stretched progressively sharp, which is what distinguishes a struck string from a
plain harmonic series.

Mode amplitudes for a string plucked at position `m` (a fraction of string
length, the `Pluck Position` control) follow

```
B_n = 2m² / (n²π²(m−1)) · sin(nπ/m)
```

so `m = 2` is a dead-centre pluck that nulls every even mode, and larger `m`
moves toward the bridge and brightens the spectrum.

Per-mode decay is `T60[n] = base · n^(−damping)`, giving the bright attack and
darker tail of a real string; `damping = 0` makes all modes decay together.

## Structure

| Directory | Purpose |
|-----------|---------|
| `src/core/` | Event bus, PRNG, parameter schema |
| `src/sequencer/` | Clock scheduling, track generators, rhythm & pitch logic |
| `src/audio/` | AudioContext management, modal string model, AudioWorklets |
| `src/ui/` | Canvas GUI, custom controls (sliders, drag-numbers, dropdowns) |
| `test/` | Node.js native test suite (7 test files) |
| `styles/` | Application CSS |

## Run

```bash
npm run serve    # Python HTTP server on port 8080
```

## Test

```bash
npm test         # Node native test runner
```

The worklets cannot run under Node, and a runtime error inside one is silent —
the node simply outputs zeros. `test/browser/selftest.html` therefore renders the
real graph through an `OfflineAudioContext` and inspects the samples, so DSP bugs
surface as numbers rather than as unexplained silence. Serve the project root and
open `/test/browser/selftest.html`.
