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
        │   ├─ stepDivision.js←   Note values + triplet/dotted
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
            ├─ icons.js        ←   Line-art SVG glyphs
            ├─ BiasSpreadSlider.js
            ├─ DragNumber.js
            ├─ Dropdown.js
            ├─ FillIconControl.js
            ├─ GlideControl.js
            ├─ LogicOpControl.js
            ├─ StepDivisionControl.js
            ├─ TrigLoopControl.js
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

## Step division

One tempo, several timelines. The bar length is global, but each track sets its own
step duration as a note value — `1/1` to `1/32`, with triplet (`T`) and dotted (`D`) —
so two tracks can run at different speeds against the same clock:

```
barSeconds   = 240 / bpm                        (4/4)
stepDuration = barSeconds / stepDivision * modFactor   straight 1 · triplet ⅔ · dotted 1.5
```

The division is stored as the note's **denominator**, which makes a larger number a
shorter step — so the list's numeric order matches "drag up for faster". The default `1/16`
works out to `60 / (bpm × 4)`, exactly the value the step duration was hard-wired to
before this control existed.

The division applies to **one step**, not the cycle, so changing `Steps` lengthens or
shortens the cycle while the pulse stays put. A 5-step pattern is still five 16ths
phasing against the bar.

`T` and `D` drive a single tri-state `stepMod` rather than a flag each. Triplet is ×⅔
and dotted is ×1.5, so both together would be ×1 — a state that looks meaningful and
sounds like neither. One value makes it unrepresentable rather than merely discouraged.

Each track carries its own accumulator in the Scheduler, so a slow track simply emits
fewer steps per lookahead window than a fast one.

## Rhythm controls

The rhythm row under the ring is glyphs rather than sliders, because none of these four
parameters is a magnitude worth reading to two decimals:

```
    ⟩         ⚄         ⟳    8       ⤬
   OR        PROB      LOOP  LEN     PERM
```

| Glyph | Parameter | Gesture |
|---|---|---|
| Logic gate | `logicOp` | click cycles OR → AND → XOR → NAND |
| Die | `probability` | drag up to fill; how full it is *is* the value |
| Loop arrows | `trigLoop` + `trigLoopLength` | click captures the loop, drag the number for its length |
| Crossed arrows | `trigPerm` | drag up to fill, like the die |

**The logic operator cycles rather than slides.** Four named operators are a choice, not
a quantity, and a 1..4 slider asks the hand to treat a category as a magnitude. The
schematic symbol says which control it is; the caption says what it is set to, because at
24px the differences that matter — XOR's second arc, NAND's bubble — are as small as they
are on a real schematic. `nextLogicOp` lives in [`logic.js`](src/sequencer/logic.js) next
to the table it walks: the operator ids are positional and patches store them, so a
reordering would silently remap every saved patch.

**The fills are two copies of one glyph.** The lower is dim, the upper is accent-coloured
and clipped to `inset(var(--fill-top) 0 0 0)`, with JS setting that custom property from
the value. Cheaper than an SVG `<clipPath>`, which would need a document-unique id per
instance, and it leaves the level as a plain percentage a test can read back. Both glyphs
are drawn symmetric about the horizontal axis so a bottom-up fill reads as a level rather
than as a smear. The clip is deliberately untransitioned — during a drag it has to track
the pointer, and an eased clip would lag behind the hand.

**Permutation dims while the loop is off.** Its value is scaled by the loop's factorial,
so with nothing captured it has no effect at all. Dimming says so without disabling it:
the value is kept and starts mattering the moment the loop comes on. That coupling is why
one control owns all three loop parameters — it is internal state, not a special case in
the wiring.

Gestures match [`DragNumber`](src/ui/DragNumber.js) exactly, sharing its `FULL_RANGE_PX`
and `FINE_DIVISOR` rather than restating them: drag for coarse, shift-drag eight times
finer, wheel by one step, arrows and `Home`/`End`, double-click back to the default. A
press without movement changes nothing, so a glyph can be clicked to focus it.

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

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) publishes to GitHub
Pages whenever a release is published — not on every push to `master`, so the site
only moves when that is a deliberate act — or on demand from the Actions tab for a
redeploy with no new release behind it. It runs the test suite and the type-check
first, then stages only `index.html`, `src/`, `styles/` and
`presets/` into the published artifact — an allow-list, so a new file dropped at the
repo root later is private by default rather than needing to be remembered as another
exclusion. `test/`, `types/`, `jsconfig.json` and `package.json` are never copied in,
which keeps them off the published site; that is not the same as private — in a
public repo they are still readable on GitHub, which is where they belong.

This deploys through Actions rather than the classic Jekyll build, on purpose:
several source files carry `{{` inside JSDoc typedefs (e.g.
`@typedef {{ name: string }}`), which Jekyll's Liquid engine would try to parse as a
template expression and corrupt. An Actions deployment uploads the artifact as-is and
never runs Jekyll, so that risk does not apply here.

One-time setup the workflow depends on: **Settings → Pages → Source → GitHub
Actions** (not "Deploy from a branch"). Every asset reference in the app is
document-relative, so the site works unchanged under a project subpath like
`/WebGenerativeSequencer/`.

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
| `src/ui/` | Canvas GUI, custom controls (sliders, drag-numbers, icon controls) |
| `presets/` | Factory patches, fetched at startup |
| `test/` | Node.js native test suite |
| `styles/` | Application CSS |

## Run

```bash
npm run serve    # Python HTTP server on port 8080
```

## Test

```bash
npm test         # Node native test runner, 141 tests, no dependencies
```

The custom controls need a DOM, so they are checked by mounted pages rather than in Node.
Serve the project root and open `/test/browser/trigger-controls-check.html` (the rhythm
glyphs) or `/test/browser/glide-control-check.html`; each prints its results and stops on
`ALL CHECKS DONE`.

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
