# Web Generative Sequencer

A generative Euclidean sequencer with a modal string voice, ported to the **Web Audio API** from the CMLS Stefano Lavori SuperCollider/Processing project.

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
            ├─ Knob.js
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

All layers communicate exclusively through **EventBus** — the sequencer never touches the audio engine, and neither has any direct DOM access.

## Structure

| Directory | Purpose |
|-----------|---------|
| `src/core/` | Event bus, PRNG, parameter schema |
| `src/sequencer/` | Clock scheduling, track generators, rhythm & pitch logic |
| `src/audio/` | AudioContext management, modal string model, AudioWorklets |
| `src/ui/` | Canvas GUI, custom controls (sliders, knobs, dropdowns) |
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
