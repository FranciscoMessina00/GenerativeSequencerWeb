# Web Generative Sequencer

Four generative Euclidean sequencers driving a modal string and a drum kit off one
clock, built on the **Web Audio API**.

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
        │   ├─ AudioEngine.js  ←   AudioContext, master limiter & fader
        │   ├─ instruments.js  ←   The registry: id → processor, group, note-on
        │   ├─ TrackVoice.js   ←   One track's instrument + granulator + trim
        │   ├─ modal/
        │   │   └─ modalModel.js ←  String physics (pure functions)
        │   ├─ percussion/
        │   │   └─ percussionModel.js ← Kick/snare/hat mappings (pure)
        │   └─ worklets/
        │       ├─ modal-processor.js    ← 16-voice resonator bank
        │       ├─ percussion-processors.js ← Kick, snare and hi-hat
        │       ├─ granulator-processor.js ← Live granulator + limiter
        │       └─ master-clip-processor.js ← Limiter on the four-track sum
        │
        └─ ui/                  ← User interface
            ├─ UIController.js ←   Builds control surface from schema
            ├─ EuclidView.js   ←   Canvas Euclidean ring display
            ├─ TrackTabs.js    ←   The four track pages + playhead bars
            ├─ InstrumentPanel.js ← Which instrument's controls are showing
            ├─ palette.js      ←   One colour scheme per page
            ├─ playheadProgress.js ← Fractional playhead position (pure)
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

## Instruments

Each track plays one of four voices — a modal string, a kick, a snare, a hi-hat —
picked by the selector on the instrument panel's heading. Tracks start as a string
plus a drum kit, but any track can be any instrument.

[`src/audio/instruments.js`](src/audio/instruments.js) is the registry, and it is the
only place that knows an instrument's parts fit together: its name, the worklet
processor that sounds it, the control group that holds its parameters, and **how a
step becomes a note-on**. That last field is what makes the rest polymorphic —
`TrackVoice.noteOn` is a one-line router, so adding an instrument means adding an
entry and a processor rather than editing a switch in three places. Like
`MOD_TARGETS`, the array index is the stored value, so it is append-only.

Parameters are namespaced per instrument (`kickDecay`, `snareDecay`, `hatDecay`)
rather than shared. One schema row cannot hold two ranges: a string rings for
0.25–3 s and a hi-hat's decay tops out below a snare's floor. Namespacing also means
a track's bag keeps every instrument's settings, so switching voice and back loses
nothing.

Every `*NoiseColor` is a **tilt**, not a cutoff — 0 dark, 1 bright, 0.5 flat — so the
knob changes timbre rather than volume. That needed care: the two halves of a one-pole
split carry unequal noise power (the bright half keeps everything up to Nyquist), so
crossfading them with equal-power gains alone moved the level by 2.5×. Each half is
normalised to unit variance first, using the closed-form variance of white noise
through `y += a(x − y)`.

All three percussion voices are tuned by the step's note, so the Pitch panel does
something on every track — it sets the kick's sweep target, the snare's shell, and
where the hi-hat's colour hinges.

Only one instrument panel is on screen at a time. All four are rendered once and the
rest hidden, rather than rebuilt on each switch: `UIController` holds live references
to every control it built, so tearing panels down would invalidate them and take the
LFO's sweep indicators with them. The selector is one dropdown that *moves* onto the
visible heading, because there is only one thing being chosen.

## Tracks

Four tracks run in parallel off one clock. Each owns its own rhythm, pitch,
velocity, LFO, instrument and granulator; what they share is the tempo, the master
fader, and the moment they start.

The tab strip above the columns switches which track's controls are on screen —
and there is **one control surface, re-bound**, rather than four built and hidden.
That keeps the DOM ids unique, keeps one canvas per view, and keeps the setter maps
in `main.js` keyed by parameter alone. `selectTrack()` re-points every widget, fills
them from the store, and repaints the ring.

Since only one ring is visible, the three hidden tracks would otherwise give no sign
of running, so each tab carries a groove that fills across one revolution of *that*
track's pattern — interpolated within the step, because a bar that jumped one notch
per step reads as broken at slow divisions. It is gated on the audio clock, not on
the `step` event, for the same reason the ring is: steps are decided ~100 ms early.

Every track is **muted by default**. "A track is silent unless something says
otherwise" is what makes resetting a track to its defaults safe — four tracks
booting audible would stack four copies of the same Euclid pattern at four times the
level. `main.js` unmutes track 0 once, and a patch carries the rest.

### Colour

Each page has its own scheme, from [`src/ui/palette.js`](src/ui/palette.js). A page
authors three colours — `accent`, the `alt` its random-pulse ring half contrasts
against, and the `pulse` its Euclid half is filled with — and everything else
derives. `applyPalette()` writes `--accent` onto `<html>`; the stylesheet derives
every panel tint, border and active state from it with `color-mix()`, so one
assignment retints the whole page.

Two roles deliberately never vary: the green that means **it fired** / **the LFO
reaches this far**, and the neutral whites that mean **absence**. Four greens would
read as four different features, and absence has no hue.

The canvases are handed the derived palette object rather than reading custom
properties back out — `getComputedStyle` in a draw path forces layout every frame.

## Data Flow

```
Core → Sequencer → AudioEngine
  │                     │
  └────── EventBus ─────┘
         ↕     ↕      ↕
       UI  EuclidView  TrackTabs
```

Every event on the bus carries a `trackId`, so nothing downstream of `main.js` has to
know how many tracks exist.

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

Two orthogonal fields decide what happens to a value, and conflating them was worth
untangling:

| Field | Question | Values |
|---|---|---|
| `target` | **who** receives it | `track` · `voice` · `modulation` · `transport` · `master` |
| `scope` | **how many** copies exist | omitted = one per track · `global` = one, full stop |

Only two parameters are `global`: `bpm` and `masterGain`. Everything else — including
the LFO's own eight and the string and granulator settings — is per-track, which is
what lets four pages hold four instruments. `ParamStore` is the only reader of
`scope`; `Track`, `Scheduler`, `TrackVoice` and `Modulation` each take their defaults
from `defaultsFor(<their target>)` and never need to know how many of them exist.

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
    { "name": "Default", "patch": {
        "version": 2,
        "seeds": [424242, 424243, 424244, 424245],
        "global": { "bpm": 120, "masterGain": 0.8 },
        "tracks": [{...}, {...}, {...}, {...}]
    } }
  ]
}
```

Adding a patch means appending to that array. No code change, no build step.

`Default` is generated from the schema defaults rather than typed by hand, and a
test asserts it still matches them — so changing a `def` in `paramSchema.js` without
regenerating fails the suite instead of silently shipping a stale patch.

### What a patch contains

Every parameter, scoped the way `scope` scopes them, **plus one RNG seed per track**.
The seeds are the part worth understanding: the generators are stochastic, so
settings alone restore the same *instrument* but a different *performance*. With
them, a patch replays note for note — which is why the RNGs are seedable at all.

One seed per track and not one shared: the four tracks draw from their own streams,
because a shared `Rng` would couple four independent random walks into one. That
shape change is what took `SNAPSHOT_VERSION` to 2; a version-1 patch's single scalar
`seed` still loads, as track 0's.

A track the snapshot says nothing about is **reset to its defaults** rather than left
alone, so a patch fully determines what you hear instead of leaving three tracks
playing whatever was last dialled in. That is only safe because silence is the
default — an unmentioned track goes quiet rather than joining in.

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
__seq.presets.toJSON(__seq.store.snapshot(__seq.rngs.map((r) => r.seed)))
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

Each track gets its own chain, and they sum into one fader:

```
per track:  <instrument> → granulator-processor → trim (mute × level)
                                                    ↓
                       master-clip-processor → master gain → out
```

Only the source varies. The granulator stays in every chain because it costs nothing
when unused — `grainDryWet` defaults to −1, which that processor treats as a true
bypass — so a kick can be granulated without the graph changing.

One `AudioContext` for all four — four would mean four hardware clocks with no way to
align them. The master limiter is there because each granulator already bounds *its
own* output to about ±1, so four of them summing can reach ±3.2 and hard-clip the
device. It reuses the granulator's exact soft-knee curve rather than introducing a
character of its own, and that curve is **exact identity below 0.8** — which is where
one track at the default level peaks, so a single-track patch passes through
untouched. A `DynamicsCompressorNode` with a threshold low enough to catch four
tracks would have engaged on the plucks of one.

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
npm test         # Node native test runner, 262 tests, no dependencies
```

The custom controls need a DOM, so they are checked by mounted pages rather than in Node.
Serve the project root and open any of `/test/browser/*-check.html` — the rhythm glyphs,
the LFO panel, the track tabs, the ring's loop overlay, and so on. Each prints its
results and stops on `ALL CHECKS DONE`.

Two things in the multi-track work are deliberately Node-testable rather than
browser-only, because they are where the off-by-ones live:
[`playheadProgress.js`](src/ui/playheadProgress.js) (the tab bars' position) and
[`palette.js`](src/ui/palette.js) (every page's colours). `test/palette.test.js` also
reads `styles/main.css` back, so the base colours the canvases derive from cannot
drift from the ones the stylesheet declares, and a hand-written accent creeping back
into a rule fails the suite. `test/masterClip.test.js` lifts `softClip` out of both
worklets' source text and asserts the two copies are identical — the worklets cannot
import a shared module, so the duplication is checked rather than trusted.

## Types

`jsconfig.json` turns on `checkJs`, so an editor type-checks the JSDoc annotations
with nothing installed. For a command-line or CI gate:

```bash
npm i -D typescript && npm run typecheck
```

Nothing is ever emitted — this is checking, not building.

The worklets cannot run under Node, and a runtime error inside one is silent — the
node simply outputs zeros, and every UI check still passes. So DSP is checked by
rendering the real graph through an `OfflineAudioContext` and measuring the samples:
`/test/browser/percussion-render-check.html` for the drum voices and the string's
note-on path, and the older `/test/browser/selftest.html` for the string's physics.

Those two differ in one important way. Offline rendering runs as fast as the CPU
allows, so it can pass a note's start frame *before* the note has crossed to the audio
thread — which is why `selftest.html` carries a KNOWN UNRELIABLE banner and reports
zeros for voices that work. The percussion page fixes it with the handshake that
banner asks for: post the note, then `{type:'ping'}`, and wait for the `pong`. Port
order is guaranteed, so the pong proves the note was handled. Both `modal-processor`
and `percussion-processors` answer a ping; nothing in production sends one.
