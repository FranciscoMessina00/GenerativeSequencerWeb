import js from '@eslint/js';

/**
 * Flat config, dev-tooling only -- not a committed dependency (`npm install
 * --no-save eslint@9` gets it, the same ad-hoc pattern `npm run typecheck`'s own
 * header comment already documents for TypeScript). Run with `npm run lint`.
 *
 * `eslint:recommended` plus a short list of rules `jsconfig.json`'s `checkJs`
 * doesn't already catch (`eqeqeq`, `no-var`, `no-undef`, `no-unused-vars`).
 * Deliberately no Prettier/pure-formatting rules -- the codebase is already
 * hand-consistent, and a reformat-only diff has no expressed pain point; that is
 * a separate decision to make explicitly later if ever wanted.
 *
 * Globals are scoped per layer rather than declared once for everything, so
 * `no-undef` runs at full strength where it can: the sequencer's generators, the
 * DSP model files (modalModel.js, percussionModel.js, lfo.js, distributions.js,
 * etc.) and most of `core` touch no browser or Node global at all, and inherit
 * the base config untouched. `console` is the one exception given its own global
 * below -- it is genuinely available in every environment this code runs in
 * (browser and the Node test runner alike), so scoping it per-layer would only
 * add noise for no real strictness gained.
 */
export default [
  {
    // `.mjs` too -- scripts/check-browser-pages.mjs is a plain Node script, not
    // part of the src/**/*.js|test/**/*.js layout the rest of this config assumes,
    // but it still gets the same base rules and its own globals override below.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      // Interface-declaring stub parameters (e.g. an abstract method's documented
      // signature that no base-class body uses) are named with a leading `_` --
      // the same convention the worklets already use for an unused `process()`
      // argument, e.g. modal-processor.js's `process(_inputs, outputs)`.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The DOM-facing layer: controls, the bootstrap, and the top-level src/audio/
    // files that talk to the Web Audio API directly (AudioEngine, TrackVoice,
    // instruments.js) -- as opposed to the pure DSP models under audio/modal/ and
    // audio/percussion/, or the worklets, both covered by their own overrides below.
    files: ['src/ui/**/*.js', 'src/main.js', 'src/audio/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        Worker: 'readonly',
        AudioContext: 'readonly',
        AudioWorkletNode: 'readonly',
        ResizeObserver: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        PointerEvent: 'readonly',
        devicePixelRatio: 'readonly',
        getComputedStyle: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        prompt: 'readonly',
      },
    },
  },
  {
    // The Worker/Blob-URL machinery Ticker.js builds its background-safe timer
    // from -- see that file's own header for why. The rest of sequencer/ (the
    // scheduler, the generators, HistoryBuffer) is globals-free, same as core.
    files: ['src/sequencer/Ticker.js'],
    languageOptions: {
      globals: {
        Blob: 'readonly',
        URL: 'readonly',
        Worker: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    // The one file in core/ that reaches past pure state/logic: it fetches the
    // factory patch file. The rest of core/ (paramSchema, numberUtils, ParamStore,
    // rng) is globals-free.
    files: ['src/core/presets.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
      },
    },
  },
  {
    // AudioWorkletGlobalScope: self-contained by convention (no imports, no
    // module loader in that scope), and its own small set of globals -- see the
    // header comment each of these 4 files carries.
    files: ['src/audio/worklets/*.js'],
    languageOptions: {
      globals: {
        sampleRate: 'readonly',
        currentFrame: 'readonly',
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
      },
    },
  },
  {
    // The Playwright driver script for test/browser/*-check.html: a Node process
    // (`process`, `URL` for resolving paths off `import.meta.url`) that also
    // hands Playwright small functions to run *inside* the headless page --
    // `document` appears in one of those, evaluated in the browser context
    // Playwright injects it into, not in this file's own Node realm, but ESLint
    // reads the source text either way, so it needs declaring here too.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        URL: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    // Node's test runner, always reached through explicit `node:test`/
    // `node:assert` imports (no ambient describe/it/process globals) -- except
    // `URL`, used by a few tests to resolve a path relative to the test file
    // itself (`new URL('../foo', import.meta.url)`), which is a genuine Node
    // global these files never import.
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        URL: 'readonly',
      },
    },
  },
];
