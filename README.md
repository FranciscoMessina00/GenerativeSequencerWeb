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
        │   ├─ paramSchema.js  ←   Declarative parameter definitions
        │   ├─ ParamStore.js   ←   Authoritative parameter state
        │   └─ presets.js      ←   Factory patch loading
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

## Parameter flow

`ParamStore` holds the only authoritative copy of every parameter and is the only
thing that writes to the engines. Two events keep that one-directional:

| Event | Meaning | Emitted by |
|---|---|---|
| `param:change` | a *request* to change a value | controls, presets, anything else |
| `param:changed` | the *committed* value, after normalising | the store, only |

Controls emit the first and subscribe to the second, applying it through a
`setValue()` that never re-emits — so a control's own gesture returns to it as an
idempotent redraw rather than a feedback loop, and a preset can move every control
on screen by doing nothing but writing to the store.

`target` sets scope: `track` params are per-track, `voice` and `transport` are
global.

## Patches

Patches are **read-only and ship with the instrument**. Nothing is written to the
browser — no `localStorage`, no cookies — so the sequencer behaves identically for
every visitor, on every origin it is served from, with no state to go stale.

The **Patch** control in the header picks one and loads it.

### Where they live

[`presets/factory.json`](presets/factory.json), committed to the repo and fetched
once at startup:

```json
{
  "version": 1,
  "presets": [
    { "name": "Default", "patch": { "version": 1, "seed": 424242, "global": {...}, "tracks": [{...}] } }
  ]
}
```

Adding a patch means appending to that array. No code change, no build step.

`Default` is generated from the schema defaults rather than typed by hand, and a
test asserts it still matches them — so changing a `def` in `paramSchema.js` without
regenerating fails the suite instead of silently shipping a stale patch.

### What a patch contains

Every parameter, scoped the way `target` scopes them, **plus the RNG seed**. The
seed is the part worth understanding: the generators are stochastic, so settings
alone restore the same *instrument* but a different *performance*. With the seed, a
patch replays note for note — which is why the RNG is seedable at all.

### Loading

`ParamStore.load()` writes each value into the store, the store announces each as
`param:changed`, and **every control on screen follows**. The preset code knows
nothing about the UI.

Values are re-normalised through the schema on the way in, so an out-of-range or
hand-edited patch gets clamped and snapped rather than reaching the audio engine;
unknown keys are ignored so older patches still load; and a malformed entry is
skipped rather than taking the rest of the set down with it. If the file is missing
entirely the dropdown reads `unavailable` and the instrument still plays, because it
boots on the same defaults the shipped patch holds.

### Authoring a new one

Dial the instrument in, then from the devtools console:

```js
__seq.presets.toJSON(__seq.store.snapshot(__seq.rng.seed))
```

and paste the result into `presets/factory.json` as another
`{ "name": "...", "patch": { ... } }` entry.

## Deploying

Static, so GitHub Pages serves the repo as-is — Settings → Pages → deploy from
branch, root. Every asset reference is document-relative, so it works unchanged
under a project subpath like `/WebGenerativeSequencer/`.

[`_config.yml`](_config.yml) keeps `test/`, `types/`, `jsconfig.json` and
`package.json` off the published site. That stops them being reachable at a URL; it
does not make them private — in a public repo they are still readable on GitHub,
which is where they belong. Read the comments in that file before adding
`.nojekyll`, which would disable the exclusion.

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
| `presets/` | Factory patches, fetched at startup |
| `test/` | Node.js native test suite |
| `styles/` | Application CSS |

## Run

```bash
npm run serve    # Python HTTP server on port 8080
```

## Test

```bash
npm test         # Node native test runner, 102 tests, no dependencies
```

## Types

`jsconfig.json` turns on `checkJs`, so an editor type-checks the JSDoc annotations
with nothing installed. For a command-line or CI gate:

```bash
npm i -D typescript && npm run typecheck
```

Nothing is ever emitted — this is checking, not building.

The worklets cannot run under Node, and a runtime error inside one is silent —
the node simply outputs zeros. `test/browser/selftest.html` therefore renders the
real graph through an `OfflineAudioContext` and inspects the samples, so DSP bugs
surface as numbers rather than as unexplained silence. Serve the project root and
open `/test/browser/selftest.html`.
